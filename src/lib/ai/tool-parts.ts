import { UIMessage } from "ai";

/**
 * Normalized view of an AI SDK v6 tool part.
 *
 * The SDK emits tool invocations in two shapes depending on whether the tool
 * was registered as "dynamic":
 *   - dynamic tools  -> part.type === "dynamic-tool", name in `part.toolName`
 *   - typed tools    -> part.type === `tool-${name}`, name encoded in the type
 *
 * Our server registers tools as a plain object (typed, not dynamic), so the
 * client receives `tool-<name>` parts. Earlier code only looked for
 * "dynamic-tool", which silently matched nothing. This helper handles both.
 */
export interface NormalizedToolPart {
  toolName: string;
  toolCallId?: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function isToolPartType(type: unknown): type is string {
  return typeof type === "string" && (type === "dynamic-tool" || type.startsWith("tool-"));
}

/** Extract and normalize every tool invocation from a UI message. */
export function getToolParts(message: UIMessage): NormalizedToolPart[] {
  const parts = message.parts ?? [];
  const out: NormalizedToolPart[] = [];

  for (const p of parts) {
    if (!isToolPartType(p.type)) continue;
    const part = p as Record<string, unknown>;

    const toolName =
      p.type === "dynamic-tool"
        ? (part.toolName as string)
        : (p.type as string).slice("tool-".length);

    if (!toolName) continue;

    out.push({
      toolName,
      toolCallId: part.toolCallId as string | undefined,
      state: part.state as string,
      input: part.input,
      output: part.output,
      errorText: part.errorText as string | undefined,
    });
  }

  return out;
}
