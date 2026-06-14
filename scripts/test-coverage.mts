/**
 * Cross-stack coverage audit — proves every fix is CIRCULATED across all configured
 * stacks (the founding requirement), and prints the coverage matrix.
 *
 *   npx tsx scripts/test-coverage.mts
 *
 * Three layers of circulation:
 *   1. UNIVERSAL passes (strip-broken-files, repair-truncated-source) reach EVERY
 *      stack via hardeningPassesFor — asserted here for all of them.
 *   2. The pre-deploy VERIFY-GATE (truncation repair/block + invariant checks +
 *      failure recognition) runs on every deploy path, stack-agnostic.
 *   3. STACK-SPECIFIC fixes apply where they make sense (declared in the registry),
 *      and the SANDBOX build tier covers the stacks with a recipe.
 *
 * Plus: every error this session produced is recognised by matchKnownFix, so the
 * engine "knows" each failure class for all future deploys.
 */
import { HARDENING_MATRIX, hardeningPassesFor } from "../src/lib/deploy/hardening-matrix";
import { FIX_REGISTRY, fixesForStack, matchKnownFix } from "../src/lib/deploy/fix-registry";
import { recipeFor } from "../src/lib/deploy/sandbox-verify";
import { repairTruncatedJs, repairTruncatedCSharp } from "../src/lib/deploy/truncation";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

const stacks = Object.keys(HARDENING_MATRIX) as Array<Parameters<typeof hardeningPassesFor>[0]>;
console.log(`\nConfigured stacks: ${stacks.length}\n`);

// ── Layer 1: universal passes reach EVERY stack ──────────────────────────────
const universal = ["strip-broken-files", "repair-truncated-source"];
for (const p of universal) {
  const missing = stacks.filter((s) => !hardeningPassesFor(s).includes(p as never));
  check(`UNIVERSAL "${p}" reaches all ${stacks.length} stacks`, missing.length === 0, `missing on: ${missing.join(",")}`);
}

// ── Layer 3a: sandbox build-tier coverage ────────────────────────────────────
const withRecipe = stacks.filter((s) => recipeFor(s) !== null);
console.log(`\n  sandbox build-tier recipes: ${withRecipe.length}/${stacks.length} stacks`);
check("sandbox recipe exists for ALL configured stacks", withRecipe.length === stacks.length, `missing: ${stacks.filter((s) => !recipeFor(s)).join(",")}`);
check("sandbox covers the JS + key compiled stacks", ["node", "static", "python", "dotnet", "go", "rust", "java", "ruby", "php"].every((s) => recipeFor(s as never) !== null));

// ── Per-stack coverage matrix (printed) ──────────────────────────────────────
console.log("\n  stack            | universal-trunc | sandbox | registry-fixes");
console.log("  " + "-".repeat(68));
for (const s of stacks) {
  const uni = hardeningPassesFor(s).includes("repair-truncated-source") ? "yes" : "NO";
  const r = recipeFor(s);
  const sb = !r ? "-" : r.steps.length ? "build" + (r.run ? "+run" : "") : "best-effort";
  const nFixes = fixesForStack(s).length;
  console.log(`  ${s.padEnd(16)} | ${uni.padEnd(15)} | ${sb.padEnd(7)} | ${nFixes}`);
}

// ── This session's fixes are repaired across the right languages ─────────────
console.log("");
check(
  "truncation repair works on the JS family (jsx/tsx/js/ts)",
  ["a.jsx", "b.tsx", "c.js", "d.ts", "e.mjs"].every((p) => repairTruncatedJs(p, "export default function A(){return (\nfunction") !== null),
);
check("truncation repair works on C# (.cs)", repairTruncatedCSharp("S.cs", "class C{ void M(){ var x=1;\n") !== null);
check(
  "single-line JSX is NOT false-repaired (the blank-render regression)",
  repairTruncatedJs("App.jsx", "export default function App(){return <div><h1>Hi</h1><p>x</p></div>;}") === null,
);

// ── Every fix this session has a registry entry + is recognised by its log ───
const sessionSignatures: Array<[string, string]> = [
  ["truncated JS (Vercel)", "src/pages/Settings.jsx: ERROR: Expected identifier but found end of file"],
  ["truncated C# (Fly .NET)", "/src/Services/MenuService.cs(130,46): error CS1513: } expected"],
  [".NET phantom DI", "Program.cs(44,28): error CS0246: 'IStaffService' could not be found"],
  [".NET package downgrade", "error NU1605: Detected package downgrade"],
  ["Fly Node missing Dockerfile", "failed to fetch an image or build from source: Dockerfile not found"],
];
console.log("");
for (const [name, log] of sessionSignatures) {
  check(`recognised by matchKnownFix: ${name}`, matchKnownFix(log).length > 0, "no registry signature matches");
}

// ── Registry integrity: every fix declares a scope ───────────────────────────
check("every registry fix declares appliesTo stacks", FIX_REGISTRY.every((f) => f.appliesTo.length > 0));
check("universal fixes are tagged '*'", FIX_REGISTRY.filter((f) => f.appliesTo.includes("*")).length >= 2);

console.log("\n" + "-".repeat(60));
console.log(fails === 0 ? "ALL COVERAGE CHECKS PASSED — fixes are circulated across the stacks" : `${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
