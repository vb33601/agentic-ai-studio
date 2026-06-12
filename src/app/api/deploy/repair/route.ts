import { NextRequest, NextResponse } from "next/server";
import { autoFixBuildError } from "@/lib/ai/auto-fix";
import { resolveModel } from "@/lib/ai/providers";
import { prepareFrontendForVercel } from "@/lib/deploy/frontend-prepare";
import { prepareForDeploy } from "@/lib/deploy/prepare";
import { deployToVercel } from "@/lib/deploy/vercel";
import { serverToken } from "@/lib/deploy/env";
import type { WorkspaceFile } from "@/store/workspace";

// Auto-fix runs on the Kilo Code gateway (one key, ~335 models). gpt-4o-mini is
// cheap, fast, and reliable at the structured search/replace output; override per
// request with { modelId, provider }.
const DEFAULT_REPAIR_MODEL = "openai/gpt-4o-mini";
const DEFAULT_REPAIR_PROVIDER = "kilocode";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

/**
 * Self-healing deploy/build repair. Given a REAL build error (a Vercel/Render
 * build log, or the WebContainer preview's compile error) and the app files, it
 * web-searches the known fix for that error across the app's stack and applies it
 * (see [[auto-fix]]). The deterministic transforms in `prepare.ts` already catch
 * the common classes on every deploy — this is the escalation for the long tail.
 *
 * mode "deploy" (default): patch the files, then re-prepare + redeploy the
 *   frontend to Vercel, returning the new deployment id to poll.
 * mode "patch": patch the files and return them WITHOUT deploying — used by the
 *   live preview to fix a failing WebContainer build in place.
 *
 * `attempt` escalates the search depth so successive retries dig deeper.
 */
export async function POST(req: NextRequest) {
  try {
    const {
      files,
      name,
      buildLog,
      error,
      backendUrl = null,
      attempt = 0,
      mode = "deploy",
      modelId = DEFAULT_REPAIR_MODEL,
      provider = DEFAULT_REPAIR_PROVIDER,
    } = (await req.json()) as {
      files: WorkspaceFile[];
      name?: string;
      buildLog?: string | string[];
      error?: string;
      backendUrl?: string | null;
      attempt?: number;
      mode?: "deploy" | "patch";
      modelId?: string;
      provider?: string;
    };

    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files to repair." }, { status: 400 });
    }
    const log = (Array.isArray(buildLog) ? buildLog.join("\n") : buildLog) || error;
    if (!log || !log.trim()) {
      return NextResponse.json({ error: "A build log or error message is required to repair." }, { status: 400 });
    }

    const src = files.map((f) => ({ path: f.path, content: f.content }));
    const fix = await autoFixBuildError({ files: src, errorLog: log, attempt, model: resolveModel(modelId, provider) });

    // Re-root the patched files back onto the workspace file shape (preserve id/name).
    const byPath = new Map(files.map((f) => [f.path, f] as const));
    const patchedWorkspace: WorkspaceFile[] = fix.files.map((f) => {
      const prev = byPath.get(f.path);
      return prev
        ? { ...prev, content: f.content }
        : { id: crypto.randomUUID(), name: f.path.split("/").pop() || f.path, path: f.path, content: f.content, language: "", isDirty: false };
    });

    if (!fix.changed) {
      return NextResponse.json({ changed: false, report: fix.report });
    }

    if (mode === "patch") {
      return NextResponse.json({ changed: true, report: fix.report, files: patchedWorkspace });
    }

    // mode "deploy": re-run the same frontend pipeline the deploy routes use,
    // then ship the patched build and hand back the id to poll.
    const front = prepareFrontendForVercel(
      patchedWorkspace.map((f) => ({ path: f.path, content: f.content })),
      backendUrl,
    );
    if (!front.found) {
      return NextResponse.json({ changed: true, report: fix.report, files: patchedWorkspace });
    }
    if (!serverToken("VERCEL_TOKEN")) {
      return NextResponse.json({ error: "VERCEL_TOKEN is not configured." }, { status: 500 });
    }
    const prep = prepareForDeploy(front.files);
    const result = await deployToVercel(prep.files as WorkspaceFile[], {
      name,
      framework: prep.framework,
      buildCommand: prep.buildCommand,
      outputDirectory: prep.outputDirectory,
      rootDirectory: prep.rootDirectory,
    });

    return NextResponse.json({
      changed: true,
      report: fix.report,
      files: patchedWorkspace,
      frontendId: result.id,
      frontendUrl: result.url,
    });
  } catch (error) {
    console.error("[deploy/repair]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
