import { createRepoAndPush, type RepoFile } from "../github";
import { createRenderService, type RenderEnvVar } from "../render";
import { detectStackPlan } from "../dockerfile";
import { deployToRailway } from "./railway";
import { deployToFly } from "./fly";
import { isConfigured } from "./registry";
import type { ProviderId } from "./types";

/**
 * Container-deploy orchestrator — the runtime side of the provider router.
 *
 * Pushes the prepared repo ONCE, then deploys it to the best available
 * container provider with ordered fallback (Render → Railway → …). Both build
 * from the Git repo, so a single push serves whichever provider wins. If the
 * preferred provider isn't configured or errors (e.g. Render free-tier limit),
 * the next candidate is tried automatically — so a deploy succeeds as long as
 * ANY capable provider has credentials.
 */

export interface ContainerDeployInput {
  githubToken: string;
  name: string;
  files: RepoFile[];
  description?: string;
  /** Render native (Node) vs Docker; ignored by Railpack-based providers. */
  runtime: "node" | "docker";
  buildCommand?: string;
  startCommand?: string;
  dockerfilePath?: string;
  envVars: RenderEnvVar[];
}

export interface ContainerDeployResult {
  provider: ProviderId;
  url: string;
  dashboardUrl: string;
  repoUrl: string;
  /** Providers that were tried and failed before this one succeeded. */
  fallbacksTried: string[];
}

const BACKEND_ORDER: ProviderId[] = ["render", "railway", "fly"];

export async function deployContainer(input: ContainerDeployInput): Promise<ContainerDeployResult> {
  const candidates = BACKEND_ORDER.filter(isConfigured);
  if (candidates.length === 0) {
    throw new Error(
      "No container deploy provider is configured. Set RENDER_API_KEY (+GITHUB_TOKEN), RAILWAY_API_TOKEN (+GITHUB_TOKEN), or FLY_API_TOKEN (+GITHUB_TOKEN).",
    );
  }

  // Push the repo once; every candidate builds from it.
  const repo = await createRepoAndPush(input.githubToken, input.name, input.files, {
    private: true,
    description: input.description || "Deployed from agentic-ai-studio",
  });

  const failures: string[] = [];
  for (const provider of candidates) {
    try {
      if (provider === "render") {
        const svc = await createRenderService({
          name: input.name, repo: repo.htmlUrl, branch: repo.branch,
          runtime: input.runtime, buildCommand: input.buildCommand, startCommand: input.startCommand,
          dockerfilePath: input.dockerfilePath, envVars: input.envVars,
        });
        return { provider, url: svc.url, dashboardUrl: svc.dashboardUrl, repoUrl: repo.htmlUrl, fallbacksTried: failures };
      }
      if (provider === "railway") {
        const r = await deployToRailway({
          repo: `${repo.owner}/${repo.repo}`, branch: repo.branch, name: input.name, envVars: input.envVars,
        });
        return { provider, url: r.url, dashboardUrl: r.dashboardUrl, repoUrl: repo.htmlUrl, fallbacksTried: failures };
      }
      if (provider === "fly") {
        // Fly builds via a remote-build GitHub Actions workflow (no Docker here);
        // the release finishes asynchronously, like Render/Railway after create.
        // fly.toml's internal_port must match the Dockerfile's port → detect it.
        const port = detectStackPlan(input.files).port;
        const r = await deployToFly({
          githubToken: input.githubToken, repoOwner: repo.owner, repoName: repo.repo,
          branch: repo.branch, name: input.name, envVars: input.envVars, port,
        });
        return { provider, url: r.url, dashboardUrl: r.dashboardUrl, repoUrl: repo.htmlUrl, fallbacksTried: failures };
      }
    } catch (e) {
      failures.push(`${provider}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(`All container providers failed. ${failures.join(" | ")}`.slice(0, 500));
}
