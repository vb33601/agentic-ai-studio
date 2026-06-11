import { NextRequest, NextResponse } from "next/server";
import { type RenderEnvVar } from "@/lib/deploy/render";
import { prepareBackendForRender, appDatabaseUrl } from "@/lib/deploy/render-prepare";
import { prepareForContainer } from "@/lib/deploy/universal-prepare";
import { detectStack } from "@/lib/deploy/dockerfile";
import { deployContainer } from "@/lib/deploy/providers/container-deploy";
import { configuredProviders } from "@/lib/deploy/providers/registry";
import { slugify } from "@/lib/utils";
import type { WorkspaceFile } from "@/store/workspace";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

/**
 * One-click "Deploy backend → Render", universal across languages.
 *
 *  - Node backends take the optimized NATIVE path (Prisma/CORS/$PORT wiring).
 *  - Every other stack (Django, Rails, Spring, Laravel, Go, Rust, .NET, …) takes
 *    the universal DOCKER path: a framework-aware, $PORT-bound Dockerfile is
 *    generated and Render builds it via its Docker runtime.
 *
 * Both push to a fresh GitHub repo (Render builds from a repo) and wire the
 * managed Postgres when a DB driver is detected.
 *
 * Requires server env: GITHUB_TOKEN, RENDER_API_KEY, DEFAULT_DATABASE_URL.
 */
export async function POST(req: NextRequest) {
  try {
    const { files, name } = (await req.json()) as { files: WorkspaceFile[]; name?: string };

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) return NextResponse.json({ error: "GITHUB_TOKEN is not configured on the server." }, { status: 400 });
    // At least one container provider (Render, Railway, or Fly) must have credentials.
    if (!configuredProviders().some((p) => p === "render" || p === "railway" || p === "fly")) {
      return NextResponse.json({ error: "No backend provider configured. Set RENDER_API_KEY, RAILWAY_API_TOKEN, or FLY_API_TOKEN." }, { status: 400 });
    }
    if (!Array.isArray(files) || files.length === 0) return NextResponse.json({ error: "No files to deploy." }, { status: 400 });

    const base = (slugify(name || "ai-backend") || "ai-backend").slice(0, 70);
    const projectName = `${base}-${Math.random().toString(36).slice(2, 7)}`;
    const repoFiles = files.map((f) => ({ path: f.path, content: f.content }));
    const dbUrl = process.env.DEFAULT_DATABASE_URL;
    const stack = detectStack(repoFiles);

    // ---------- Node backends: optimized native runtime ----------
    if (stack === "node") {
      const prep = prepareBackendForRender(repoFiles);
      if (!prep.hasBackend) {
        return NextResponse.json(
          { error: "No runnable backend found (no server entry, backend dependencies, or Prisma schema). This looks like a frontend-only app — deploy it to Vercel instead, or generate a backend first." },
          { status: 400 },
        );
      }
      const envVars: RenderEnvVar[] = [
        { key: "NODE_ENV", value: "production" },
        { key: "NODE_VERSION", value: "22" },
      ];
      if (prep.usesPrisma && dbUrl) envVars.push({ key: "DATABASE_URL", value: appDatabaseUrl(dbUrl, projectName) });

      const result = await deployContainer({
        githubToken, name: projectName, files: prep.files, runtime: "node",
        buildCommand: prep.buildCommand, startCommand: prep.startCommand, envVars,
      });
      return NextResponse.json({
        provider: result.provider, url: result.url, dashboardUrl: result.dashboardUrl, repoUrl: result.repoUrl,
        runtime: "node", framework: "node", usesPrisma: prep.usesPrisma,
        dbWired: prep.usesPrisma && !!dbUrl, backendDir: prep.backendDir,
        warnings: [...prep.warnings, ...result.fallbacksTried],
      });
    }

    // ---------- Any other language: universal Docker runtime ----------
    const prep = prepareForContainer(repoFiles);
    const envVars: RenderEnvVar[] = [];
    const dbWired = prep.needsDatabase && !!dbUrl;
    if (dbWired) envVars.push({ key: "DATABASE_URL", value: appDatabaseUrl(dbUrl!, projectName) });

    const result = await deployContainer({
      githubToken, name: projectName, files: prep.files, runtime: "docker",
      dockerfilePath: prep.dockerfilePath, envVars,
      description: `Container deploy (${prep.plan.label}/${prep.plan.framework}) from agentic-ai-studio`,
    });

    return NextResponse.json({
      provider: result.provider, url: result.url, dashboardUrl: result.dashboardUrl, repoUrl: result.repoUrl,
      runtime: "docker", framework: prep.plan.framework, stack: prep.plan.stack,
      usesPrisma: false, dbWired, warnings: [...prep.notes, ...result.fallbacksTried],
    });
  } catch (error) {
    console.error("[deploy/render]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
