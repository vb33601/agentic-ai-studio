import { generateObject } from "ai";
import { z } from "zod";
import { getEnhancementModel } from "@/lib/ai/prompt-pipeline";

/**
 * Subsystem D — plan-based end-to-end verification.
 *
 * The prompt engine produces a short end-to-end implementation plan for every
 * build (see `generateImplementationPlan` in prompt-pipeline.ts). This module
 * is the single backbone that CHECKS the actual app against that plan at three
 * points in its lifecycle, so the same "is it really built and wired end-to-end?"
 * question is answered consistently everywhere:
 *
 *   1. post-generation — right after the model finishes, over the generated files,
 *   2. pre-deploy      — over the prepared files, before anything is shipped,
 *   3. post-deploy     — over the deployed files + the live URL's smoke/health
 *                        signals, to confirm the running app matches the plan.
 *
 * For each plan step it returns done / partial / missing with a short note, an
 * overall score, the concrete gaps, and a one-line summary.
 *
 * FAIL-OPEN by construction: no plan, no files, or any model error/timeout returns
 * a "checked:false, ok:true" report, so verification can never break a chat or
 * block a deploy that would otherwise have worked. The deterministic fallback
 * (keyword coverage) still produces a useful verdict when the model is unavailable.
 */

export type VerifyPhase = "post-generation" | "pre-deploy" | "post-deploy";
export type StepStatus = "done" | "partial" | "missing";

export interface PlanVerifyFile {
  path: string;
  content: string;
}

export interface PlanStepCheck {
  step: string;
  status: StepStatus;
  note?: string;
}

export interface PlanVerifyReport {
  /** True when nothing is missing (and, post-deploy, the live app is healthy). */
  ok: boolean;
  /** Fraction of plan steps satisfied (done=1, partial=0.5), 0..1. */
  score: number;
  phase: VerifyPhase;
  steps: PlanStepCheck[];
  /** Human-readable list of what's missing/partial or otherwise broken. */
  gaps: string[];
  summary: string;
  /** False when verification was skipped/fell open (no plan, no files, model down). */
  checked: boolean;
}

export interface VerifyAgainstPlanInput {
  plan: string | null | undefined;
  files: PlanVerifyFile[];
  phase: VerifyPhase;
  /** Post-deploy: the live URL the app was deployed to. */
  liveUrl?: string | null;
  /** Post-deploy: the frontend smoke verdict, if one was run. */
  smoke?: { ok: boolean; issues: string[] } | null;
  /** Post-deploy: the backend health verdict, if one was run. */
  health?: { healthy: boolean; status: number | null } | null;
  timeoutMs?: number;
  /**
   * Gateway to run the LLM judge on. Pin this to the funded build gateway (the
   * same anchor generation uses) so the verdict reliably surfaces — the default
   * enhancer chain can start on a free model that fails structured output and
   * silently falls open to the coarse heuristic (checked:false), which then
   * never triggers the verify→repair loop.
   */
  build?: { modelId?: string; provider?: string };
  /**
   * Injectable judge (defaults to the LLM-as-judge). Lets the engine run fully
   * offline in tests and degrade to the heuristic when it returns null.
   */
  judge?: JudgeFn;
}

export type JudgeFn = (
  steps: string[],
  files: PlanVerifyFile[],
  input: VerifyAgainstPlanInput,
) => Promise<{ steps: PlanStepCheck[]; summary: string } | null>;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("plan-verify timeout")), ms)),
  ]);
}

/** A report that means "we didn't (or couldn't) check" — always non-blocking. */
function skipped(phase: VerifyPhase, summary: string): PlanVerifyReport {
  return { ok: true, score: 1, phase, steps: [], gaps: [], summary, checked: false };
}

/** Split a plan (markdown bullet list) into individual, deduped step strings. */
export function parsePlanSteps(plan: string): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const raw of plan.split("\n")) {
    // Strip leading bullet/number markers ("- ", "* ", "1. ", "1) ").
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (line.length < 4) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(line);
  }
  return steps.slice(0, 12);
}

/** A compact, size-capped manifest of the file set for the judge prompt. */
function buildManifest(files: PlanVerifyFile[], budget = 14000): string {
  const paths = files.map((f) => f.path).join("\n");
  let out = `FILES (${files.length}):\n${paths}\n\n`;
  // Spend the remaining budget on a head of each non-trivial source file.
  const remaining = Math.max(0, budget - out.length);
  const perFile = Math.max(300, Math.floor(remaining / Math.max(files.length, 1)));
  const bodies: string[] = [];
  let used = 0;
  for (const f of files) {
    if (used >= remaining) break;
    const head = (f.content || "").slice(0, perFile);
    const block = `--- ${f.path} ---\n${head}${(f.content || "").length > head.length ? "\n…(truncated)" : ""}\n`;
    bodies.push(block);
    used += block.length;
  }
  out += bodies.join("\n");
  return out.slice(0, budget);
}

const STATUS = z.enum(["done", "partial", "missing"]);
const JudgeSchema = z.object({
  steps: z
    .array(
      z.object({
        index: z.number().int(),
        status: STATUS,
        note: z.string().max(200).optional(),
      }),
    )
    .max(12),
  summary: z.string().max(400),
});

function phaseFraming(phase: VerifyPhase, input: VerifyAgainstPlanInput): string {
  if (phase === "pre-deploy") {
    return "These are the files about to be DEPLOYED. Judge whether each plan step is fully implemented in the code so the app will work end-to-end once live.";
  }
  if (phase === "post-deploy") {
    const sig: string[] = [];
    if (input.liveUrl) sig.push(`Live URL: ${input.liveUrl}`);
    if (input.health) sig.push(`Backend health: ${input.health.healthy ? "healthy" : `NOT serving (HTTP ${input.health.status ?? "no response"})`}`);
    if (input.smoke) sig.push(`Frontend smoke: ${input.smoke.ok ? "passed" : `failed — ${input.smoke.issues.slice(0, 3).join("; ")}`}`);
    return (
      "The app has been DEPLOYED. Judge whether each plan step is implemented in the code AND consistent with the live runtime signals below. A step depending on a broken/unhealthy runtime is at most 'partial'.\n" +
      (sig.length ? `Runtime signals:\n${sig.map((s) => `- ${s}`).join("\n")}` : "")
    );
  }
  return "These files were just GENERATED. Judge whether each plan step is fully implemented so the app actually works as a whole (entry file present, screens/modules built, data/state wired, pieces connected).";
}

const JUDGE_SYSTEM = `You are a strict senior engineer verifying that a generated application matches its implementation plan.
For EACH numbered plan step, decide its status from the provided files:
- "done": fully implemented and wired so it works end-to-end.
- "partial": started or stubbed but incomplete (missing wiring, placeholder, only config, or referenced-but-absent files).
- "missing": no real evidence it was implemented.
Judge ONLY from the actual files — never assume code that isn't shown. Add a short note for anything not "done". Be concise and honest; do not inflate.`;

/** LLM-as-judge: score each plan step against the file set. */
const judgeWithModel: JudgeFn = async (steps, files, input) => {
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const { object } = await generateObject({
    // Run the judge on the funded build gateway when provided, so structured
    // output is reliable and the verdict actually surfaces (and can drive repair).
    model: getEnhancementModel(input.build),
    schema: JudgeSchema,
    temperature: 0,
    maxOutputTokens: 1200,
    system: JUDGE_SYSTEM,
    prompt:
      `${phaseFraming(input.phase, input)}\n\n` +
      `IMPLEMENTATION PLAN:\n${numbered}\n\n` +
      `${buildManifest(files)}\n\n` +
      `Return a status for every step by its number.`,
  });

  const byIndex = new Map<number, { status: StepStatus; note?: string }>();
  for (const s of object.steps) byIndex.set(s.index, { status: s.status, note: s.note });
  const checks: PlanStepCheck[] = steps.map((step, i) => {
    const got = byIndex.get(i + 1);
    return { step, status: got?.status ?? "partial", note: got?.note };
  });
  return { steps: checks, summary: object.summary };
};

/**
 * Deterministic fallback when the model is unavailable: a step counts as covered
 * when its salient keywords appear across the file paths/contents. Coarse but
 * never wrong about a totally-absent feature, and it never blocks.
 */
export function judgeHeuristic(steps: string[], files: PlanVerifyFile[]): PlanStepCheck[] {
  const haystack = files.map((f) => `${f.path}\n${f.content}`).join("\n").toLowerCase();
  const STOP = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "app", "page",
    "file", "files", "data", "using", "build", "create", "add", "use", "via", "end",
    "a", "an", "of", "to", "in", "on", "it", "is", "are", "be", "so", "as", "each",
  ]);
  return steps.map((step) => {
    const words = Array.from(
      new Set((step.toLowerCase().match(/[a-z][a-z0-9.+/-]{2,}/g) || []).filter((w) => !STOP.has(w))),
    ).slice(0, 8);
    if (words.length === 0) return { step, status: "partial" as StepStatus };
    const hits = words.filter((w) => haystack.includes(w)).length;
    const ratio = hits / words.length;
    const status: StepStatus = ratio >= 0.6 ? "done" : ratio >= 0.3 ? "partial" : "missing";
    return { step, status, note: status === "done" ? undefined : "heuristic match (model unavailable)" };
  });
}

function scoreOf(steps: PlanStepCheck[]): number {
  if (steps.length === 0) return 1;
  const sum = steps.reduce((acc, s) => acc + (s.status === "done" ? 1 : s.status === "partial" ? 0.5 : 0), 0);
  return sum / steps.length;
}

function gapsOf(steps: PlanStepCheck[]): string[] {
  return steps
    .filter((s) => s.status !== "done")
    .map((s) => `${s.status === "missing" ? "Missing" : "Incomplete"}: ${s.step}${s.note ? ` — ${s.note}` : ""}`);
}

/**
 * Verify a built/prepared/deployed app against its implementation plan. Single
 * entry point for all three phases. Always returns a report; never throws.
 */
export async function verifyAgainstPlan(input: VerifyAgainstPlanInput): Promise<PlanVerifyReport> {
  const { phase } = input;
  const plan = (input.plan || "").trim();
  if (!plan) return skipped(phase, "No implementation plan to verify against.");
  const steps = parsePlanSteps(plan);
  if (steps.length === 0) return skipped(phase, "Plan had no checkable steps.");
  if (!input.files?.length) return skipped(phase, "No files to verify.");

  const judge = input.judge ?? judgeWithModel;
  let checks: PlanStepCheck[];
  let summary: string | undefined;
  let checked = true;
  try {
    const judged = await withTimeout(judge(steps, input.files, input), input.timeoutMs ?? 12000);
    if (judged) {
      checks = judged.steps;
      summary = judged.summary;
    } else {
      // Judge declined (e.g. no model configured) → deterministic fallback.
      checks = judgeHeuristic(steps, input.files);
      checked = false;
    }
  } catch {
    // Model down/timeout → deterministic fallback (still a useful signal).
    checks = judgeHeuristic(steps, input.files);
    checked = false;
  }

  const gaps = gapsOf(checks);
  const score = scoreOf(checks);

  // Post-deploy: a broken runtime makes the whole app "not working end-to-end"
  // regardless of the code judgement.
  if (phase === "post-deploy") {
    if (input.health && !input.health.healthy) {
      gaps.unshift(`Backend not serving (HTTP ${input.health.status ?? "no response"}) — the deployed app isn't working end-to-end.`);
    }
    if (input.smoke && !input.smoke.ok) {
      gaps.unshift(`Frontend smoke failed: ${input.smoke.issues.slice(0, 2).join("; ") || "the live page has runtime errors"}.`);
    }
  }

  const hasMissing = checks.some((s) => s.status === "missing");
  const runtimeBroken =
    phase === "post-deploy" && ((input.health && !input.health.healthy) || (input.smoke && !input.smoke.ok));
  const ok = !hasMissing && !runtimeBroken && score >= 0.8;

  const fallbackSummary =
    ok
      ? `All ${checks.length} plan step(s) look implemented end-to-end.`
      : `${gaps.length} of ${checks.length} plan step(s) need attention before this is complete.`;

  return {
    ok,
    score,
    phase,
    steps: checks,
    gaps,
    summary: (summary || fallbackSummary).trim(),
    checked,
  };
}
