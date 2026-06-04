import { streamText, convertToModelMessages, UIMessage, stepCountIs } from "ai";
import { NextRequest } from "next/server";
import { resolveModel } from "@/lib/ai/providers";
import { ALL_TOOLS } from "@/lib/ai/tools";
import { getAgentConfig, detectAgentType } from "@/lib/ai/agents";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      messages,
      modelId = "openai/gpt-4o",
      agentType,
      enableTools = true,
      systemPrompt,
    } = body as {
      messages: UIMessage[];
      modelId?: string;
      agentType?: string;
      enableTools?: boolean;
      systemPrompt?: string;
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

    const model = resolveModel(modelId);

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

    const finalSystem = agentSystem + FILE_OUTPUT_SUFFIX;

    const modelMessages = await convertToModelMessages(messages);

    console.log(`[chat] agent=${resolvedAgentType} model=${modelId} tools=${Object.keys(activeTools ?? {}).join(",")} temp=${temperature}`);

    const result = streamText({
      model,
      system: finalSystem,
      messages: modelMessages,
      tools: activeTools,
      stopWhen: hasTools ? stepCountIs(maxSteps) : undefined,
      temperature,
      onFinish: async ({ usage, finishReason }) => {
        console.log(`[chat] finished reason=${finishReason} tokens=${usage?.totalTokens}`);
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error("Chat API error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
