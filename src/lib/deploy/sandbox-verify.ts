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
  run(cmd: string, args: string[], opts?: { timeoutMs?: number; detached?: boolean }): Promise<SandboxRunResult>;
  /** Public URL of a forwarded port (run/smoke tier). Optional on a session. */
  domain?(port: number): string;
  stop(): Promise<void>;
}

export type SandboxFactory = (opts: { runtime: string; timeoutMs: number; ports?: number[] }) => Promise<SandboxSession>;

export interface BuildStep {
  cmd: string;
  args: string[];
  timeoutMs?: number;
}

/** Optional run+smoke tier: boot the app and HTTP-check it after a green build. */
export interface RunSpec {
  /** Command + args to start the server (run detached). */
  cmd: string;
  args: string[];
  /** Port the app listens on inside the sandbox. */
  port: number;
  /** Path to probe (default "/"). A 2xx–4xx response = the server is up. */
  healthPath?: string;
  /** How long to wait for the server to answer (default 20s). */
  bootTimeoutMs?: number;
}

export interface SandboxRecipe {
  /** Sandbox runtime image (the SDK's runtime id, e.g. "node24", "python3.13"). */
  runtime: string;
  /** Ordered install/build steps; the first non-zero exit fails the build. */
  steps: BuildStep[];
  /** Optional run+smoke after the build passes. */
  run?: RunSpec;
}

/** Fetch used by the run/smoke tier — injectable so tests stay offline. */
export type HttpGet = (url: string) => Promise<{ status: number }>;

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
const NPM_INSTALL: BuildStep = { cmd: "npm", args: ["install", "--no-audit", "--no-fund"], timeoutMs: 120_000 };
const NPM_BUILD: BuildStep = { cmd: "npm", args: ["run", "build", "--if-present"], timeoutMs: 120_000 };
/** Shorthand for a shell pipeline step (toolchain install needs `sh -c`). */
const sh = (script: string, timeoutMs = 240_000): BuildStep => ({ cmd: "sh", args: ["-c", script], timeoutMs });

export function recipeFor(stack: Stack): SandboxRecipe | null {
  switch (stack) {
    // --- Node: native runtime; build + (run a server if `npm start` exists). ---
    case "node":
    case "bun":
      return {
        runtime: "node24",
        steps: [NPM_INSTALL, NPM_BUILD],
        run: { cmd: "sh", args: ["-c", "PORT=3000 npm start"], port: 3000, healthPath: "/", bootTimeoutMs: 20_000 },
      };
    // --- Static/frontend: native runtime; build only (no server to boot). ---
    case "static":
      return { runtime: "node24", steps: [NPM_INSTALL, NPM_BUILD] };
    // --- Python: native runtime; install deps + byte-compile to catch syntax/import. ---
    case "python":
      return {
        runtime: "python3.13",
        steps: [
          sh("if [ -f requirements.txt ]; then pip install -r requirements.txt; fi", 180_000),
          sh("python -m compileall -q . || python -m py_compile $(git ls-files '*.py' 2>/dev/null || find . -name '*.py')", 120_000),
        ],
      };
    // --- .NET: install the SDK in a node VM, then build (catches CS0246/CS1513/NU1605). ---
    case "dotnet":
      return {
        runtime: "node24",
        steps: [
          sh("curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir $HOME/.dotnet", 240_000),
          sh("$HOME/.dotnet/dotnet build -c Release -p:NoWarn=NU1605 -p:TreatWarningsAsErrors=false", 240_000),
        ],
      };
    // --- Go: install the toolchain, then compile. ---
    case "go":
      return {
        runtime: "node24",
        steps: [sh("sudo dnf install -y golang >/dev/null 2>&1 && go build ./... 2>&1", 240_000)],
      };
    default:
      // Other compiled stacks (Java/Rust/…) need their own toolchain step; added
      // incrementally (see docs/quality-engine-design.md). Sandbox tier skipped —
      // the static gate + remote build still apply.
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
  /** HTTP probe for the run/smoke tier (defaults to fetch). */
  httpGet?: HttpGet;
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
  /** Run/smoke tier ran (only when the recipe defines `run` + the build passed). */
  runChecked?: boolean;
  /** The booted app answered an HTTP probe. */
  runOk?: boolean;
  /** Soft signal: the app built but didn't answer in time (does NOT block). */
  runWarning?: string;
}

const asRec = (f: FixRule) => ({ id: f.id, title: f.title });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the built app and HTTP-probe it. A SOFT, non-blocking signal: a response
 * means the flow is live; no response in time is reported as a warning, not a
 * block (start-command/port heuristics aren't reliable enough to fail a deploy on).
 * Fully fail-open — any error returns "inconclusive".
 */
async function runSmoke(sb: SandboxSession, spec: RunSpec, httpGet: HttpGet): Promise<{ ok: boolean; warning?: string }> {
  if (!sb.domain) return { ok: false, warning: "sandbox has no port forwarding" };
  try {
    // Start the server detached so it keeps running while we probe.
    await sb.run(spec.cmd, spec.args, { detached: true }).catch(() => {});
    const url = sb.domain(spec.port) + (spec.healthPath ?? "/");
    const deadline = Date.now() + (spec.bootTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      try {
        const { status } = await httpGet(url);
        if (status > 0 && status < 500) return { ok: true };
      } catch {
        /* not up yet */
      }
      await sleep(1000);
    }
    return { ok: false, warning: `app built but did not answer on :${spec.port}${spec.healthPath ?? "/"} within ${(spec.bootTimeoutMs ?? 20_000) / 1000}s` };
  } catch (e) {
    return { ok: false, warning: `run/smoke skipped: ${e instanceof Error ? e.message : String(e)}` };
  }
}

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
    const sb = await input.factory({
      runtime: input.recipe.runtime,
      timeoutMs: sandboxTimeoutMs,
      ports: input.recipe.run ? [input.recipe.run.port] : undefined,
    });
    let result: SandboxRunResult = { exitCode: 0, stdout: "", stderr: "" };
    let smoke: { ok: boolean; warning?: string } | null = null;
    try {
      await sb.writeFiles(files);
      for (const step of input.recipe.steps) {
        result = await sb.run(step.cmd, step.args, { timeoutMs: step.timeoutMs });
        if (result.exitCode !== 0) break;
      }
      // Run/smoke tier — only after a green build, only when the recipe defines it.
      if (result.exitCode === 0 && input.recipe.run) {
        smoke = await runSmoke(sb, input.recipe.run, input.httpGet ?? ((u) => fetch(u).then((r) => ({ status: r.status }))));
      }
    } finally {
      await sb.stop().catch(() => {});
    }

    if (result.exitCode === 0) {
      return {
        ok: true, attempts: attempt, files, fixesApplied, recognized: [], novelFailure: false, log: "", blocker: "",
        ...(smoke ? { runChecked: true, runOk: smoke.ok, ...(smoke.warning ? { runWarning: smoke.warning } : {}) } : {}),
      };
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
