import { sandboxVerifyBuild, recipeFor, type SandboxFactory, type SandboxSession, type SandboxRunResult } from "./sandbox-verify";
import type { SrcFile } from "./truncation";
import type { Stack } from "./dockerfile";

/**
 * Real `@vercel/sandbox` adapter for the sandbox build-verifier.
 *
 * Kept deliberately separate from the orchestration (sandbox-verify.ts) so the only
 * code that touches the network/SDK is here, behind a LAZY dynamic import:
 *  - `@vercel/sandbox` is an OPTIONAL dependency. If it isn't installed, the import
 *    throws and `isSandboxConfigured()` returns false → the caller skips the sandbox
 *    tier entirely (the static gate still runs). So the repo builds and deploys
 *    fine without the package.
 *
 * To ACTIVATE this tier:
 *   1) `npm i @vercel/sandbox`
 *   2) set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID (on Vercel, OIDC is
 *      automatic and the team/project are implicit).
 *
 * Server-only.
 */

/** True when the env is set up to create sandboxes (the package is checked lazily). */
export function isSandboxConfigured(): boolean {
  // On Vercel, OIDC is automatic (VERCEL_OIDC_TOKEN); otherwise need explicit creds.
  const hasOidc = !!process.env.VERCEL_OIDC_TOKEN;
  const hasExplicit = !!(process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID);
  return hasOidc || hasExplicit;
}

function credentials(): Record<string, string> {
  if (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID) {
    return {
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    };
  }
  return {}; // fall back to OIDC on Vercel
}

// Minimal structural types for the bits of the SDK we use (avoids a hard dep on the
// package's types, which may be absent at typecheck time).
interface SdkRunResult {
  exitCode?: number;
  stdout?: () => Promise<string>;
  stderr?: () => Promise<string>;
}
interface SdkSandbox {
  writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void>;
  runCommand(cmd: string, args: string[]): Promise<SdkRunResult>;
  stop(): Promise<void>;
}
interface SdkSandboxStatic {
  create(opts: Record<string, unknown>): Promise<SdkSandbox>;
}

/**
 * Create a real Vercel Sandbox session. Throws if the SDK isn't installed or
 * sandbox creation fails — the caller is expected to gate on `isSandboxConfigured()`
 * and treat any throw as "skip the sandbox tier" (fail-open).
 */
export const vercelSandboxFactory: SandboxFactory = async ({ runtime, timeoutMs }): Promise<SandboxSession> => {
  // Lazy import via a RUNTIME-CONSTRUCTED specifier so the bundler (Turbopack/
  // webpack) can't statically resolve it — the optional dep being absent must never
  // break `next build`. Throws at runtime if not installed; the caller treats that
  // as "skip the sandbox tier" (fail-open).
  const spec = ["@vercel", "sandbox"].join("/");
  const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ spec)) as { Sandbox: SdkSandboxStatic };
  const sandbox = await mod.Sandbox.create({ ...credentials(), runtime, timeout: timeoutMs });

  return {
    async writeFiles(files: SrcFile[]) {
      await sandbox.writeFiles(files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8") })));
    },
    async run(cmd: string, args: string[]): Promise<SandboxRunResult> {
      const r = await sandbox.runCommand(cmd, args);
      const stdout = r.stdout ? await r.stdout() : "";
      const stderr = r.stderr ? await r.stderr() : "";
      return { exitCode: r.exitCode ?? 0, stdout, stderr };
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
 *  - No sandbox configured, or no recipe for the stack → returns the files unchanged
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
