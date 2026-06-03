import { streamText, convertToModelMessages, UIMessage, stepCountIs } from "ai";
import { NextRequest } from "next/server";
import { resolveModel } from "@/lib/ai/providers";
import { ALL_TOOLS } from "@/lib/ai/tools";
import { AGENT_CONFIGS } from "@/lib/ai/agents";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { messages, agentType = "orchestrator", modelId = "openai/gpt-4o" } = await req.json() as {
      messages: UIMessage[];
      agentType?: string;
      modelId?: string;
    };

    const config = AGENT_CONFIGS[agentType] || AGENT_CONFIGS.orchestrator;
    const model = resolveModel(modelId);

    const tools = Object.fromEntries(
      Object.entries(ALL_TOOLS).filter(([key]) => config.tools.includes(key))
    );

    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      model,
      system: config.systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(config.maxSteps),
      temperature: config.temperature,
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error("Agent API error:", error);
    return new Response(JSON.stringify({ error: "Agent execution failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
