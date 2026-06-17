/**
 * Bridge between the chat route and the agentic edit loop.
 *
 * Behind the AGENT_LOOP flag, artifact builds run through runAgentLoop (scaffold
 * template + bounded edit-tool loop) instead of the legacy one-shot stream. The
 * loop runs HEADLESS (no token merge) for robustness, surfacing live progress as
 * status lines; when it finishes, the COMPLETE in-memory file set is emitted as
 * fenced markdown blocks — the same form the client workspace
 * (extractFilesFromMarkdown) and the eval harness both already capture — followed
 * by a structural completeness verdict (so client auto-resume + eval scoring work
 * unchanged).
 *
 * Tries the model candidate chain in order: a candidate that fails before
 * producing files falls through to the next (a dead key can't kill the build).
 */
import type { UIMessageStreamWriter } from "ai";
import { resolveModel, type ModelCandidate } from "@/lib/ai/providers";
import { samplingFor } from "@/lib/ai/hyperparams";
import { getLanguageFromPath } from "@/lib/utils";
import { findAppGaps } from "@/lib/ai/incomplete-files";
import { runAgentLoop } from "./loop";
import { resolveStartTemplate } from "../templates/resolve";
import { VirtualFileSystem, type VFile } from "./vfs";
import { certifyFiles, buildCertifyFixPrompt } from "./certify";

export interface AgentBuildOpts {
  writer: UIMessageStreamWriter;
  candidates: ModelCandidate[];
  /** The (expanded) brief the model builds from. */
  request: string;
  /** The original user request — drives the structural gap heuristics. */
  requestForGaps: string;
  baseTemperature: number;
  baseMaxTokens: number;
  maxSteps: number;
  status: (text: string) => void;
}

/** Emit the finished file set as labelled fenced blocks (client + eval capture). */
function emitFiles(writer: UIMessageStreamWriter, files: VFile[]): void {
  if (!files.length) return;
  const id = `agent-files-${Math.random().toString(36).slice(2)}`;
  const blocks = files
    .map((f) => "```" + (getLanguageFromPath(f.path) || "") + " " + f.path + "\n" + f.content + "\n```")
    .join("\n\n");
  writer.write({ type: "text-start", id } as never);
  writer.write({ type: "text-delta", id, delta: `\n\n${blocks}` } as never);
  writer.write({ type: "text-end", id } as never);
}

export async function runAgentBuild(o: AgentBuildOpts): Promise<void> {
  // Resolve the starting point across the WHOLE matrix: curated inline template,
  // a runnable seed, or the stack's official scaffolder (run in the sandbox).
  o.status("Choosing the best starting template…");
  const { template, strategy } = await resolveStartTemplate(o.request || o.requestForGaps);
  o.writer.write({ type: "data-template", id: "agent-template", data: { key: template.key, label: template.label, stack: `${template.stack}/${template.framework}`, strategy } } as never);

  // Per-file progress: accumulate {path, op} and stream it as a single live part so
  // the UI shows a checklist that updates as the model writes each file.
  const fileOps = new Map<string, string>();
  const emitProgress = () => {
    o.writer.write({ type: "data-files", id: "agent-file-progress", data: { files: [...fileOps.entries()].map(([path, op]) => ({ path, op })) } } as never);
  };

  let lastError: unknown;
  for (let i = 0; i < o.candidates.length; i++) {
    const cand = o.candidates[i];
    const model = resolveModel(cand.id, cand.provider);
    const sampling = samplingFor(cand, {
      baseTemperature: o.baseTemperature,
      baseMaxTokens: cand.maxOutputTokens ?? o.baseMaxTokens,
      isCodeBuild: true,
    });
    try {
      const onFileChange = (op: string, path: string) => {
        const verb = op === "write" ? "Writing" : op === "edit" ? "Editing" : op === "delete" ? "Deleting" : op === "rename" ? "Renaming" : op;
        o.status(`${verb} ${path}…`);
        fileOps.set(path, op === "delete" ? "deleted" : "done");
        emitProgress();
      };
      // Seed the live progress with the template's files so the user sees the
      // starting tree immediately, then watch it evolve.
      for (const p of Object.keys(template.files)) fileOps.set(p, "template");
      emitProgress();
      // One VFS across the build AND the fix rounds, so certification errors are
      // fixed in place on the same tree instead of regenerating from scratch.
      const vfs = new VirtualFileSystem(template.files);

      o.status(`Starting from the ${template.label} template…`);
      const res = await runAgentLoop({ model, request: o.request, template, vfs, sampling, maxSteps: o.maxSteps, onFileChange });

      // --- Phase 2: local build/boot certification + fix loop ---
      // Run the produced app in a sandbox; feed REAL compiler/runtime errors back to
      // the edit loop until it builds (or rounds run out). No-op when no sandbox is
      // configured (cert.ran=false) — the build then stands on the structural verdict.
      let cert = await certifyFiles(vfs.snapshot());
      const maxFix = Number(process.env.CERTIFY_FIX_ROUNDS) || 3;
      for (let r = 0; cert.ran && !cert.ok && r < maxFix; r++) {
        o.status(`Build failed — fixing errors (pass ${r + 1})…`);
        await runAgentLoop({ model, request: buildCertifyFixPrompt(cert), template, vfs, sampling, maxSteps: o.maxSteps, onFileChange });
        cert = await certifyFiles(vfs.snapshot());
      }
      if (cert.ran) {
        o.writer.write({ type: "data-certification", id: "agent-certify", data: { ran: true, ok: cert.ok, stack: cert.stack, errors: cert.errors.slice(0, 8), runOk: cert.runOk } } as never);
      }

      o.status("Reviewing the generated app…");
      const files = vfs.snapshot();
      emitFiles(o.writer, files);

      // Structural verdict — same shape the legacy completeness pipeline emits, so
      // the client auto-resume and the eval harness treat both paths identically.
      // A failed certification keeps the verdict open so the client can resume.
      const gaps = findAppGaps(files, o.requestForGaps);
      const ok = gaps.length === 0 && (!cert.ran || cert.ok);
      o.writer.write({
        type: "data-verification",
        id: "plan-verify",
        data: {
          ok,
          score: ok ? 1 : 0,
          phase: "post-generation",
          steps: [],
          gaps: cert.ran && !cert.ok ? [...gaps, `build failed: ${cert.errors.slice(0, 3).join("; ")}`] : gaps,
          summary: ok
            ? `Built ${files.length} files from the ${template.label} template${cert.ran ? " — sandbox build passed" : ""}; all checks passed.`
            : cert.ran && !cert.ok ? `Build still failing after fix rounds.` : `${gaps.length} structural gap(s) remain.`,
          checked: true,
        },
      } as never);
      console.log(`[agent-build] model=${cand.id} template=${template.key} files=${files.length} changed=${res.changed.length} steps=${res.steps} reason=${res.finishReason} gaps=${gaps.length} cert=${cert.ran ? (cert.ok ? "pass" : "fail") : "skip"}`);
      return; // success
    } catch (err) {
      lastError = err;
      console.warn(`[agent-build] candidate ${cand.id} failed:`, (err as Error)?.message ?? err);
      if (i < o.candidates.length - 1) continue; // fall through to next model
      throw err;
    }
  }
  if (lastError) throw lastError;
}
