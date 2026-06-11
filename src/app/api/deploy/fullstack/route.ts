import { NextRequest, NextResponse } from "next/server";
import { createRepoAndPush } from "@/lib/deploy/github";
import { createRenderService, type RenderEnvVar } from "@/lib/deploy/render";
import { prepareBackendForRender, appDatabaseUrl } from "@/lib/deploy/render-prepare";
import { prepareForContainer, findBackendRoot } from "@/lib/deploy/universal-prepare";
import { detectStack } from "@/lib/deploy/dockerfile";
import { prepareFrontendForVercel } from "@/lib/deploy/frontend-prepare";
import { prepareForDeploy } from "@/lib/deploy/prepare";
import { deployToVercel } from "@/lib/deploy/vercel";
import { slugify } from "@/lib/utils";
import type { WorkspaceFile } from "@/store/workspace";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

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
    // predictable. We expose it to the backend as FRONTEND_URL and seed CORS_ORIGIN
    // with it. (The backend also reflects any *.vercel.app origin, so the immutable
    // per-deploy URL works too without a second deploy.)
    const predictedFrontendUrl = `https://${slug}.vercel.app`;

    let backendUrl: string | null = null;
    let backendDashboard: string | null = null;
    let repoUrl: string | null = null;
    let dbWired = false;
    let backendError: string | null = null;
    // Why no backend service was created, when there isn't one (so the UI can
    // explain it instead of silently shipping only the frontend).
    let backendNote: string | null = null;

    // ---- Backend → Render ----
    // Node backends take the optimized native path. Non-Node backends (Django,
    // Rails, Spring, Laravel, Go, .NET, …) — even when they sit in a backend/
    // subdir next to a JS frontend — take the universal Docker path.
    const backendPrep = prepareBackendForRender(repoFiles);
    let hasBackend = backendPrep.hasBackend;
    let backendDir = backendPrep.backendDir;
    let backendWarnings: string[] = backendPrep.hasBackend ? backendPrep.warnings : [];

    // Non-Node container backend detection (only when no Node backend was found).
    const containerRoot = !hasBackend ? findBackendRoot(repoFiles) : null;
    const container = containerRoot && detectStack(containerRoot.files) !== "node"
      ? { dir: containerRoot.dir, prep: prepareForContainer(containerRoot.files) }
      : null;
    if (container) { hasBackend = true; backendDir = container.dir; backendWarnings = container.prep.notes; }

    if (!hasBackend) {
      backendNote =
        "No backend/server was detected in the selected files (no Express/Fastify/Prisma/Django/Rails/Spring/etc. or server entry), so only the frontend was deployed. If this app should have a backend, ask the builder to generate it, then redeploy.";
    }
    if (hasBackend) {
      try {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error("GITHUB_TOKEN is not configured on the server — set it in the platform host's environment to enable backend deploys.");
        if (!process.env.RENDER_API_KEY) throw new Error("RENDER_API_KEY is not configured on the server — set it in the platform host's environment to enable backend deploys.");
        const dbUrl = process.env.DEFAULT_DATABASE_URL;

        if (container) {
          // ---- Universal Docker backend ----
          const repo = await createRepoAndPush(token, backendName, container.prep.files, {
            private: true,
            description: `Container backend (${container.prep.plan.framework}) deployed from agentic-ai-studio`,
          });
          repoUrl = repo.htmlUrl;
          const envVars: RenderEnvVar[] = [
            { key: "CORS_ORIGIN", value: predictedFrontendUrl },
            { key: "FRONTEND_URL", value: predictedFrontendUrl },
          ];
          if (container.prep.needsDatabase && dbUrl) { envVars.push({ key: "DATABASE_URL", value: appDatabaseUrl(dbUrl, backendName) }); dbWired = true; }
          const svc = await createRenderService({
            name: backendName, repo: repo.htmlUrl, branch: repo.branch,
            runtime: "docker", dockerfilePath: container.prep.dockerfilePath, envVars,
          });
          backendUrl = svc.url;
          backendDashboard = svc.dashboardUrl;
        } else {
          // ---- Optimized Node backend ----
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
          if (backendPrep.usesPrisma && dbUrl) { envVars.push({ key: "DATABASE_URL", value: appDatabaseUrl(dbUrl, backendName) }); dbWired = true; }
          const svc = await createRenderService({
            name: backendName, repo: repo.htmlUrl, branch: repo.branch,
            runtime: "node", buildCommand: backendPrep.buildCommand, startCommand: backendPrep.startCommand, envVars,
          });
          backendUrl = svc.url;
          backendDashboard = svc.dashboardUrl;
        }
      } catch (e) {
        backendError = e instanceof Error ? e.message : String(e);
      }
    }

    // ---- Frontend → Vercel (wired to the backend URL) ----
    let frontendUrl: string | null = null;
    let frontendId: string | null = null;
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
        // The Vercel build runs async — return the id so the client can poll it
        // to readiness instead of optimistically reporting "live".
        frontendId = result.id;
      } catch (e) {
        frontendError = e instanceof Error ? e.message : String(e);
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
      backendDir,
      backendRuntime: container ? "docker" : "node",
      backendFramework: container ? container.prep.plan.framework : "node",
      frontendDir: front.dir,
      hasBackend,
      backendError,
      backendNote,
      frontendId,
      frontendError,
      warnings: hasBackend ? backendWarnings : [],
    });
  } catch (error) {
    console.error("[deploy/fullstack]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
