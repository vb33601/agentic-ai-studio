/**
 * LIVE real-sandbox check for the scaffold tier. Runs an OFFICIAL generator in a
 * real @vercel/sandbox microVM and reads the produced project back, then exercises
 * the full resolveStartTemplate() scaffold path.
 *
 *   SANDBOX_VERIFY=1 npx tsx --env-file=.env.local scripts/test-scaffolder-live.mts
 *
 * Requires VERCEL_TOKEN (+ billing). Costs a real sandbox run.
 */
import { runScaffolder } from "../src/lib/ai/templates/scaffolder";
import { resolveStartTemplate } from "../src/lib/ai/templates/resolve";
import { isSandboxConfigured, vercelSandboxFactory } from "../src/lib/deploy/vercel-sandbox-runner";

(async () => {
  console.log("isSandboxConfigured():", isSandboxConfigured(), "| VERCEL_TOKEN set:", !!process.env.VERCEL_TOKEN);
  if (!process.env.VERCEL_TOKEN) { console.log("✗ no VERCEL_TOKEN — aborting"); process.exit(2); }

  // 1) Direct executor: run create-vite (react) in a real sandbox, read it back.
  console.log("\n[1] runScaffolder: npm create vite@latest (react) in a live sandbox…");
  const t0 = Date.now();
  const files = await runScaffolder(
    { tool: "create-vite", command: "npm create vite@latest {name} -- --template react" },
    { factory: vercelSandboxFactory, timeoutMs: 240_000 },
  );
  console.log(`    produced ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log("    sample:", files.slice(0, 8).map((f) => f.path).join(", "));
  const hasPkg = files.some((f) => f.path === "package.json");
  const hasEntry = files.some((f) => /src\/(main|App)\.(jsx|tsx)$/.test(f.path));
  console.log(`    package.json: ${hasPkg ? "✓" : "✗"} | react entry: ${hasEntry ? "✓" : "✗"}`);

  // 2) Full resolution path: a Svelte request should scaffold via create-vite.
  console.log("\n[2] resolveStartTemplate('Build a Svelte todo app') with live sandbox…");
  const t1 = Date.now();
  const resolved = await resolveStartTemplate("Build a Svelte todo app");
  console.log(`    strategy=${resolved.strategy} stack=${resolved.template.stack} files=${Object.keys(resolved.template.files).length} in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  console.log("    sample:", Object.keys(resolved.template.files).slice(0, 8).join(", "));

  const ok = hasPkg && hasEntry && files.length >= 5 && (resolved.strategy === "scaffold" || resolved.strategy === "scaffold-fallback");
  console.log(`\n${ok ? "✓ LIVE SCAFFOLDER OK" : "✗ LIVE SCAFFOLDER FAILED"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
