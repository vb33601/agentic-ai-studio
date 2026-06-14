import { sandboxVerifyBuild, recipeFor, type SandboxFactory, type SandboxSession, type SandboxRunResult } from "./sandbox-verify";
import type { SrcFile } from "./truncation";
import type { Stack } from "./dockerfile";

/**
 * Real `@vercel/sandbox` adapter for the sandbox build-verifier.
 *
 * Auth follows the SAME pattern as the Vercel DEPLOY path: the project is created
 * on the go from the API key. `inferScope({ token })` resolves (and auto-creates) a
 * default sandbox project + team from `VERCEL_TOKEN` alone — no fixed
 * VERCEL_TEAM_ID/PROJECT_ID needed. (On Vercel, OIDC works automatically.)
 *
 * ACTIVATION is gated behind `SANDBOX_VERIFY` (truthy), NOT merely the presence of
 * the token — because the token is ALWAYS present (it's the deploy token), and a
 * sandbox `npm install` + build can exceed the deploy route's 60s budget on Hobby.
 * Default off ⇒ zero change to existing deploys. Turn it on where the runtime
 * budget allows (Render/Docker has no 60s cap).
 *
 * Everything is loaded dynamically and is server-only; `@vercel/sandbox` is in
 * next.config `serverExternalPackages` so it's never bundled.
 */

/** True when sandbox verification is explicitly enabled AND auth is available. */
export function isSandboxConfigured(): boolean {
  const flag = (process.env.SANDBOX_VERIFY || "").toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes";
  return enabled && (!!process.env.VERCEL_TOKEN || !!process.env.VERCEL_OIDC_TOKEN);
}

function vercelToken(): string {
  return (process.env.VERCEL_TOKEN || "").replace(/^"|"$/g, "");
}

// Resolved once per process: inferScope creates/reuses a default sandbox project.
let scopeCache: Promise<{ teamId: string; projectId: string }> | null = null;
async function resolveScope(token: string): Promise<{ teamId: string; projectId: string }> {
  if (!scopeCache) {
    scopeCache = (async () => {
      const auth = (await import("@vercel/sandbox/dist/auth/index.js")) as {
        inferScope: (o: { token: string }) => Promise<{ teamId: string; projectId: string }>;
      };
      const s = await auth.inferScope({ token });
      return { teamId: s.teamId, projectId: s.projectId };
    })().catch((e) => { scopeCache = null; throw e; });
  }
  return scopeCache;
}

// Structural view of the SDK surface we use (avoids a hard type dep).
interface SdkCommand { exitCode: number | null; stdout(): Promise<string>; stderr(): Promise<string>; }
interface SdkSandbox {
  writeFiles(files: Array<{ path: string; content: string }>): Promise<void>;
  runCommand(command: string, args?: string[], opts?: Record<string, unknown>): Promise<SdkCommand>;
  domain(port: number): string;
  stop(): Promise<void>;
}
interface SdkSandboxStatic { create(opts: Record<string, unknown>): Promise<SdkSandbox>; }

/** Create a real Vercel Sandbox session (token-only auth via inferScope). */
export const vercelSandboxFactory: SandboxFactory = async ({ runtime, timeoutMs, ports }): Promise<SandboxSession> => {
  const token = vercelToken();
  const mod = (await import("@vercel/sandbox")) as unknown as { Sandbox: SdkSandboxStatic };
  const opts: Record<string, unknown> = { runtime, timeout: timeoutMs };
  if (ports?.length) opts.ports = ports;
  if (token) {
    const scope = await resolveScope(token);
    opts.token = token;
    opts.teamId = scope.teamId;
    opts.projectId = scope.projectId;
  }
  const sandbox = await mod.Sandbox.create(opts);
  return {
    async writeFiles(files: SrcFile[]) {
      await sandbox.writeFiles(files.map((f) => ({ path: f.path, content: f.content })));
    },
    async run(cmd: string, args: string[]): Promise<SandboxRunResult> {
      const r = await sandbox.runCommand(cmd, args);
      return { exitCode: r.exitCode ?? 0, stdout: await r.stdout(), stderr: await r.stderr() };
    },
    domain(port: number) {
      return sandbox.domain(port);
    },
    async stop() {
      await sandbox.stop();
    },
  };
};

/** Thrown when the sandbox actually built the app and the BUILD failed (a real
 *  blocker), as opposed to the sandbox being unavailable (which is fail-open). */
export class SandboxBuildError extends Error {}

/**
 * Opt-in, fail-open pre-deploy sandbox gate for a call site.
 *  - Not enabled, or no recipe for the stack → returns the files unchanged
 *    (static gate still applies upstream).
 *  - Sandbox builds + the build FAILS → throws SandboxBuildError (block the deploy).
 *  - Sandbox infra/SDK error → returns the files unchanged (proceed; the remote
 *    build remains the backstop).
 * Returns the (possibly auto-fixed) files to deploy.
 */
export async function sandboxGate(files: SrcFile[], stack: Stack, label: string): Promise<SrcFile[]> {
  if (!isSandboxConfigured()) return files;
  const recipe = recipeFor(stack);
  if (!recipe) return files;
  try {
    const sv = await sandboxVerifyBuild({ files, recipe, factory: vercelSandboxFactory });
    if (!sv.ok) throw new SandboxBuildError(`${label} sandbox build failed: ${sv.blocker}`);
    return sv.files;
  } catch (e) {
    if (e instanceof SandboxBuildError) throw e; // real build failure → propagate (block)
    return files; // sandbox unavailable / SDK error → fail-open
  }
}
