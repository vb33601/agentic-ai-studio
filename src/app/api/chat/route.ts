import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  UIMessage,
  stepCountIs,
} from "ai";
import { NextRequest } from "next/server";
import { resolveModel, modelCandidates, primaryAnchor } from "@/lib/ai/providers";
import { ALL_TOOLS } from "@/lib/ai/tools";
import { getAgentConfig, detectAgentType } from "@/lib/ai/agents";
import {
  preprocessPrompt,
  applyOutputPipeline,
  extractArtifacts,
  buildRepairPrompt,
  REPAIR_SYSTEM,
  PLAN_REPAIR_SYSTEM,
  buildPlanRepairPrompt,
  detectComponentGaps,
  detectArtifactFlags,
  detectTruncatedArtifacts,
  analyzePrompt,
  ModelUnavailableError,
  type Artifact,
  isArtifactAgent,
  generateImplementationPlan,
  generateMagicPrompt,
  lastUserText,
  replaceLastUserText,
} from "@/lib/ai/prompt-pipeline";
import { enhancePrompt as enhanceBuildDirectives } from "@/lib/quality/prompt-enhancer";
import { verifyAgainstPlan } from "@/lib/quality/plan-verify";
import { ensureScaffold } from "@/lib/ai/scaffold";
import { extractFilesFromMarkdown } from "@/lib/ai/extract-files";
import { getLanguageFromPath } from "@/lib/utils";

// Route segment config exports MUST be statically-analyzable literals — Next.js
// rejects runtime expressions (e.g. `Number(process.env.X)`) with "Invalid segment
// configuration export detected", failing the build. This is the Render branch
// (Docker, no duration cap), so give the magic-prompt + plan passes their full
// 10-minute window. The Vercel branch (main) keeps its own ≤Hobby-safe literal.
// 60 minutes: free fallback models (kilo-auto/free, HF) are very slow/verbose and
// can take ~20+ min to emit every file plus the repair rounds. This is the Render
// branch (Docker, no platform duration cap), so give the full hour so a free-model
// build can finish producing ALL files instead of being cut off. (The Vercel branch
// keeps its own ≤Hobby-safe literal — Vercel enforces a much lower ceiling.)
export const maxDuration = 3600;

// Cap output tokens per model call. The generation anchor is now Claude (via
// Anthropic-direct or the funded Kilo Code gateway), not a marginal-balance
// OpenRouter key, so we no longer need the tight 8k cap that dodged OpenRouter's
// up-front credit reservation — a larger cap lets big single-file artifacts
// (3–4k-line games/apps) complete in one createFile step instead of truncating.
// Override with MAX_OUTPUT_TOKENS. (OpenRouter fallbacks still honour this cap.)
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 16000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      messages,
      modelId = "openai/gpt-4o",
      provider = "openrouter",
      agentType,
      enableTools = true,
      systemPrompt,
      enhancePrompt = true,
      refineOutput = true,
    } = body as {
      messages: UIMessage[];
      modelId?: string;
      provider?: string;
      agentType?: string;
      enableTools?: boolean;
      systemPrompt?: string;
      enhancePrompt?: boolean;
      refineOutput?: boolean;
    };

    const lastMessage = messages[messages.length - 1];
    const lastText = lastMessage?.parts
      ?.filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("") || "";

    // Respect explicit UI agent selection; auto-detect only when "orchestrator"
    // (the default) is sent so the model routes to the best specialist.
    const resolvedAgentType = agentType && agentType !== "orchestrator"
      ? agentType
      : detectAgentType(lastText);

    const agentConfig = getAgentConfig(resolvedAgentType);
    const agentSystem = systemPrompt || agentConfig.systemPrompt;
    const allowedTools = agentConfig.tools;
    // Use each agent's tuned temperature and step limit, not the UI defaults
    const temperature = agentConfig.temperature;
    const maxSteps = agentConfig.maxSteps;

    // Anchor generation on Claude. Respect an explicit non-default UI model pick;
    // otherwise (no pick, or the legacy "openai/gpt-4o" default that pointed at
    // the now-dead OpenRouter key) lead with the strong anchor — Anthropic-direct
    // when ANTHROPIC_API_KEY is set, else Claude Sonnet 4.6 via funded Kilo Code.
    const usingLegacyDefault = !modelId || modelId === "openai/gpt-4o";
    // Tier the anchor to conserve premium-model credits: only genuinely complex
    // code builds use the heavy model (Claude Sonnet); simple/low-medium builds
    // and ordinary chat use the light model (Claude Haiku — the modern "Claude
    // Instant"). Tunable via HEAVY_TIER_MIN_COMPLEXITY.
    const heavyThreshold = Number(process.env.HEAVY_TIER_MIN_COMPLEXITY) || 0.5;
    const wantHeavy = isArtifactAgent(resolvedAgentType) && analyzePrompt(lastText).complexityScore >= heavyThreshold;
    const anchor = primaryAnchor(wantHeavy ? "heavy" : "light");
    const effModelId = usingLegacyDefault ? anchor.id : modelId;
    const effProvider = usingLegacyDefault ? anchor.provider : provider;
    console.log(`[chat] anchor tier=${wantHeavy ? "heavy" : "light"} model=${effModelId} provider=${effProvider} (legacyDefault=${usingLegacyDefault})`);

    // Ordered model chain: the anchor/pick first, then a cross-provider,
    // cross-account fallback chain ending in free models, tried when a model
    // fails before streaming any content (so a dead key can't truncate a build).
    const candidates = modelCandidates(effModelId, effProvider);

    const activeTools = enableTools
      ? Object.fromEntries(
          Object.entries(ALL_TOOLS).filter(([key]) => allowedTools.includes(key))
        )
      : undefined;
    const hasTools = !!activeTools && Object.keys(activeTools).length > 0;

    // Code must reach the workspace whether or not the model can call tools.
    // Some models (reasoning models like o1 / DeepSeek-R1) ignore tools, and
    // tools can be toggled off entirely. So we always allow a markdown fallback:
    // emit each file as a fenced code block whose info line starts with the path.
    const FILE_OUTPUT_SUFFIX = hasTools
      ? `

If for any reason you do not or cannot call the createFile tool for a file, output that file as a fenced markdown code block whose info line begins with the file path, e.g.:
\`\`\`html index.html
<!doctype html> ...
\`\`\`
Always provide complete, runnable code — never placeholders.`
      : `

IMPORTANT: Tools (including createFile) are NOT available in this session. Ignore any earlier instruction to call tools. Output COMPLETE, runnable code directly in fenced markdown code blocks, beginning each block's info line with the file path, e.g.:
\`\`\`html index.html
<!doctype html> ...
\`\`\`
\`\`\`css styles.css
body { ... }
\`\`\`
Provide every file the project needs as its own labeled code block. Do not abbreviate or use placeholders.`;

    const rawModelMessages = await convertToModelMessages(messages);

    // Preprocess: shape the prompt into an LLM-friendly form (deterministic
    // augmentation always; cheap-model rewrite only for hard prompts) so small
    // models perform closer to large ones. Fails open to the raw prompt.
    const pre = await preprocessPrompt({
      lastUserText: lastText,
      agentType: resolvedAgentType,
      enhance: enhancePrompt,
      modelMessages: rawModelMessages,
      // Ride the effective anchor's gateway (funded) for the enhancer passes,
      // not the original pick that may point at the dead OpenRouter key.
      build: { modelId: effModelId, provider: effProvider },
    });

    // Quality engine (phase 2): for app builders, append web-grounded high-quality
    // build directives (library-first; cached web search only on an intent miss).
    // Bounded + fail-open: a slow/absent search degrades to the curated library, and
    // any error leaves the system prompt unchanged.
    let qualityDirectives = "";
    let qualityMeta = "off";
    if (enhancePrompt && isArtifactAgent(resolvedAgentType) && !pre.analysis.hasInjection && !pre.analysis.looksLikeCode) {
      try {
        const q = await enhanceBuildDirectives(lastText, { useSearch: true, timeoutMs: 5000 });
        if (q.enhanced) {
          qualityDirectives = "\n\n" + q.enhanced;
          qualityMeta = q.matchedIntent ? "library" : q.fromCache ? "cache" : q.usedSearch ? "web" : "library";
        }
      } catch {
        /* fail-open: no directives */
      }
    }

    const finalSystem = agentSystem + pre.systemAugmentation + qualityDirectives + FILE_OUTPUT_SUFFIX;
    // The "magic prompt": the (possibly rewritten) request the model actually receives.
    const magicPromptText = lastUserText(pre.modelMessages) || lastText;

    console.log(`[chat] agent=${resolvedAgentType} model=${modelId} tools=${Object.keys(activeTools ?? {}).join(",")} temp=${temperature} enhance=${enhancePrompt} didRewrite=${pre.didRewrite} quality=${qualityMeta}`);

    // Buffered (replace) output is only safe when no file/image tool parts must
    // reach the client — otherwise we must stream live so the workspace and
    // image renderer get the tool parts.
    const producesArtifacts = hasTools && (allowedTools.includes("createFile") || allowedTools.includes("generateImage"));
    const canRepair = hasTools && allowedTools.includes("createFile");

    const stream = createUIMessageStream({
      // Surface the real error text to the client (the SDK masks it by default).
      onError: (error) => (error instanceof Error ? error.message : String(error)),
      execute: async ({ writer }) => {
        // Quality engine (phase 2): surface the "magic prompt" and a generated
        // end-to-end implementation plan as stream parts — rendered in the UI
        // alongside tool calls. Best-effort: the plan is an LLM call that fails open.
        let implPlan: string | null = null;
        // The messages the model actually builds from — swapped to the expanded
        // magic prompt below for builder agents.
        let implMessages = pre.modelMessages;
        let magicText = magicPromptText;
        if (isArtifactAgent(resolvedAgentType)) {
          // Magic prompt: expand the request into a detailed 500-1000 word brief
          // that the model builds from (and verification derives from). The plan
          // is generated CONCURRENTLY from the original request so the two LLM
          // passes overlap instead of stacking ~16s + ~8s of latency before the
          // build starts. Both fail-open: errors leave the original prompt / no plan.
          const canExpand = !pre.analysis.hasInjection && !pre.analysis.looksLikeCode;
          const build = { modelId: effModelId, provider: effProvider };
          const [expanded, plan] = await Promise.all([
            canExpand ? generateMagicPrompt(magicText, resolvedAgentType, build).catch(() => null) : Promise.resolve(null),
            generateImplementationPlan(magicText, resolvedAgentType, build).catch(() => null),
          ]);
          if (expanded) {
            magicText = expanded;
            implMessages = replaceLastUserText(pre.modelMessages, expanded);
          }
          console.log(`[chat] magic-prompt expanded=${!!expanded} from=${(magicPromptText || "").length} to=${magicText.length} chars`);
          writer.write({
            type: "data-magicPrompt",
            id: "magic-prompt",
            data: { original: lastText, enhanced: magicText, rewritten: magicText !== lastText, source: qualityMeta },
          } as never);
          implPlan = plan;
          if (implPlan) writer.write({ type: "data-plan", id: "impl-plan", data: { plan: implPlan } } as never);
        }
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const model = resolveModel(cand.id, cand.provider);
          // Free/low-balance candidates cap output lower so they actually run
          // instead of being rejected for reserving the full default up front.
          const callMaxTokens = cand.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
          const result = streamText({
            model,
            system: finalSystem,
            messages: implMessages,
            tools: activeTools,
            stopWhen: hasTools ? stepCountIs(maxSteps) : undefined,
            temperature,
            maxOutputTokens: callMaxTokens,
            onFinish: async ({ usage, finishReason }) => {
              console.log(`[chat] finished model=${cand.id} reason=${finishReason} tokens=${usage?.totalTokens}`);
            },
          });

          // Gather the produced files from BOTH output modes — createFile tool
          // calls AND markdown code blocks — so QA / the completeness gate / the
          // scaffold see the full set regardless of how the model emitted files
          // (some models, esp. free ones, write markdown instead of tool-calling).
          const gatherArtifacts = async (): Promise<Artifact[]> => {
            const byPath = new Map<string, Artifact>();
            try {
              for (const f of extractFilesFromMarkdown(await result.text)) byPath.set(f.path, { path: f.path, content: f.content });
            } catch { /* ignore */ }
            for (const f of extractArtifacts(await result.steps)) byPath.set(f.path, f); // tool output wins
            return [...byPath.values()];
          };

          try {
            await applyOutputPipeline({
              writer,
              result,
              agentType: resolvedAgentType,
              refineOutput,
              // Always stream tokens live. Buffered mode held the entire response
              // until generation + refinement finished before showing anything,
              // which made plain chats feel far slower than they are. Refinement
              // still runs in live mode (appended only for low-quality answers).
              canBuffer: false,
              // QA the generated files (only meaningful when createFile is allowed).
              getArtifacts: producesArtifacts ? gatherArtifacts : undefined,
              // One bounded pass to auto-fix flagged files in place.
              repairArtifacts: canRepair
                ? async ({ writer, artifacts, flags }) => {
                    const repair = streamText({
                      model,
                      system: REPAIR_SYSTEM,
                      prompt: buildRepairPrompt(artifacts, flags),
                      tools: activeTools,
                      stopWhen: stepCountIs(1000),
                      temperature,
                      maxOutputTokens: callMaxTokens,
                    });
                    // Same message: don't re-send start, keep it open for the footer.
                    writer.merge(repair.toUIMessageStream({ sendStart: false, sendFinish: false }));
                    await repair.text;
                    return extractArtifacts(await repair.steps);
                  }
                : undefined,
            });

            // Degraded-mode banner: when the build landed on a no-cost FREE
            // fallback (every paid account was unavailable), tell the user the
            // output may be incomplete and how to restore full quality.
            if (cand.free) {
              writer.write({
                type: "data-degraded",
                id: "degraded-mode",
                data: {
                  reason: "free-model-fallback",
                  model: `${cand.provider}/${cand.id}`,
                  message: "Running on a free fallback model — all premium model accounts are out of credits, so this build may be slower and less complete. Add credits (Anthropic, Kilo Code, or OpenRouter) to restore full Claude-quality generation.",
                },
              } as never);
              console.log(`[chat] degraded-mode: ran on free model ${cand.provider}/${cand.id}`);
            }

            // Post-generation CLOSED LOOP — completeness enforcement for BOTH paid
            // and free models. Gaps come from two sources, either of which drives a
            // bounded build+re-check loop:
            //  1. A DETERMINISTIC gate (detectComponentGaps) — model-independent, so
            //     it works even on free-only mode where the LLM judge can't run. It
            //     catches a whole missing component (e.g. backend or frontend built,
            //     the other skipped — the exact free-model failure).
            //  2. The LLM judge (verifyAgainstPlan) — finer plan-step gaps, when a
            //     plan exists and the judge model is reachable.
            // Fail-open: best-effort, never blocks the response.
            if (producesArtifacts) {
              try {
                let artifacts = await gatherArtifacts();
                if (artifacts.length) {
                  const planContext = implPlan || magicText || lastText;
                  let report = implPlan
                    ? await verifyAgainstPlan({ plan: implPlan, files: artifacts, phase: "post-generation", build: { modelId: effModelId, provider: effProvider } })
                    : null;
                  // Enforce ALL error classes to closure, not just plan steps:
                  //  - detectComponentGaps: a whole missing component (model-free)
                  //  - detectArtifactFlags: broken imports, missing entry/server,
                  //    empty required files, package.json start→missing file
                  //  - judge gaps: finer plan-step gaps (when the judge can run)
                  // This is what lets even a FREE model's output end up complete and
                  // runnable — the loop keeps building until these deterministic
                  // error checks clear (or a round makes no progress).
                  const currentGaps = () => {
                    const judge = report?.checked && !report.ok ? report.gaps : [];
                    return [
                      ...detectComponentGaps(artifacts, lastText),
                      ...detectTruncatedArtifacts(artifacts),
                      ...detectArtifactFlags(artifacts),
                      ...judge,
                    ];
                  };

                  let gaps = currentGaps();
                  // Free models are weaker per pass, so allow more repair rounds.
                  const maxRounds = Number(process.env.PLAN_REPAIR_ROUNDS) || (cand.free ? 4 : 2);
                  for (let round = 0; canRepair && gaps.length > 0 && round < maxRounds; round++) {
                    console.log(`[chat] plan-repair round=${round + 1}/${maxRounds} gaps=${gaps.length}`);
                    const fix = streamText({
                      model,
                      system: PLAN_REPAIR_SYSTEM,
                      prompt: buildPlanRepairPrompt(artifacts, gaps, planContext),
                      tools: activeTools,
                      stopWhen: stepCountIs(maxSteps),
                      temperature,
                      maxOutputTokens: callMaxTokens,
                    });
                    // Same message: keep it open; stream the new files live.
                    writer.merge(fix.toUIMessageStream({ sendStart: false, sendFinish: false }));
                    await fix.text;
                    const added = await (async () => {
                      const m = new Map<string, Artifact>();
                      try { for (const f of extractFilesFromMarkdown(await fix.text)) m.set(f.path, { path: f.path, content: f.content }); } catch { /* ignore */ }
                      for (const f of extractArtifacts(await fix.steps)) m.set(f.path, f);
                      return [...m.values()];
                    })();
                    if (added.length === 0) break; // model built nothing → stop

                    // New/changed files overwrite by path; the rest are preserved.
                    const byPath = new Map(artifacts.map((a) => [a.path, a]));
                    for (const a of added) byPath.set(a.path, a);
                    artifacts = [...byPath.values()];

                    if (implPlan) {
                      report = await verifyAgainstPlan({ plan: implPlan, files: artifacts, phase: "post-generation", build: { modelId: effModelId, provider: effProvider } });
                    }
                    const nextGaps = currentGaps();
                    if (nextGaps.length >= gaps.length) { gaps = nextGaps; break; } // no progress → stop
                    gaps = nextGaps;
                  }

                  if (report?.checked) {
                    writer.write({ type: "data-verification", id: "plan-verify", data: report } as never);
                    console.log(`[chat] plan-verify ok=${report.ok} score=${report.score.toFixed(2)} gaps=${report.gaps.length}`);
                  }
                }

                // FINAL deterministic guarantee (NO model): fill any still-missing
                // stack-standard boilerplate (entry/config/bootstrap) so the app
                // BOOTS regardless of model quality — even on free models or when
                // the model produced nothing. Emitted as labeled code blocks, which
                // the client ingests into the workspace exactly like generated files.
                const scaffolded = ensureScaffold(artifacts, lastText);
                if (scaffolded.length) {
                  const block = scaffolded
                    .map((f) => "```" + (getLanguageFromPath(f.path) || "") + " " + f.path + "\n" + f.content + "\n```")
                    .join("\n\n");
                  const id = `scaffold-${Math.random().toString(36).slice(2)}`;
                  writer.write({ type: "text-start", id } as never);
                  writer.write({ type: "text-delta", id, delta: `\n\n**Scaffolded ${scaffolded.length} missing file(s)** so the app runs:\n\n${block}` } as never);
                  writer.write({ type: "text-end", id } as never);
                  console.log(`[chat] scaffold: added ${scaffolded.length} files: ${scaffolded.map((f) => f.path).join(", ")}`);
                }
              } catch {
                /* fail-open: no verification/repair/scaffold */
              }
            }
            return; // succeeded (or partial content already streamed)
          } catch (err) {
            // Retry the next candidate only when the model failed before any
            // content reached the client.
            if (err instanceof ModelUnavailableError && i < candidates.length - 1) {
              lastError = err.cause;
              console.warn(`[chat] model ${cand.id} unavailable, falling back:`, err.message);
              continue;
            }
            throw err instanceof ModelUnavailableError ? (err.cause ?? err) : err;
          }
        }
        if (lastError) throw lastError;
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    console.error("Chat API error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
