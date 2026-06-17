/**
 * The agentic edit loop — the structural replacement for the old one-shot stream.
 *
 * Instead of streaming an entire app as one fragile blob and repairing it after
 * the fact, the model EDITS a runnable template through discrete, validated tool
 * calls in a BOUNDED multi-step loop (AI SDK `stepCountIs`). Truth comes from the
 * working tree (and, in Phase 2, from actually running it) — not from regex.
 *
 * This module is intentionally transport-agnostic and side-effect free beyond the
 * in-memory VFS, so it is unit-testable headless (see scripts/test-agent-loop.mts)
 * and can later be wired to the chat route's stream writer.
 */
import { streamText, stepCountIs, type LanguageModel, type UIMessageStreamWriter } from "ai";
import { VirtualFileSystem, type VFile } from "./vfs";
import { makeEditTools } from "./tools";
import { buildAgentSystem } from "./prompt";
import { selectTemplate, getTemplate, type Template, type TemplateKey } from "../templates/registry";

export interface AgentLoopOptions {
  model: LanguageModel;
  /** The (already expanded) build request the model works from. */
  request: string;
  /** Force a template; otherwise it is selected from the request. */
  templateKey?: TemplateKey;
  /** A fully-resolved template (curated/seed/scaffold) — wins over templateKey. */
  template?: Template;
  /** Pre-seeded VFS (e.g. an existing project for a follow-up edit). Overrides template seeding. */
  vfs?: VirtualFileSystem;
  /** Max tool/model steps before the loop stops (bound against runaway loops). */
  maxSteps?: number;
  /** Sampling params (temperature, maxOutputTokens, penalties) — same shape the route uses. */
  sampling?: {
    temperature?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    maxOutputTokens?: number;
  };
  /** Optional live stream writer to merge model output into (the chat route). */
  writer?: UIMessageStreamWriter;
  /** Per-file change callback (drives UI status / logging). */
  onFileChange?: (op: string, path: string) => void;
  /** Re-serialize the codebase into the system prompt up to this many bytes. */
  contextBytes?: number;
}

export interface AgentLoopResult {
  files: VFile[];
  template: Template;
  changed: string[];
  deleted: string[];
  steps: number;
  finishReason: string;
  text: string;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const template = opts.template ?? (opts.templateKey ? getTemplate(opts.templateKey) : selectTemplate(opts.request));
  const vfs = opts.vfs ?? new VirtualFileSystem(template.files);
  const tools = makeEditTools(vfs, { onChange: opts.onFileChange });
  const maxSteps = opts.maxSteps ?? 60;

  // The system prompt embeds the live tree at START. The tools mutate the same
  // VFS in place, and the model reads current state via read_file/list_files
  // during the run, so it always operates against truth.
  const system = buildAgentSystem(template, vfs, opts.contextBytes ?? 60_000);

  const result = streamText({
    model: opts.model,
    system,
    prompt: opts.request,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(opts.sampling ?? {}),
  });

  // When given a writer (live mode), merge the model's UI stream so tool calls and
  // text reach the client; otherwise just drain it (headless/test/eval).
  if (opts.writer) {
    opts.writer.merge(result.toUIMessageStream({ sendStart: false, sendFinish: false }));
  }

  const text = await result.text;
  const steps = (await result.steps) as unknown[];
  const finishReason = await result.finishReason;

  return {
    files: vfs.snapshot(),
    template,
    changed: [...vfs.changed],
    deleted: [...vfs.deleted],
    steps: steps.length,
    finishReason: String(finishReason),
    text,
  };
}
