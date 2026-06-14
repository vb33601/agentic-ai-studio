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
  isArtifactAgent,
  generateImplementationPlan,
  generateMagicPrompt,
  lastUserText,
  replaceLastUserText,
} from "@/lib/ai/prompt-pipeline";
import { enhancePrompt as enhanceBuildDirectives } from "@/lib/quality/prompt-enhancer";
import { verifyAgainstPlan } from "@/lib/quality/plan-verify";

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
          const [expanded, plan] = await Promise.all([
            canExpand ? generateMagicPrompt(magicText, resolvedAgentType).catch(() => null) : Promise.resolve(null),
            generateImplementationPlan(magicText, resolvedAgentType).catch(() => null),
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
          const result = streamText({
            model,
            system: finalSystem,
            messages: implMessages,
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

            // Subsystem D — post-generation end-to-end check: verify the files
            // the model actually produced against the implementation plan, and
            // surface the verdict as a stream part (rendered in the UI alongside
            // the magic prompt, plan, and tool calls). Fail-open: best-effort.
            if (implPlan && producesArtifacts) {
              try {
                const artifacts = extractArtifacts(await result.steps);
                if (artifacts.length) {
                  const report = await verifyAgainstPlan({
                    plan: implPlan,
                    files: artifacts,
                    phase: "post-generation",
                  });
                  if (report.checked) {
                    writer.write({ type: "data-verification", id: "plan-verify", data: report } as never);
                    console.log(`[chat] plan-verify ok=${report.ok} score=${report.score.toFixed(2)} gaps=${report.gaps.length}`);
                  }
                }
              } catch {
                /* fail-open: no verification part */
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
