import { NextRequest, NextResponse } from "next/server";
import { createRepoAndPush } from "@/lib/deploy/github";
import { createRenderService, type RenderEnvVar } from "@/lib/deploy/render";
import { prepareBackendForRender } from "@/lib/deploy/render-prepare";
import { slugify } from "@/lib/utils";
import type { WorkspaceFile } from "@/store/workspace";

export const maxDuration = 120;

/**
 * One-click "Deploy backend → Render". Pushes the selected backend folder to a
 * GitHub repo (Render builds from a repo), then creates a Render Node service
 * wired to the platform's managed Postgres (DEFAULT_DATABASE_URL = Aiven).
 *
 * Requires server env: GITHUB_TOKEN, RENDER_API_KEY, DEFAULT_DATABASE_URL.
 */
export async function POST(req: NextRequest) {
  try {
    const { files, name } = (await req.json()) as { files: WorkspaceFile[]; name?: string };

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) return NextResponse.json({ error: "GITHUB_TOKEN is not configured on the server." }, { status: 400 });
    if (!process.env.RENDER_API_KEY) return NextResponse.json({ error: "RENDER_API_KEY is not configured." }, { status: 400 });
    if (!Array.isArray(files) || files.length === 0) return NextResponse.json({ error: "No files to deploy." }, { status: 400 });

    const projectName = (slugify(name || "ai-backend") || "ai-backend").slice(0, 90);

    // Prepare: auto-detect the backend folder (even inside a parent/monorepo
    // selection), re-root, swap Prisma sqlite→postgres, bind $PORT, derive cmds.
    const prep = prepareBackendForRender(files.map((f) => ({ path: f.path, content: f.content })));
    if (!prep.files.some((f) => f.path === "package.json")) {
      return NextResponse.json(
        { error: "Couldn't find a backend (no package.json) in the selected folder. Generate a backend or pick a folder that contains one." },
        { status: 400 },
      );
    }

    // Push to a fresh repo.
    const repo = await createRepoAndPush(githubToken, projectName, prep.files, {
      private: true,
      description: "Backend deployed from agentic-ai-studio",
    });

    const envVars: RenderEnvVar[] = [{ key: "NODE_ENV", value: "production" }];
    const dbUrl = process.env.DEFAULT_DATABASE_URL;
    if (prep.usesPrisma && dbUrl) envVars.push({ key: "DATABASE_URL", value: dbUrl });

    const service = await createRenderService({
      name: projectName,
      repo: repo.htmlUrl,
      branch: repo.branch,
      buildCommand: prep.buildCommand,
      startCommand: prep.startCommand,
      envVars,
    });

    return NextResponse.json({
      url: service.url,
      dashboardUrl: service.dashboardUrl,
      repoUrl: repo.htmlUrl,
      usesPrisma: prep.usesPrisma,
      dbWired: prep.usesPrisma && !!dbUrl,
      backendDir: prep.backendDir,
    });
  } catch (error) {
    console.error("[deploy/render]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
