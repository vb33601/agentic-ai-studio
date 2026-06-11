import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  UIMessage,
  stepCountIs,
} from "ai";
import { NextRequest } from "next/server";
import { resolveModel, modelCandidates } from "@/lib/ai/providers";
import { ALL_TOOLS } from "@/lib/ai/tools";
import { getAgentConfig, detectAgentType } from "@/lib/ai/agents";
import {
  preprocessPrompt,
  applyOutputPipeline,
  extractArtifacts,
  buildRepairPrompt,
  REPAIR_SYSTEM,
  ModelUnavailableError,
} from "@/lib/ai/prompt-pipeline";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

// Cap output tokens per model call. OpenRouter reserves credits for the FULL
// max_tokens up front, so an unbounded request (their 16k default) gets a 402
// "requires more credits" on a low-balance key and the generation is cut off
// mid-file. Each file is its own tool step, so a bounded per-call cap still
// produces large multi-file apps across steps. Override with MAX_OUTPUT_TOKENS.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 8000;

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

    // Ordered model chain: the user's pick first, then reliable fallbacks tried
    // when a model fails before streaming any content.
    const candidates = modelCandidates(modelId, provider);

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
    });

    const finalSystem = agentSystem + pre.systemAugmentation + FILE_OUTPUT_SUFFIX;

    console.log(`[chat] agent=${resolvedAgentType} model=${modelId} tools=${Object.keys(activeTools ?? {}).join(",")} temp=${temperature} enhance=${enhancePrompt} didRewrite=${pre.didRewrite}`);

    // Buffered (replace) output is only safe when no file/image tool parts must
    // reach the client — otherwise we must stream live so the workspace and
    // image renderer get the tool parts.
    const producesArtifacts = hasTools && (allowedTools.includes("createFile") || allowedTools.includes("generateImage"));
    const canRepair = hasTools && allowedTools.includes("createFile");

    const stream = createUIMessageStream({
      // Surface the real error text to the client (the SDK masks it by default).
      onError: (error) => (error instanceof Error ? error.message : String(error)),
      execute: async ({ writer }) => {
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const model = resolveModel(cand.id, cand.provider);
          const result = streamText({
            model,
            system: finalSystem,
            messages: pre.modelMessages,
            tools: activeTools,
            stopWhen: hasTools ? stepCountIs(maxSteps) : undefined,
            temperature,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            onFinish: async ({ usage, finishReason }) => {
              console.log(`[chat] finished model=${cand.id} reason=${finishReason} tokens=${usage?.totalTokens}`);
            },
          });

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
              getArtifacts: producesArtifacts
                ? async () => extractArtifacts(await result.steps)
                : undefined,
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
                      maxOutputTokens: MAX_OUTPUT_TOKENS,
                    });
                    // Same message: don't re-send start, keep it open for the footer.
                    writer.merge(repair.toUIMessageStream({ sendStart: false, sendFinish: false }));
                    await repair.text;
                    return extractArtifacts(await repair.steps);
                  }
                : undefined,
            });
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
