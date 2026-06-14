import type { SrcFile } from "./truncation";
import { repairTruncatedSource } from "./truncation";
import { matchKnownFix, unmatchedFailure, type FixRule } from "./fix-registry";
import type { Stack } from "./dockerfile";

/**
 * Sandbox build-verifier — the dynamic tier of the build → verify → fix loop
 * (see docs/quality-engine-design.md). Where the static gate (verify-gate.ts)
 * reasons about the source bytes, this actually INSTALLS + BUILDS the generated app
 * in an ephemeral microVM before it's pushed to the deploy provider, so a build
 * that would fail minutes later on the remote builder fails here in seconds — and,
 * crucially, is auto-fixed and retried instead of shipped.
 *
 * Every production failure we've hit was a BUILD failure (.NET CS0246/CS1513,
 * NU1605, ModuleNotFound, a missing Dockerfile), so install+build is the
 * high-value, high-reliability check; running the live flow (browser smoke) is a
 * further tier layered on top later via the agent-browser sandbox pattern.
 *
 * The loop:
 *   write files → run the stack's install+build steps → on failure, recognise the
 *   error via the fix registry (matchKnownFix), apply the matching deterministic
 *   auto-fix, and retry (bounded). A failure that matches no fix is surfaced as a
 *   blocker with the log (and flagged novel, so a new rule can be authored).
 *
 * The sandbox itself is behind an injectable `SandboxFactory`, so the orchestration
 * is fully unit-testable offline and the real `@vercel/sandbox` adapter
 * (vercel-sandbox-runner.ts) is the only place that touches the network. FAIL-OPEN:
 * if no sandbox is configured the caller simply skips this tier.
 */

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One ephemeral sandbox session. Implemented by the real adapter or a test fake. */
export interface SandboxSession {
  writeFiles(files: SrcFile[]): Promise<void>;
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<SandboxRunResult>;
  stop(): Promise<void>;
}

export type SandboxFactory = (opts: { runtime: string; timeoutMs: number }) => Promise<SandboxSession>;

export interface BuildStep {
  cmd: string;
  args: string[];
  timeoutMs?: number;
}

export interface SandboxRecipe {
  /** Sandbox runtime image (the SDK's runtime id, e.g. "node24"). */
  runtime: string;
  /** Ordered install/build steps; the first non-zero exit fails the build. */
  steps: BuildStep[];
}

/** A deterministic, pure transform applied to retry after a recognised failure. */
export type AutoFixer = (files: SrcFile[]) => SrcFile[];

/** Default auto-fixers keyed by fix-registry id. Pure + idempotent. */
export const DEFAULT_AUTO_FIXERS: Record<string, AutoFixer> = {
  "repair-truncated-source": (files) => repairTruncatedSource(files).files,
};

/**
 * Per-stack install+build recipes. Conservative: only the stacks with a stable,
 * well-known build command. Others return null → the caller skips the sandbox tier
 * for them (static gate still applies). The map is additive — adding a stack here
 * extends sandbox coverage without touching the orchestration.
 */
export function recipeFor(stack: Stack): SandboxRecipe | null {
  switch (stack) {
    case "node":
    case "bun":
      return {
        runtime: "node24",
        steps: [
          { cmd: "npm", args: ["install", "--no-audit", "--no-fund"], timeoutMs: 120_000 },
          // Build only if a build script exists; `--if-present` makes it a no-op otherwise.
          { cmd: "npm", args: ["run", "build", "--if-present"], timeoutMs: 120_000 },
        ],
      };
    case "static":
      return {
        runtime: "node24",
        steps: [
          { cmd: "npm", args: ["install", "--no-audit", "--no-fund"], timeoutMs: 120_000 },
          { cmd: "npm", args: ["run", "build", "--if-present"], timeoutMs: 120_000 },
        ],
      };
    default:
      // Compiled / non-Node stacks need their own toolchain image + commands; added
      // incrementally (see docs/quality-engine-design.md). Sandbox tier skipped.
      return null;
  }
}

export interface SandboxVerifyInput {
  files: SrcFile[];
  recipe: SandboxRecipe;
  factory: SandboxFactory;
  autoFixers?: Record<string, AutoFixer>;
  /** Max build attempts (each retry after an applied auto-fix). Default 2. */
  maxAttempts?: number;
  sandboxTimeoutMs?: number;
}

export interface SandboxVerifyResult {
  ok: boolean;
  /** Attempts run (1 = passed first try). */
  attempts: number;
  /** The (possibly auto-fixed) files to deploy. */
  files: SrcFile[];
  /** Auto-fixes applied across attempts, by id. */
  fixesApplied: string[];
  /** Fixes whose signature matched the failing build log. */
  recognized: { id: string; title: string }[];
  /** A failure that matched no known fix (→ author a new rule). */
  novelFailure: boolean;
  /** The failing build log tail (empty when ok). */
  log: string;
  /** Human-readable blocker (empty when ok). */
  blocker: string;
}

const asRec = (f: FixRule) => ({ id: f.id, title: f.title });

/**
 * Build the app in an ephemeral sandbox, auto-fixing recognised failures and
 * retrying up to `maxAttempts`. Pure orchestration over the injected factory.
 */
export async function sandboxVerifyBuild(input: SandboxVerifyInput): Promise<SandboxVerifyResult> {
  const autoFixers = input.autoFixers ?? DEFAULT_AUTO_FIXERS;
  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);
  const sandboxTimeoutMs = input.sandboxTimeoutMs ?? 180_000;
  let files = input.files;
  const fixesApplied: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sb = await input.factory({ runtime: input.recipe.runtime, timeoutMs: sandboxTimeoutMs });
    let result: SandboxRunResult = { exitCode: 0, stdout: "", stderr: "" };
    try {
      await sb.writeFiles(files);
      for (const step of input.recipe.steps) {
        result = await sb.run(step.cmd, step.args, { timeoutMs: step.timeoutMs });
        if (result.exitCode !== 0) break;
      }
    } finally {
      await sb.stop().catch(() => {});
    }

    if (result.exitCode === 0) {
      return { ok: true, attempts: attempt, files, fixesApplied, recognized: [], novelFailure: false, log: "", blocker: "" };
    }

    const log = `${result.stdout}\n${result.stderr}`.trim();
    const recognized = matchKnownFix(log);

    // Try a deterministic auto-fix for a recognised failure, then retry.
    let fixed = false;
    if (attempt < maxAttempts) {
      for (const r of recognized) {
        const fixer = autoFixers[r.id];
        if (!fixer) continue;
        const next = fixer(files);
        if (JSON.stringify(next) !== JSON.stringify(files)) {
          files = next;
          fixesApplied.push(r.id);
          fixed = true;
          break;
        }
      }
    }
    if (fixed) continue;

    // No (further) auto-fix available → block with the recognised cause or novelty.
    const novelFailure = unmatchedFailure(log);
    const blocker = recognized.length
      ? `Sandbox build failed — ${recognized[0].title} (${recognized[0].id}). Apply that fix or regenerate the affected file(s).`
      : `Sandbox build failed with an unrecognised error. Build log tail:\n${log.slice(-800)}`;
    return { ok: false, attempts: attempt, files, fixesApplied, recognized: recognized.map(asRec), novelFailure, log: log.slice(-2000), blocker };
  }

  return {
    ok: false,
    attempts: maxAttempts,
    files,
    fixesApplied,
    recognized: [],
    novelFailure: false,
    log: "",
    blocker: `Sandbox build still failing after ${maxAttempts} attempts (auto-fixes: ${fixesApplied.join(", ") || "none"}).`,
  };
}
