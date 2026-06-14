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
  /**
   * Toolchain provisioning (compiled/non-node stacks install their compiler here).
   * FAIL-OPEN: if any setup step fails — the toolchain isn't installable in the
   * node/python sandbox — the whole tier is SKIPPED (the deploy proceeds and the
   * remote Docker build, which has the right base image, remains the verifier). A
   * setup failure is never a deploy blocker.
   */
  setup?: BuildStep[];
  /** Ordered build steps; the first non-zero exit fails the build (blocks/auto-fixes). */
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
const dnf = (pkgs: string) => sh(`sudo dnf install -y ${pkgs} 2>&1`, 180_000);

/**
 * RELIABLE tier — the toolchain is dependably available in the node/python sandbox
 * (Amazon Linux 2023 dnf, or a first-party install script) and the build is a real
 * check that SHOULD block the deploy on failure (e.g. `ruby -c`/`php -l` catch
 * truncation; cargo/mvn/dotnet catch the real build defects).
 */
const RELIABLE: Partial<Record<Stack, SandboxRecipe>> = {
  node: { runtime: "node24", steps: [NPM_INSTALL, NPM_BUILD], run: { cmd: "sh", args: ["-c", "PORT=3000 npm start"], port: 3000, healthPath: "/", bootTimeoutMs: 20_000 } },
  bun: { runtime: "node24", steps: [NPM_INSTALL, NPM_BUILD], run: { cmd: "sh", args: ["-c", "PORT=3000 npm start"], port: 3000, healthPath: "/", bootTimeoutMs: 20_000 } },
  static: { runtime: "node24", steps: [NPM_INSTALL, NPM_BUILD] },
  python: { runtime: "python3.13", steps: [
    sh("if [ -f requirements.txt ]; then pip install -r requirements.txt; fi", 180_000),
    sh("python -m compileall -q . || python -m py_compile $(find . -name '*.py')", 120_000),
  ] },
  dotnet: { runtime: "node24", steps: [
    sh("curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir $HOME/.dotnet", 240_000),
    sh("$HOME/.dotnet/dotnet build -c Release -p:NoWarn=NU1605 -p:TreatWarningsAsErrors=false 2>&1", 240_000),
  ] },
  go: { runtime: "node24", setup: [dnf("golang")], steps: [sh("go build ./... 2>&1")] },
  rust: { runtime: "node24", setup: [dnf("cargo rust")], steps: [sh("cargo build 2>&1")] },
  cpp: { runtime: "node24", setup: [dnf("gcc-c++ cmake make")], steps: [sh("if [ -f CMakeLists.txt ]; then cmake -B build -DCMAKE_BUILD_TYPE=Release 2>&1 && cmake --build build 2>&1; else g++ -std=c++17 -fsyntax-only $(find . -name '*.cpp' -o -name '*.cc' -o -name '*.cxx') 2>&1; fi")] },
  java: { runtime: "node24", setup: [dnf("java-17-openjdk-devel maven")], steps: [sh("if [ -f pom.xml ]; then mvn -q -DskipTests package 2>&1; elif [ -f gradlew ]; then ./gradlew build -x test --no-daemon 2>&1; else javac $(find . -name '*.java') 2>&1; fi")] },
  ruby: { runtime: "node24", setup: [dnf("ruby")], steps: [sh("find . -name '*.rb' -print0 | xargs -0 -r -n1 ruby -c 2>&1")] },
  php: { runtime: "node24", setup: [dnf("php-cli")], steps: [sh("find . -name '*.php' -print0 | xargs -0 -r -n1 php -l 2>&1")] },
  deno: { runtime: "node24", setup: [sh("curl -fsSL https://deno.land/install.sh | sh 2>&1")], steps: [sh("$HOME/.deno/bin/deno check $(find . -name '*.ts' -not -path '*/node_modules/*') 2>&1")] },
};

/**
 * BEST-EFFORT tier — toolchain install + a lightweight build/syntax check, run in
 * the fail-open SETUP phase so it can NEVER block a deploy: on these stacks the
 * toolchain often isn't installable in the node sandbox (Amazon Linux 2023 has a
 * limited repo), so a failure means "skip — the remote Docker build (correct base
 * image) verifies instead". When the toolchain IS present, it still catches breaks.
 */
const BEST_EFFORT: Partial<Record<Stack, string>> = {
  perl: "sudo dnf install -y perl 2>&1 && find . -name '*.pl' -o -name '*.pm' | xargs -r -n1 perl -c 2>&1",
  lua: "sudo dnf install -y lua 2>&1 && find . -name '*.lua' | xargs -r -n1 luac -p 2>&1",
  r: "sudo dnf install -y R 2>&1 && Rscript -e \"invisible(lapply(list.files(pattern='[.][Rr]$',recursive=TRUE), parse))\" 2>&1",
  elixir: "sudo dnf install -y elixir 2>&1 && mix compile 2>&1",
  erlang: "sudo dnf install -y erlang 2>&1 && (rebar3 compile 2>&1 || erlc $(find . -name '*.erl') 2>&1)",
  ocaml: "sudo dnf install -y ocaml dune 2>&1 && dune build 2>&1",
  haskell: "sudo dnf install -y ghc cabal-install 2>&1 && cabal build 2>&1",
  ada: "sudo dnf install -y gcc-gnat 2>&1 && gnatmake -q $(find . -name '*.adb' | head -1) 2>&1",
  pascal: "sudo dnf install -y fpc 2>&1 && find . -name '*.pas' | xargs -r -n1 fpc 2>&1",
  nim: "sudo dnf install -y nim 2>&1 && find . -name '*.nim' | xargs -r -n1 nim check 2>&1",
  d: "sudo dnf install -y ldc 2>&1 && ldc2 -o- $(find . -name '*.d') 2>&1",
  haxe: "sudo dnf install -y haxe 2>&1 && (haxe build.hxml 2>&1 || true)",
  lisp: "sudo dnf install -y sbcl 2>&1 && find . -name '*.lisp' | xargs -r -n1 sh -c 'sbcl --non-interactive --eval \"(compile-file \\\"$0\\\")\"' 2>&1",
  racket: "sudo dnf install -y racket 2>&1 && raco make $(find . -name '*.rkt') 2>&1",
  clojure: "sudo dnf install -y clojure java-17-openjdk-devel 2>&1 && clojure -M -e '(println :ok)' 2>&1",
  tcl: "sudo dnf install -y tcl 2>&1 && find . -name '*.tcl' | xargs -r -n1 sh -c 'echo \"source $0\" | tclsh' 2>&1",
  prolog: "sudo dnf install -y pl 2>&1 && find . -name '*.pl' -o -name '*.pro' | xargs -r -n1 swipl -g halt -t 'halt(1)' 2>&1",
  julia: "sudo dnf install -y julia 2>&1 && julia -e 'foreach(f->include(f), filter(x->endswith(x,\".jl\"), readdir(\".\";join=true)))' 2>&1",
  raku: "sudo dnf install -y rakudo 2>&1 && find . -name '*.raku' -o -name '*.p6' | xargs -r -n1 raku -c 2>&1",
  // Toolchains generally NOT in the Amazon Linux repo → install attempt fails →
  // fail-open skip (the remote Docker build, with the right base image, verifies).
  swift: "sudo dnf install -y swift-lang 2>&1 && swift build 2>&1",
  crystal: "sudo dnf install -y crystal 2>&1 && crystal build $(find . -name '*.cr' | head -1) 2>&1",
  zig: "sudo dnf install -y zig 2>&1 && zig build 2>&1",
  vlang: "sudo dnf install -y vlang 2>&1 && v . 2>&1",
  gleam: "sudo dnf install -y gleam 2>&1 && gleam build 2>&1",
  dart: "sudo dnf install -y dart 2>&1 && dart compile exe $(find . -name '*.dart' | head -1) 2>&1",
  ballerina: "sudo dnf install -y ballerina 2>&1 && bal build 2>&1",
  powershell: "sudo dnf install -y powershell 2>&1 && pwsh -NoProfile -Command 'Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object { [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$null,[ref]$null) }' 2>&1",
  hack: "sudo dnf install -y hhvm 2>&1 && hh_client check 2>&1",
};

/**
 * The sandbox recipe for a stack, or null when there's none. Covers ALL configured
 * stacks: a reliable blocking build for the well-supported ones, and a fail-open
 * best-effort build for the rest (toolchain install attempted; skipped if absent).
 */
export function recipeFor(stack: Stack): SandboxRecipe | null {
  if (RELIABLE[stack]) return RELIABLE[stack]!;
  const script = BEST_EFFORT[stack];
  if (script) return { runtime: "node24", setup: [sh(script, 240_000)], steps: [] };
  return null;
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
  /** The toolchain couldn't be provisioned in the sandbox → tier skipped (fail-open). */
  setupSkipped?: boolean;
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
    let setupFailed = false;
    try {
      await sb.writeFiles(files);
      // Toolchain provisioning (fail-open): a setup failure means the sandbox can't
      // host this stack's compiler → skip the tier, don't block the deploy.
      for (const step of input.recipe.setup ?? []) {
        const s = await sb.run(step.cmd, step.args, { timeoutMs: step.timeoutMs });
        if (s.exitCode !== 0) { setupFailed = true; break; }
      }
      if (!setupFailed) {
        for (const step of input.recipe.steps) {
          result = await sb.run(step.cmd, step.args, { timeoutMs: step.timeoutMs });
          if (result.exitCode !== 0) break;
        }
      }
      // Run/smoke tier — only after a green build, only when the recipe defines it.
      if (!setupFailed && result.exitCode === 0 && input.recipe.run) {
        smoke = await runSmoke(sb, input.recipe.run, input.httpGet ?? ((u) => fetch(u).then((r) => ({ status: r.status }))));
      }
    } finally {
      await sb.stop().catch(() => {});
    }

    // Toolchain couldn't be provisioned → fail-open skip (the remote build verifies).
    if (setupFailed) {
      return { ok: true, attempts: attempt, files, fixesApplied, recognized: [], novelFailure: false, log: "", blocker: "", setupSkipped: true };
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
