import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  UIMessage,
  stepCountIs,
} from "ai";
import { NextRequest } from "next/server";
import { resolveModel } from "@/lib/ai/providers";
import { ALL_TOOLS } from "@/lib/ai/tools";
import { AGENT_CONFIGS } from "@/lib/ai/agents";
import {
  preprocessPrompt,
  applyOutputPipeline,
  extractArtifacts,
  buildRepairPrompt,
  REPAIR_SYSTEM,
} from "@/lib/ai/prompt-pipeline";

export const maxDuration = 300;

// See chat/route.ts — bound per-call output so OpenRouter's upfront credit
// reservation stays small and generation isn't cut off with a 402.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 8000;

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
    const model = resolveModel(modelId);

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
    });

    const finalSystem = config.systemPrompt + pre.systemAugmentation;

    const producesArtifacts = config.tools.includes("createFile") || config.tools.includes("generateImage");
    const canRepair = config.tools.includes("createFile");

    const stream = createUIMessageStream({
      onError: (error) => (error instanceof Error ? error.message : String(error)),
      execute: async ({ writer }) => {
        const result = streamText({
          model,
          system: finalSystem,
          messages: pre.modelMessages,
          tools,
          stopWhen: stepCountIs(config.maxSteps),
          temperature: config.temperature,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });

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
                  temperature: config.temperature,
                  maxOutputTokens: MAX_OUTPUT_TOKENS,
                });
                writer.merge(repair.toUIMessageStream({ sendStart: false, sendFinish: false }));
                await repair.text;
                return extractArtifacts(await repair.steps);
              }
            : undefined,
        });
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
