import { createRepoAndPush, type RepoFile } from "../github";
import { createRenderService, type RenderEnvVar } from "../render";
import { detectStackPlan } from "../dockerfile";
import { bindDualStack } from "../universal-prepare";
import { deployToRailway } from "./railway";
import { deployToFly } from "./fly";
import { isConfigured } from "./registry";
import type { ProviderId } from "./types";
import { verifyRelease, type ReleaseStatus, type VerifyRef, type PollOptions } from "../verify-release";

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
  /**
   * Force a specific container provider instead of the render→railway→fly
   * fallback. When set, ONLY that provider is tried (so "deploy to Fly" means
   * Fly — errors surface instead of silently landing on Render).
   */
  provider?: ProviderId;
  /**
   * When set, poll the chosen provider after triggering the deploy until the
   * release goes live / fails / times out, and attach the result. Best-effort —
   * a verification problem never fails the deploy. Omit to skip (fire-and-forget).
   */
  verify?: PollOptions;
}

export interface ContainerDeployResult {
  provider: ProviderId;
  url: string;
  dashboardUrl: string;
  repoUrl: string;
  /** Providers that were tried and failed before this one succeeded. */
  fallbacksTried: string[];
  /** Post-deploy release verification, when `input.verify` was requested. */
  verification?: ReleaseStatus;
  /** Provider advisories (e.g. Fly falling back to the push trigger). */
  notes?: string[];
}

const BACKEND_ORDER: ProviderId[] = ["render", "railway", "fly"];

export async function deployContainer(input: ContainerDeployInput): Promise<ContainerDeployResult> {
  // Explicit provider → try only that one; otherwise the configured fallback chain.
  let candidates: ProviderId[];
  if (input.provider) {
    if (!BACKEND_ORDER.includes(input.provider)) {
      throw new Error(`"${input.provider}" is not a container backend provider (use render, railway, or fly).`);
    }
    if (!isConfigured(input.provider)) {
      throw new Error(
        `Provider "${input.provider}" isn't configured on the server — set its credentials ` +
          `(${input.provider === "fly" ? "FLY_API_TOKEN + GITHUB_TOKEN (Contents/Workflows/Secrets)" : input.provider === "railway" ? "RAILWAY_API_TOKEN + GITHUB_TOKEN" : "RENDER_API_KEY + GITHUB_TOKEN"}).`,
      );
    }
    candidates = [input.provider];
  } else {
    candidates = BACKEND_ORDER.filter(isConfigured);
    if (candidates.length === 0) {
      throw new Error(
        "No container deploy provider is configured. Set RENDER_API_KEY (+GITHUB_TOKEN), RAILWAY_API_TOKEN (+GITHUB_TOKEN), or FLY_API_TOKEN (+GITHUB_TOKEN).",
      );
    }
  }

  // Fly builds a Docker IMAGE from the repo, so it REQUIRES a Dockerfile. The Node
  // backend path produces Render-native build/start commands and ships no
  // Dockerfile — which made `flyctl deploy` fail with "Dockerfile not found" and
  // the Fly app hang at 0 machines (the silent Fly failure). Synthesize one (the
  // universal engine's image for the detected stack, dual-stack-bound for Fly's
  // IPv6 proxy) whenever Fly is a candidate and the repo has none. Safe for the
  // other providers: Render selects native-vs-docker by `runtime` and ignores a
  // stray Dockerfile for runtime:node; Railway builds via Railpack.
  let files = input.files;
  if (candidates.includes("fly") && !files.some((f) => f.path === "Dockerfile")) {
    const plan = detectStackPlan(files);
    files = [
      ...files,
      { path: "Dockerfile", content: bindDualStack(plan.dockerfile) },
      ...(files.some((f) => f.path === ".dockerignore") ? [] : [{ path: ".dockerignore", content: plan.dockerignore }]),
    ];
  }

  // Push the repo once; every candidate builds from it.
  const repo = await createRepoAndPush(input.githubToken, input.name, files, {
    private: true,
    description: input.description || "Deployed from agentic-ai-studio",
  });

  // Attach post-deploy release verification (best-effort) before returning, so a
  // deploy that builds-then-dies isn't reported as success and silently strands.
  const finalize = async (result: ContainerDeployResult, ref: VerifyRef): Promise<ContainerDeployResult> =>
    input.verify ? { ...result, verification: await verifyRelease(ref, input.verify) } : result;

  const failures: string[] = [];
  for (const provider of candidates) {
    try {
      if (provider === "render") {
        const svc = await createRenderService({
          name: input.name, repo: repo.htmlUrl, branch: repo.branch,
          runtime: input.runtime, buildCommand: input.buildCommand, startCommand: input.startCommand,
          dockerfilePath: input.dockerfilePath, envVars: input.envVars,
        });
        return await finalize(
          { provider, url: svc.url, dashboardUrl: svc.dashboardUrl, repoUrl: repo.htmlUrl, fallbacksTried: failures },
          { provider: "render", serviceId: svc.id, deployId: svc.deployId },
        );
      }
      if (provider === "railway") {
        const r = await deployToRailway({
          repo: `${repo.owner}/${repo.repo}`, branch: repo.branch, name: input.name, envVars: input.envVars,
        });
        return await finalize(
          { provider, url: r.url, dashboardUrl: r.dashboardUrl, repoUrl: repo.htmlUrl, fallbacksTried: failures },
          { provider: "railway", serviceId: r.serviceId },
        );
      }
      if (provider === "fly") {
        // Fly builds via a remote-build GitHub Actions workflow (no Docker here);
        // the release finishes asynchronously, like Render/Railway after create.
        // fly.toml's internal_port must match the Dockerfile's port → detect it.
        const port = detectStackPlan(files).port;
        const r = await deployToFly({
          githubToken: input.githubToken, repoOwner: repo.owner, repoName: repo.repo,
          branch: repo.branch, name: input.name, envVars: input.envVars, port,
        });
        return await finalize(
          { provider, url: r.url, dashboardUrl: r.dashboardUrl, repoUrl: repo.htmlUrl, fallbacksTried: failures, notes: r.notes },
          { provider: "fly", appName: r.appName },
        );
      }
    } catch (e) {
      failures.push(`${provider}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(`All container providers failed. ${failures.join(" | ")}`.slice(0, 500));
}
