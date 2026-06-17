/**
 * LOCAL BUILD/BOOT CERTIFIER (Phase 2).
 *
 * Runs the edit-loop's file set through the existing sandbox build-verifier
 * (`sandbox-verify.ts`): install → build → boot+smoke in an ephemeral microVM,
 * using the SAME per-stack recipes the deploy gate uses. This is the "certify it
 * actually works locally" step — truth now comes from REALLY running the app, not
 * from regex. The real compiler/runtime errors it returns are fed back into the
 * edit loop so the model fixes them BEFORE the user ever deploys (dyad's
 * generateProblemReport pattern, but stack-agnostic).
 *
 * Fail-open + optional: when no sandbox is configured (or the stack has no recipe,
 * or the toolchain can't be provisioned) it cleanly reports `ran:false, ok:true`,
 * so the build proceeds on the structural verdict alone. The SandboxFactory is
 * injectable, so the whole flow is unit-testable offline (see test-agent-loop).
 */
import { sandboxVerifyBuild, recipeFor, type SandboxFactory, type SandboxVerifyResult } from "@/lib/deploy/sandbox-verify";
import { detectStackPlan, type Stack } from "@/lib/deploy/dockerfile";
import { isSandboxConfigured, vercelSandboxFactory } from "@/lib/deploy/vercel-sandbox-runner";
import type { VFile } from "./vfs";

export interface CertifyResult {
  /** False = skipped (no sandbox / no recipe / toolchain unavailable). */
  ran: boolean;
  /** Build (and, when defined, boot/smoke) passed. */
  ok: boolean;
  /** Concise compiler/runtime errors for the edit loop (empty when ok). */
  errors: string[];
  /** Raw failing log tail (diagnostic). */
  log: string;
  stack: string;
  runOk?: boolean;
  runWarning?: string;
}

/** Pull the meaningful error lines out of a failing build log + blocker. */
export function errorsFromLog(r: SandboxVerifyResult): string[] {
  const lines = `${r.blocker}\n${r.log}`.split("\n").map((l) => l.trim()).filter(Boolean);
  // Prefer lines that name a real error; fall back to the log tail.
  const flagged = lines.filter((l) => /\b(error|failed|cannot|not found|undefined|unexpected|exception|panic|traceback|ERR!|TS\d{3,}|exit code [1-9])\b/i.test(l));
  const picked = (flagged.length ? flagged : lines).slice(-12);
  // De-dupe consecutive repeats and cap length.
  const out: string[] = [];
  for (const l of picked) if (out[out.length - 1] !== l) out.push(l.slice(0, 300));
  return out;
}

export interface CertifyOpts {
  /** Override the sandbox factory (tests inject a fake). */
  factory?: SandboxFactory;
  /** Override the detected stack. */
  stack?: Stack;
  maxAttempts?: number;
  sandboxTimeoutMs?: number;
}

export async function certifyFiles(files: VFile[], opts: CertifyOpts = {}): Promise<CertifyResult> {
  const stack = opts.stack ?? detectStackPlan(files).stack;
  const recipe = recipeFor(stack);
  const factory = opts.factory ?? (isSandboxConfigured() ? vercelSandboxFactory : null);
  if (!recipe || !factory) return { ran: false, ok: true, errors: [], log: "", stack };

  try {
    const r = await sandboxVerifyBuild({
      files,
      recipe,
      factory,
      maxAttempts: opts.maxAttempts ?? 1, // the edit loop does the fixing, not the auto-fixers
      sandboxTimeoutMs: opts.sandboxTimeoutMs,
    });
    if (r.setupSkipped) return { ran: false, ok: true, errors: [], log: "", stack };
    // A green build passes; a build that boots but doesn't answer is a soft warning
    // (don't fail the cert on a flaky boot probe — start-cmd/port heuristics vary).
    const ok = r.ok;
    return {
      ran: true,
      ok,
      errors: ok ? [] : errorsFromLog(r),
      log: ok ? "" : r.log,
      stack,
      runOk: r.runOk,
      runWarning: r.runWarning,
    };
  } catch (e) {
    // Fail-open: a sandbox/orchestration error must never block the build.
    return { ran: false, ok: true, errors: [], log: String((e as Error)?.message ?? e), stack };
  }
}

/** Build the fix instruction fed back into the edit loop when certification fails. */
export function buildCertifyFixPrompt(result: CertifyResult): string {
  return [
    `The app was built and run in a sandbox and the BUILD FAILED. Fix the errors below by editing the project files, then it must compile and run.`,
    ``,
    `Stack: ${result.stack}`,
    `Errors:`,
    ...result.errors.map((e) => `- ${e}`),
    ``,
    `Edit the relevant files to resolve every error. Do not introduce placeholders. Keep the app runnable.`,
  ].join("\n");
}
