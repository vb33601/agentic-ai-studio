/**
 * Sandbox build-verifier orchestration + auto-fix loop (offline; fake sandbox).
 *
 *   npx tsx scripts/test-sandbox-verify.mts
 */
import {
  sandboxVerifyBuild,
  recipeFor,
  type SandboxFactory,
  type SandboxRunResult,
} from "../src/lib/deploy/sandbox-verify";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

/** A fake sandbox: per-attempt, fail a named step with a log; else everything passes. */
function makeFactory(script: Array<{ failOnStep?: string; log?: string }>) {
  let attempt = 0;
  const factory: SandboxFactory = async () => {
    const cur = script[Math.min(attempt, script.length - 1)];
    attempt++;
    return {
      async writeFiles() {},
      async run(_cmd: string, args: string[]): Promise<SandboxRunResult> {
        if (cur.failOnStep && args.join(" ").includes(cur.failOnStep)) {
          return { exitCode: 1, stdout: cur.log ?? "build error", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      domain(port: number) { return `https://fake-${port}.vercel.run`; },
      async stop() {},
    };
  };
  return { factory, attempts: () => attempt };
}

const recipe = recipeFor("node")!;
// Injected HTTP probe (offline): the booted app "answers" 200.
const httpOk = async () => ({ status: 200 });
const httpDown = async () => { throw new Error("conn refused"); };

// 1) Green build → ok on first attempt; run/smoke answers.
{
  const f = makeFactory([{}]);
  const r = await sandboxVerifyBuild({ files: [{ path: "index.js", content: "console.log(1)" }], recipe, factory: f.factory, httpGet: httpOk });
  check("green build passes on attempt 1", r.ok && r.attempts === 1 && f.attempts() === 1);
  check("run/smoke tier ran and the app answered", r.runChecked === true && r.runOk === true);
}

// 1b) Build green but the app never answers → soft WARNING, still ok (no false block).
{
  const fastRecipe = { ...recipe, run: { ...recipe.run!, bootTimeoutMs: 2000 } };
  const f = makeFactory([{}]);
  const r = await sandboxVerifyBuild({ files: [{ path: "index.js", content: "1" }], recipe: fastRecipe, factory: f.factory, httpGet: httpDown });
  check("non-responding app is a warning, not a block", r.ok && r.runChecked === true && r.runOk === false && !!r.runWarning);
}

// 2) Truncation failure → auto-fixed (repair-truncated-source) → retry green.
{
  const truncated = { path: "src/api.js", content: "export function load() {\n  const x = fetch('/a')\nfunction" };
  const f = makeFactory([{ failOnStep: "run build", log: "Unexpected end of file / Expected identifier but found end of file" }, {}]);
  const r = await sandboxVerifyBuild({ files: [truncated], recipe, factory: f.factory, maxAttempts: 2, httpGet: httpOk });
  check("recognises + auto-fixes truncation then passes", r.ok && r.attempts === 2);
  check("reports the applied auto-fix", r.fixesApplied.includes("repair-truncated-source"));
  check("the returned file was actually repaired", !r.files[0].content.endsWith("function"));
}

// 3) Recognised failure with NO auto-fixer → block with the cause (no wasted retry).
{
  const f = makeFactory([{ failOnStep: "run build", log: "error NU1605: Detected package downgrade" }, {}]);
  const r = await sandboxVerifyBuild({ files: [{ path: "a.csproj", content: "<Project/>" }], recipe, factory: f.factory, maxAttempts: 2 });
  check("blocks on a recognised-but-no-fixer failure", !r.ok && r.attempts === 1);
  check("blocker names the recognised fix", /dotnet-package-conflict/.test(r.recognized.map((x) => x.id).join(",")) && /NU1605|downgrade|package/i.test(r.blocker + r.recognized.map((x) => x.title).join()));
}

// 4) Unrecognised failure → block + flagged novel.
{
  const f = makeFactory([{ failOnStep: "run build", log: "Segmentation fault in libmystery.so 0xdead" }]);
  const r = await sandboxVerifyBuild({ files: [{ path: "i.js", content: "x" }], recipe, factory: f.factory });
  check("blocks an unrecognised failure", !r.ok);
  check("flags the failure as novel", r.novelFailure);
  check("blocker includes the build log tail", /libmystery/.test(r.blocker));
}

// 4b) Toolchain (setup) failure → fail-open SKIP, never a deploy block.
{
  const f = makeFactory([{ failOnStep: "dnf install", log: "No match for argument: ruby" }]);
  const r = await sandboxVerifyBuild({ files: [{ path: "a.rb", content: "puts 1" }], recipe: recipeFor("ruby")!, factory: f.factory });
  check("toolchain-unavailable setup fail-opens (skip, not block)", r.ok && r.setupSkipped === true);
}

// 5) recipeFor coverage (node/static/python native; dotnet/go via toolchain install).
check("recipeFor(node) → node24 + run spec", recipeFor("node")?.runtime === "node24" && !!recipeFor("node")?.run);
check("recipeFor(static) → build only (no run)", recipeFor("static")?.runtime === "node24" && !recipeFor("static")?.run);
check("recipeFor(python) → python3.13", recipeFor("python")?.runtime === "python3.13");
check("recipeFor(dotnet) installs the SDK then builds", recipeFor("dotnet")?.steps.some((s) => s.args.join(" ").includes("dotnet-install")) === true);
check("recipeFor(go) builds via the go toolchain", recipeFor("go")?.steps.some((s) => s.args.join(" ").includes("go build")) === true);
check("recipeFor(rust) is a reliable blocking recipe", (recipeFor("rust")?.steps.length ?? 0) > 0);
check("recipeFor(crystal) is best-effort (setup-only, fail-open)", recipeFor("crystal")?.steps.length === 0 && (recipeFor("crystal")?.setup?.length ?? 0) > 0);

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL SANDBOX-VERIFY TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
