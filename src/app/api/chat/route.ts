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
import { samplingFor } from "@/lib/ai/hyperparams";
import { ALL_TOOLS } from "@/lib/ai/tools";
import { getAgentConfig, detectAgentType } from "@/lib/ai/agents";
import {
  preprocessPrompt,
  applyOutputPipeline,
  extractArtifacts,
  buildRepairPrompt,
  REPAIR_SYSTEM,
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
import { enforceCompleteness } from "@/lib/ai/completeness";
import { extractFilesFromMarkdown } from "@/lib/ai/extract-files";

// Route segment config exports MUST be statically-analyzable literals — Next.js
// rejects runtime expressions (e.g. `Number(process.env.X)`) with "Invalid segment
// configuration export detected", failing the build. This is the Render branch
// (Docker, no duration cap), so give the magic-prompt + plan passes their full
// 10-minute window. The Vercel branch (main) keeps its own ≤Hobby-safe literal.
// 60-minute budget for ALL models (free AND paid). This is a route-level limit
// that applies to every request regardless of which candidate model handles it —
// not model-specific. Paid models (Claude) typically finish in ~3-4 min and never
// approach it; the headroom exists for the slow/verbose free fallbacks
// (kilo-auto/free, HF), which can take ~20+ min to emit every file plus the repair
// rounds — so a build always has time to produce ALL files instead of being cut
// off. This is the Render branch (Docker, no platform duration cap). (The Vercel
// branch keeps its own ≤Hobby-safe literal — Vercel enforces a much lower ceiling.)
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
        // Keep-alive heartbeat. Free fallback models (and the magic-prompt / plan /
        // verify / continue-build passes) have long stretches where NO bytes flow to
        // the client. A browser/proxy can drop such an idle streaming connection
        // (the app "stops early" even though the server is still working) — whereas a
        // curl with a long total timeout survives because it has no idle limit. Emit
        // a tiny transient part every 10s so the connection never goes idle, making
        // the app behave like that curl. Fixed id + transient → invisible, not saved.
        const heartbeat = setInterval(() => {
          try { writer.write({ type: "data-heartbeat", id: "hb", data: { t: Date.now() }, transient: true } as never); } catch { /* writer closed */ }
        }, 10000);
        // Live status line (shared id with enforceCompleteness, which updates &
        // clears it) so the initial silent gap (magic-prompt + plan on a slow free
        // model) and the build phases give the user visible feedback.
        const status = (text: string) => {
          try { writer.write({ type: "data-status", id: "build-status", data: { text } } as never); } catch { /* writer closed */ }
        };
        try {
        // Quality engine (phase 2): surface the "magic prompt" and a generated
        // end-to-end implementation plan as stream parts — rendered in the UI
        // alongside tool calls. Best-effort: the plan is an LLM call that fails open.
        let implPlan: string | null = null;
        // The messages the model actually builds from — swapped to the expanded
        // magic prompt below for builder agents.
        let implMessages = pre.modelMessages;
        let magicText = magicPromptText;
        if (isArtifactAgent(resolvedAgentType)) {
          status("Understanding your request and planning the app…");
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
        if (producesArtifacts) status("Generating your application…");
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const model = resolveModel(cand.id, cand.provider);
          // Per-candidate sampling: free/low-balance models cap output lower (so they
          // run) and get a repetition penalty (to curb runaway verbosity); code
          // builds get a lower temperature. Tuned profiles override the heuristic.
          const sampling = samplingFor(cand, { baseTemperature: temperature, baseMaxTokens: MAX_OUTPUT_TOKENS, isCodeBuild: producesArtifacts });
          const result = streamText({
            model,
            system: finalSystem,
            messages: implMessages,
            tools: activeTools,
            stopWhen: hasTools ? stepCountIs(maxSteps) : undefined,
            ...sampling,
            onFinish: async ({ usage, finishReason }) => {
              console.log(`[chat] finished model=${cand.id} reason=${finishReason} tokens=${usage?.totalTokens} temp=${sampling.temperature} freqPen=${sampling.frequencyPenalty ?? 0}`);
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
                      ...sampling,
                    });
                    // Same message: don't re-send start, keep it open for the footer.
                    writer.merge(repair.toUIMessageStream({ sendStart: false, sendFinish: false }));
                    await repair.text;
                    return extractArtifacts(await repair.steps);
                  }
                : undefined,
            });

            // Post-generation completeness pipeline (degraded banner +
            // continue-until-complete loop + deterministic scaffold), shared with the
            // agent route so the SAME guarantees apply everywhere — for ALL models
            // (free and paid) and ALL technologies.
            if (producesArtifacts) {
              await enforceCompleteness({
                writer,
                result,
                model,
                tools: activeTools,
                maxSteps,
                sampling,
                requestText: lastText,
                plan: implPlan,
                planContext: implPlan || magicText || lastText,
                build: { modelId: effModelId, provider: effProvider },
                canRepair,
                free: cand.free,
                freeModelLabel: `${cand.provider}/${cand.id}`,
              });
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
        } finally {
          clearInterval(heartbeat);
          status(""); // always clear the status line when the turn ends
        }
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
