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
      async stop() {},
    };
  };
  return { factory, attempts: () => attempt };
}

const recipe = recipeFor("node")!;

// 1) Green build → ok on first attempt.
{
  const f = makeFactory([{}]);
  const r = await sandboxVerifyBuild({ files: [{ path: "index.js", content: "console.log(1)" }], recipe, factory: f.factory });
  check("green build passes on attempt 1", r.ok && r.attempts === 1 && f.attempts() === 1);
}

// 2) Truncation failure → auto-fixed (repair-truncated-source) → retry green.
{
  const truncated = { path: "src/api.js", content: "export function load() {\n  const x = fetch('/a')\nfunction" };
  const f = makeFactory([{ failOnStep: "run build", log: "Unexpected end of file / Expected identifier but found end of file" }, {}]);
  const r = await sandboxVerifyBuild({ files: [truncated], recipe, factory: f.factory, maxAttempts: 2 });
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

// 5) recipeFor coverage.
check("recipeFor(node) returns a recipe", recipeFor("node")?.runtime === "node24");
check("recipeFor(rust) is null (sandbox tier skipped)", recipeFor("rust") === null);

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL SANDBOX-VERIFY TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
