/**
 * Shared post-generation COMPLETENESS pipeline — used by every artifact-producing
 * route (chat + agent) so the same guarantees apply EVERYWHERE, for ALL models
 * (free and paid) and ALL technologies:
 *
 *   1. Degraded-mode banner when the build landed on a free fallback model.
 *   2. Continue-until-complete loop: a single generation pass rarely finishes a
 *      large (40-50 module) app — the model stops after a chunk. So we keep
 *      running continuation passes while gaps remain AND the model is still
 *      making progress, up to a high ceiling. Gaps come from deterministic,
 *      model-free checks (whole missing component, uncovered plan items, truncated
 *      files, broken imports/entry) plus the LLM judge when reachable — so it works
 *      even on free-only mode where the judge can't run.
 *   3. Deterministic scaffold fallback: fill any still-missing stack-standard
 *      boilerplate so the app always boots.
 *
 * Fully fail-open: any error leaves whatever was already streamed untouched.
 */
import { streamText, stepCountIs, type UIMessageStreamWriter, type LanguageModel, type ToolSet } from "ai";
import {
  extractArtifacts,
  PLAN_REPAIR_SYSTEM,
  buildPlanRepairPrompt,
  detectComponentGaps,
  detectTruncatedArtifacts,
  detectArtifactFlags,
  type Artifact,
} from "./prompt-pipeline";
import { extractFilesFromMarkdown } from "./extract-files";
import { ensureScaffold } from "./scaffold";
import { verifyAgainstPlan, deterministicPlanGaps } from "@/lib/quality/plan-verify";
import { getLanguageFromPath } from "@/lib/utils";
import type { SamplingParams } from "./hyperparams";
import { saveGeneratedApp } from "./save-local";

/** Just the parts of a streamText result we need (text + steps). Loosely typed
 *  to accept any StreamTextResult without fighting its tool generics. */
interface GenResult {
  text: PromiseLike<string>;
  steps: PromiseLike<unknown>;
}
type StepsArg = Parameters<typeof extractArtifacts>[0];

export interface EnforceCompletenessOpts {
  writer: UIMessageStreamWriter;
  /** The completed main-generation result. */
  result: GenResult;
  /** The model + tool settings used for continuation passes. */
  model: LanguageModel;
  tools: ToolSet | undefined;
  maxSteps: number;
  /** Tuned sampling params for this candidate (temperature, penalties, token cap). */
  sampling: SamplingParams;
  /** The user's original request (drives the deterministic component gate). */
  requestText: string;
  /** The implementation plan, if one was generated (null on the agent route). */
  plan: string | null;
  /** Context the continuation passes build from (plan ?? magic brief ?? request). */
  planContext: string;
  /** Gateway for the LLM judge — pin to the funded build gateway. */
  build: { modelId?: string; provider?: string };
  canRepair: boolean;
  /** True when the winning candidate was a free fallback (drives the banner). */
  free?: boolean;
  freeModelLabel?: string;
}

/** Merge files from BOTH createFile tool calls and markdown code fences. */
async function gatherArtifacts(r: GenResult): Promise<Artifact[]> {
  const byPath = new Map<string, Artifact>();
  try {
    for (const f of extractFilesFromMarkdown(await r.text)) byPath.set(f.path, { path: f.path, content: f.content });
  } catch {
    /* ignore */
  }
  for (const f of extractArtifacts((await r.steps) as StepsArg)) byPath.set(f.path, f); // tool output wins
  return [...byPath.values()];
}

export async function enforceCompleteness(o: EnforceCompletenessOpts): Promise<void> {
  const { writer } = o;
  // Live status line (fixed id → updates in place) so the long, output-silent
  // post-generation passes (verify + continue-build) don't feel stuck. Cleared at
  // the end. Best-effort; the UI hides it when empty.
  const status = (text: string) => {
    try { writer.write({ type: "data-status", id: "build-status", data: { text } } as never); } catch { /* writer closed */ }
  };

  // 1. Degraded-mode banner (free fallback only).
  if (o.free) {
    writer.write({
      type: "data-degraded",
      id: "degraded-mode",
      data: {
        reason: "free-model-fallback",
        model: o.freeModelLabel,
        message: "Running on a free fallback model — all premium model accounts are out of credits, so this build may be slower and less complete. Add credits (Anthropic, Kilo Code, or OpenRouter) to restore full Claude-quality generation.",
      },
    } as never);
    console.log(`[completeness] degraded-mode: ran on free model ${o.freeModelLabel}`);
  }

  try {
    let artifacts = await gatherArtifacts(o.result);

    if (artifacts.length) {
      status("Reviewing the generated app for completeness…");
      let report = o.plan
        ? await verifyAgainstPlan({ plan: o.plan, files: artifacts, phase: "post-generation", build: o.build })
        : null;

      // Granular, mostly model-free gap set — keeps the loop going PAST the binary
      // component gate for large multi-module apps (the "stopped after the
      // frontend" failure), and works on free models without the LLM judge.
      const currentGaps = () => {
        const judge = report?.checked && !report.ok ? report.gaps : [];
        return [
          ...detectComponentGaps(artifacts, o.requestText),
          ...deterministicPlanGaps(o.plan, artifacts),
          ...detectTruncatedArtifacts(artifacts),
          ...detectArtifactFlags(artifacts),
          ...judge,
        ];
      };

      let gaps = currentGaps();
      const maxRounds = Number(process.env.PLAN_REPAIR_ROUNDS) || 12;
      const totalLen = () => artifacts.reduce((n, a) => n + (a.content?.length || 0), 0);
      let prevCount = artifacts.length;
      let prevLen = totalLen();
      for (let round = 0; o.canRepair && gaps.length > 0 && round < maxRounds; round++) {
        console.log(`[completeness] continue-build round=${round + 1}/${maxRounds} gaps=${gaps.length} files=${artifacts.length}`);
        status(`Completing the app — building the remaining parts (pass ${round + 1})…`);
        const fix = streamText({
          model: o.model,
          system: PLAN_REPAIR_SYSTEM,
          prompt: buildPlanRepairPrompt(artifacts, gaps, o.planContext),
          tools: o.tools,
          stopWhen: stepCountIs(o.maxSteps),
          ...o.sampling,
        });
        writer.merge(fix.toUIMessageStream({ sendStart: false, sendFinish: false }));
        await fix.text;
        const added = await gatherArtifacts(fix);
        if (added.length === 0) break; // model produced no files → stalled

        const byPath = new Map(artifacts.map((a) => [a.path, a]));
        for (const a of added) byPath.set(a.path, a);
        artifacts = [...byPath.values()];

        // Progress = new files OR more content; stop when a pass adds neither.
        const count = artifacts.length;
        const len = totalLen();
        if (count <= prevCount && len <= prevLen) {
          console.log("[completeness] no net progress, stopping");
          break;
        }
        prevCount = count;
        prevLen = len;

        if (o.plan) report = await verifyAgainstPlan({ plan: o.plan, files: artifacts, phase: "post-generation", build: o.build });
        gaps = currentGaps();
      }

      if (report?.checked) {
        writer.write({ type: "data-verification", id: "plan-verify", data: report } as never);
        console.log(`[completeness] plan-verify ok=${report.ok} score=${report.score.toFixed(2)} gaps=${report.gaps.length}`);
      }
    }

    // 3. Deterministic scaffold (always — even with 0 artifacts → a starter app).
    const scaffolded = ensureScaffold(artifacts, o.requestText);
    if (scaffolded.length) {
      const block = scaffolded
        .map((f) => "```" + (getLanguageFromPath(f.path) || "") + " " + f.path + "\n" + f.content + "\n```")
        .join("\n\n");
      const id = `scaffold-${Math.random().toString(36).slice(2)}`;
      writer.write({ type: "text-start", id } as never);
      writer.write({ type: "text-delta", id, delta: `\n\n**Scaffolded ${scaffolded.length} missing file(s)** so the app runs:\n\n${block}` } as never);
      writer.write({ type: "text-end", id } as never);
      console.log(`[completeness] scaffold: added ${scaffolded.length} files: ${scaffolded.map((f) => f.path).join(", ")}`);
    }

    // Persist the finished app to the local filesystem (~/ai-platform-apps by
    // default when running locally; GENERATED_APPS_DIR to override/enable). Best-
    // effort — never affects the response.
    const finalFiles = scaffolded.length ? [...artifacts, ...scaffolded] : artifacts;
    const savedTo = saveGeneratedApp(finalFiles);
    if (savedTo) console.log(`[completeness] saved app locally → ${savedTo}`);
  } catch {
    /* fail-open: leave whatever already streamed */
  } finally {
    status(""); // clear the live status line — the build is done
  }
}
