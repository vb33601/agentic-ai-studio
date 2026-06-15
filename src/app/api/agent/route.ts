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
import { AGENT_CONFIGS } from "@/lib/ai/agents";
import {
  preprocessPrompt,
  applyOutputPipeline,
  extractArtifacts,
  buildRepairPrompt,
  REPAIR_SYSTEM,
  ModelUnavailableError,
} from "@/lib/ai/prompt-pipeline";
import { enforceCompleteness } from "@/lib/ai/completeness";
import { samplingFor } from "@/lib/ai/hyperparams";

// 60-minute budget for ALL models (matches chat/route.ts). Render branch (Docker,
// no platform duration cap). The Vercel branch keeps its own ≤Hobby-safe literal.
export const maxDuration = 3600;

// Larger per-call cap now that the anchor is Claude (not a marginal-balance
// OpenRouter key); free fallback candidates carry their own smaller cap.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 16000;

export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      agentType = "orchestrator",
      modelId = "openai/gpt-4o",
      enhancePrompt = true,
      refineOutput = true,
    } = await req.json() as {
      messages: UIMessage[];
      agentType?: string;
      modelId?: string;
      enhancePrompt?: boolean;
      refineOutput?: boolean;
    };

    const config = AGENT_CONFIGS[agentType] || AGENT_CONFIGS.orchestrator;
    // Anchor on Claude when the caller didn't pick a model (the legacy default
    // points at the dead OpenRouter key); cross-provider + free fallbacks follow.
    const usingLegacyDefault = !modelId || modelId === "openai/gpt-4o";
    const anchor = primaryAnchor();
    const effModelId = usingLegacyDefault ? anchor.id : modelId;
    const effProvider = usingLegacyDefault ? anchor.provider : "openrouter";
    const candidates = modelCandidates(effModelId, effProvider);

    const tools = Object.fromEntries(
      Object.entries(ALL_TOOLS).filter(([key]) => config.tools.includes(key))
    );

    const lastMessage = messages[messages.length - 1];
    const lastText = lastMessage?.parts
      ?.filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("") || "";

    const rawModelMessages = await convertToModelMessages(messages);

    const pre = await preprocessPrompt({
      lastUserText: lastText,
      agentType,
      enhance: enhancePrompt,
      modelMessages: rawModelMessages,
      // Ride the effective anchor's gateway (funded) for the enhancer passes.
      build: { modelId: effModelId, provider: effProvider },
    });

    const finalSystem = config.systemPrompt + pre.systemAugmentation;

    const producesArtifacts = config.tools.includes("createFile") || config.tools.includes("generateImage");
    const canRepair = config.tools.includes("createFile");

    const stream = createUIMessageStream({
      onError: (error) => (error instanceof Error ? error.message : String(error)),
      execute: async ({ writer }) => {
        // Keep-alive heartbeat (see chat/route.ts): emit a tiny transient part every
        // 10s so an idle browser/proxy doesn't drop the streaming connection during
        // the slow free-model / continue-build gaps.
        const heartbeat = setInterval(() => {
          try { writer.write({ type: "data-heartbeat", id: "hb", data: { t: Date.now() }, transient: true } as never); } catch { /* writer closed */ }
        }, 10000);
        try {
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const model = resolveModel(cand.id, cand.provider);
          // Per-candidate sampling (see chat/route.ts): lower temp for code builds,
          // repetition penalty for the free tier, per-candidate token cap.
          const sampling = samplingFor(cand, { baseTemperature: config.temperature, baseMaxTokens: MAX_OUTPUT_TOKENS, isCodeBuild: producesArtifacts });
          const result = streamText({
            model,
            system: finalSystem,
            messages: pre.modelMessages,
            tools,
            stopWhen: stepCountIs(config.maxSteps),
            ...sampling,
          });

          try {
            await applyOutputPipeline({
              writer,
              result,
              agentType,
              refineOutput,
              canBuffer: !producesArtifacts,
              getArtifacts: producesArtifacts
                ? async () => extractArtifacts(await result.steps)
                : undefined,
              repairArtifacts: canRepair
                ? async ({ writer, artifacts, flags }) => {
                    const repair = streamText({
                      model,
                      system: REPAIR_SYSTEM,
                      prompt: buildRepairPrompt(artifacts, flags),
                      tools,
                      stopWhen: stepCountIs(4),
                      ...sampling,
                    });
                    writer.merge(repair.toUIMessageStream({ sendStart: false, sendFinish: false }));
                    await repair.text;
                    return extractArtifacts(await repair.steps);
                  }
                : undefined,
            });

            // Same completeness pipeline as the chat route — applies EVERYWHERE for
            // ALL models and technologies. The agent route has no implementation
            // plan, so it relies on the deterministic component gate + scaffold.
            if (producesArtifacts) {
              await enforceCompleteness({
                writer,
                result,
                model,
                tools,
                maxSteps: config.maxSteps,
                sampling,
                requestText: lastText,
                plan: null,
                planContext: lastText,
                build: { modelId: effModelId, provider: effProvider },
                canRepair,
                free: cand.free,
                freeModelLabel: `${cand.provider}/${cand.id}`,
              });
            }
            return;
          } catch (err) {
            if (err instanceof ModelUnavailableError && i < candidates.length - 1) {
              lastError = err.cause;
              console.warn(`[agent] model ${cand.id} unavailable, falling back:`, err.message);
              continue;
            }
            throw err instanceof ModelUnavailableError ? (err.cause ?? err) : err;
          }
        }
        if (lastError) throw lastError;
        } finally {
          clearInterval(heartbeat);
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    console.error("Agent API error:", error);
    return new Response(JSON.stringify({ error: "Agent execution failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
