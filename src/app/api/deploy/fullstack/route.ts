import { NextRequest, NextResponse } from "next/server";
import { createRepoAndPush } from "@/lib/deploy/github";
import { createRenderService, updateRenderEnvVars, type RenderEnvVar } from "@/lib/deploy/render";
import { prepareBackendForRender, appDatabaseUrl } from "@/lib/deploy/render-prepare";
import { prepareFrontendForVercel } from "@/lib/deploy/frontend-prepare";
import { prepareForDeploy } from "@/lib/deploy/prepare";
import { deployToVercel } from "@/lib/deploy/vercel";
import { slugify } from "@/lib/utils";
import type { WorkspaceFile } from "@/store/workspace";

export const maxDuration = 120;

/**
 * Full-stack one-click deploy: backend → Render (wired to Aiven Postgres),
 * frontend → Vercel (wired to the backend URL). Returns the frontend link.
 * Best-effort per side — if one fails, the other still deploys and the error is
 * reported.
 */
export async function POST(req: NextRequest) {
  try {
    const { files, name } = (await req.json()) as { files: WorkspaceFile[]; name?: string };
    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files to deploy." }, { status: 400 });
    }
    const slug = (slugify(name || "ai-app") || "ai-app").slice(0, 70);
    // Unique backend name so repeated deploys never collide with an existing repo/service.
    const backendName = `${slug}-api-${Math.random().toString(36).slice(2, 7)}`;
    const repoFiles = files.map((f) => ({ path: f.path, content: f.content }));

    // The frontend's Vercel project name is the slug, so its production URL is
    // predictable BEFORE it deploys. We seed the backend's CORS_ORIGIN with it so
    // cross-origin calls work on the first boot, then reconcile with the actual
    // URL after the frontend deploys (below). Dynamic URLs, wired both ways.
    const predictedFrontendUrl = `https://${slug}.vercel.app`;

    let backendId: string | null = null;
    let backendUrl: string | null = null;
    let backendDashboard: string | null = null;
    let repoUrl: string | null = null;
    let dbWired = false;
    let backendError: string | null = null;

    // ---- Backend → Render ----
    const backendPrep = prepareBackendForRender(repoFiles);
    // Only deploy a backend when there's actually a runnable server — a
    // frontend-only app (or a monorepo whose backend/ was never generated)
    // would just crash Render at startup with "Cannot find module".
    const hasBackend = backendPrep.hasBackend;
    if (hasBackend) {
      try {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error("GITHUB_TOKEN is not configured.");
        if (!process.env.RENDER_API_KEY) throw new Error("RENDER_API_KEY is not configured.");
        const repo = await createRepoAndPush(token, backendName, backendPrep.files, {
          private: true,
          description: "Backend deployed from agentic-ai-studio",
        });
        repoUrl = repo.htmlUrl;
        // Pin Node 22 LTS. Render defaults to Node 24, which has no prebuilt
        // binaries for common native deps (e.g. better-sqlite3) and fails to
        // compile them; 22 has prebuilts and runs everything generated apps use.
        const envVars: RenderEnvVar[] = [
          { key: "NODE_ENV", value: "production" },
          { key: "NODE_VERSION", value: "22" },
          // CORS allow-list for the frontend (honored by the wired backend).
          // FRONTEND_URL is exposed too for apps that read their own client URL.
          { key: "CORS_ORIGIN", value: predictedFrontendUrl },
          { key: "FRONTEND_URL", value: predictedFrontendUrl },
        ];
        const dbUrl = process.env.DEFAULT_DATABASE_URL;
        if (backendPrep.usesPrisma && dbUrl) { envVars.push({ key: "DATABASE_URL", value: appDatabaseUrl(dbUrl, backendName) }); dbWired = true; }
        const svc = await createRenderService({
          name: backendName,
          repo: repo.htmlUrl,
          branch: repo.branch,
          buildCommand: backendPrep.buildCommand,
          startCommand: backendPrep.startCommand,
          envVars,
        });
        backendId = svc.id;
        backendUrl = svc.url;
        backendDashboard = svc.dashboardUrl;
      } catch (e) {
        backendError = e instanceof Error ? e.message : String(e);
      }
    }

    // ---- Frontend → Vercel (wired to the backend URL) ----
    let frontendUrl: string | null = null;
    let frontendError: string | null = null;
    const front = prepareFrontendForVercel(repoFiles, backendUrl);
    if (front.found) {
      try {
        if (!process.env.VERCEL_TOKEN) throw new Error("VERCEL_TOKEN is not configured.");
        const prep = prepareForDeploy(front.files);
        const result = await deployToVercel(prep.files as WorkspaceFile[], {
          name: slug,
          framework: prep.framework,
          buildCommand: prep.buildCommand,
          outputDirectory: prep.outputDirectory,
          rootDirectory: prep.rootDirectory,
        });
        frontendUrl = result.url;
      } catch (e) {
        frontendError = e instanceof Error ? e.message : String(e);
      }
    }

    // Reconcile: if the frontend's real URL differs from what we predicted (or
    // the deployment URL differs from the production alias), update the backend's
    // CORS allow-list to include both and redeploy. Best-effort — never fails the
    // deploy. Allowing both the production alias and the immutable deploy URL
    // means the frontend works however the user reaches it.
    let corsReconciled = false;
    if (backendId && frontendUrl) {
      const origins = Array.from(new Set([predictedFrontendUrl, frontendUrl])).join(",");
      if (origins !== predictedFrontendUrl) {
        corsReconciled = await updateRenderEnvVars(backendId, [
          { key: "CORS_ORIGIN", value: origins },
          { key: "FRONTEND_URL", value: frontendUrl },
        ]);
      }
    }

    if (!hasBackend && !front.found) {
      return NextResponse.json({ error: "No frontend or backend found in the selected files." }, { status: 400 });
    }

    return NextResponse.json({
      frontendUrl,
      backendUrl,
      backendDashboard,
      repoUrl,
      dbWired,
      corsReconciled,
      backendDir: backendPrep.backendDir,
      frontendDir: front.dir,
      backendError,
      frontendError,
      warnings: hasBackend ? backendPrep.warnings : [],
    });
  } catch (error) {
    console.error("[deploy/fullstack]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
