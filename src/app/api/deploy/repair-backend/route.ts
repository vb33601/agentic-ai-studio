import { NextRequest, NextResponse } from "next/server";
import { autoFixBuildError } from "@/lib/ai/auto-fix";
import { resolveModel } from "@/lib/ai/providers";
import { fetchRepoFiles, commitFilesToRepo, parseRepoUrl, type RepoFile } from "@/lib/deploy/github";
import { getBackendErrorSignal } from "@/lib/deploy/backend-logs";
import { serverToken } from "@/lib/deploy/env";

const DEFAULT_REPAIR_MODEL = "openai/gpt-4o-mini";
const DEFAULT_REPAIR_PROVIDER = "kilocode";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

/**
 * Self-healing for a backend that builds but crashes at runtime (the gap the
 * frontend build-repair and the new health gate surface). Flow:
 *  1. read the ACTUAL deployed repo files (source of truth for the container),
 *  2. get the crash signal — real Render logs, else a synthesized hint + the
 *     failed health probe (Fly has no server-side log API),
 *  3. web-search + patch via the shared auto-fix engine,
 *  4. commit the edits back to the SAME repo → the existing Fly/Render service
 *     rebuilds in place at the SAME URL (so the already-deployed frontend stays
 *     wired to it — we must not spin up a new backend on a new URL).
 *
 * The caller (deploy panel) then re-polls /api/deploy/health on the same URL.
 */
export async function POST(req: NextRequest) {
  try {
    const {
      repoUrl,
      deployProvider,
      dashboardUrl = null,
      framework = null,
      httpStatus = null,
      bodySnippet = null,
      attempt = 0,
      dryRun = false,
      modelId = DEFAULT_REPAIR_MODEL,
      modelProvider = DEFAULT_REPAIR_PROVIDER,
    } = (await req.json()) as {
      repoUrl?: string;
      deployProvider?: string;
      dashboardUrl?: string | null;
      framework?: string | null;
      httpStatus?: number | null;
      bodySnippet?: string | null;
      attempt?: number;
      /** When true, compute + return the fix but do NOT commit it. */
      dryRun?: boolean;
      modelId?: string;
      modelProvider?: string;
    };

    if (!repoUrl) return NextResponse.json({ error: "repoUrl is required." }, { status: 400 });
    const token = serverToken("GITHUB_TOKEN");
    if (!token) return NextResponse.json({ error: "GITHUB_TOKEN is not configured on the server." }, { status: 400 });
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) return NextResponse.json({ error: `Could not parse a GitHub repo from "${repoUrl}".` }, { status: 400 });

    // 1) The code the container is actually running.
    const { files: repoFiles, branch } = await fetchRepoFiles(token, parsed.owner, parsed.repo);
    if (repoFiles.length === 0) return NextResponse.json({ error: "Repo had no readable source files." }, { status: 400 });

    // 2) Best available crash signal.
    const signal = await getBackendErrorSignal({ provider: deployProvider, dashboardUrl, framework, httpStatus, bodySnippet });

    // 3) Diagnose + patch.
    const fix = await autoFixBuildError({
      files: repoFiles,
      errorLog: signal.log,
      attempt,
      model: resolveModel(modelId, modelProvider),
    });

    // Commit only what actually changed.
    const origByPath = new Map(repoFiles.map((f) => [f.path, f.content] as const));
    const edited: RepoFile[] = fix.files.filter((f) => origByPath.get(f.path) !== f.content);

    if (!fix.changed || edited.length === 0) {
      return NextResponse.json({ changed: false, report: fix.report, logSource: signal.source });
    }

    if (dryRun) {
      return NextResponse.json({
        changed: true,
        dryRun: true,
        report: fix.report,
        editedPaths: edited.map((f) => f.path),
        files: edited,
        logSource: signal.source,
      });
    }

    // Only commit a fix the engine is confident about. A logless (synthesized)
    // signal — common for Fly, which has no server-side log API — can otherwise
    // yield a plausible-but-wrong edit (e.g. "change the port"), and committing
    // it churns the repo + a multi-minute rebuild for nothing.
    if (!fix.report.confident) {
      return NextResponse.json({
        changed: false,
        report: fix.report,
        logSource: signal.source,
        note: signal.source === "synthesized"
          ? "No log API for this provider and no high-confidence fix from source — open the dashboard logs."
          : "No high-confidence fix found.",
      });
    }

    // 4) Commit back → same service rebuilds at the same URL.
    const { commitSha } = await commitFilesToRepo(
      token,
      parsed.owner,
      parsed.repo,
      branch,
      edited,
      `Auto-repair: fix backend runtime crash (${fix.report.rootCause || "boot failure"})`.slice(0, 100),
    );

    return NextResponse.json({
      changed: true,
      report: fix.report,
      editedPaths: edited.map((f) => f.path),
      files: edited, // path is repo-relative (re-rooted to the backend dir)
      commitSha,
      logSource: signal.source,
    });
  } catch (error) {
    console.error("[deploy/repair-backend]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
