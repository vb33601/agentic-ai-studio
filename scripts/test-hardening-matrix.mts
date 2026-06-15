/**
 * Asserts the per-stack hardening matrix is internally consistent and matches
 * what the engine actually does. Completeness (every Stack has an entry) is
 * enforced at compile time by `Record<Stack, …>`; this guards against drift
 * between the documented matrix and the real reconciler/.NET passes.
 *
 *   npx tsx scripts/test-hardening-matrix.mts
 */
import { HARDENING_MATRIX, hardeningPassesFor } from "../src/lib/deploy/hardening-matrix";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

const entries = Object.entries(HARDENING_MATRIX);
const stacksWith = (p: string) => entries.filter(([, v]) => v.passes.includes(p as never)).map(([k]) => k).sort();

console.log(`matrix covers ${entries.length} stacks`);
check("every stack runs strip-broken-files", entries.every(([, v]) => v.passes.includes("strip-broken-files")));
check("every stack has a non-empty context", entries.every(([, v]) => v.context.trim().length > 10));

// dep-reconcile must be exactly the dynamic stacks the reconciler supports.
check(
  "dep-reconcile stacks = python,node,bun,ruby",
  JSON.stringify(stacksWith("dep-reconcile")) === JSON.stringify(["bun", "node", "python", "ruby"]),
  stacksWith("dep-reconcile").join(","),
);
check("go-mod-tidy only on go", JSON.stringify(stacksWith("go-mod-tidy")) === JSON.stringify(["go"]), stacksWith("go-mod-tidy").join(","));

// The .NET-specific passes apply to dotnet alone.
for (const p of ["dotnet-package-conflict", "dotnet-di-register", "dotnet-di-prune", "dotnet-program-builder"]) {
  check(`${p} only on dotnet`, JSON.stringify(stacksWith(p)) === JSON.stringify(["dotnet"]), stacksWith(p).join(","));
}
check("dotnet has all three .NET passes + schema", ["dotnet-package-conflict", "dotnet-di-register", "dotnet-di-prune", "schema-autocreate"].every((p) => HARDENING_MATRIX.dotnet.passes.includes(p as never)));

// schema-autocreate = the ORM-bearing stacks.
check(
  "schema-autocreate stacks = dotnet,java,node,php,python,ruby",
  JSON.stringify(stacksWith("schema-autocreate")) === JSON.stringify(["dotnet", "java", "node", "php", "python", "ruby"]),
  stacksWith("schema-autocreate").join(","),
);

// CORS coverage: generic `cors` on the web stacks, `dotnet-cors` on dotnet.
check("cors stacks = node,python", JSON.stringify(stacksWith("cors")) === JSON.stringify(["node", "python"]), stacksWith("cors").join(","));
check("dotnet-cors only on dotnet", JSON.stringify(stacksWith("dotnet-cors")) === JSON.stringify(["dotnet"]), stacksWith("dotnet-cors").join(","));

// The datasource-coerce family is one pass per ORM-bearing stack.
check("spring-datasource-postgres only on java", JSON.stringify(stacksWith("spring-datasource-postgres")) === JSON.stringify(["java"]), stacksWith("spring-datasource-postgres").join(","));
check("prisma-datasource-postgres only on node", JSON.stringify(stacksWith("prisma-datasource-postgres")) === JSON.stringify(["node"]), stacksWith("prisma-datasource-postgres").join(","));
check("dotnet-datasource-postgres only on dotnet", JSON.stringify(stacksWith("dotnet-datasource-postgres")) === JSON.stringify(["dotnet"]), stacksWith("dotnet-datasource-postgres").join(","));
check("rails-datasource-postgres only on ruby", JSON.stringify(stacksWith("rails-datasource-postgres")) === JSON.stringify(["ruby"]), stacksWith("rails-datasource-postgres").join(","));
check("django-datasource-postgres only on python", JSON.stringify(stacksWith("django-datasource-postgres")) === JSON.stringify(["python"]), stacksWith("django-datasource-postgres").join(","));
check("laravel-datasource-postgres only on php", JSON.stringify(stacksWith("laravel-datasource-postgres")) === JSON.stringify(["php"]), stacksWith("laravel-datasource-postgres").join(","));

// hardeningPassesFor is total.
check("hardeningPassesFor returns passes for a known stack", hardeningPassesFor("rust").includes("strip-broken-files"));

// Universal source-integrity passes are injected for EVERY stack (deduped).
check(
  "repair-truncated-source is universal",
  entries.every(([k]) => hardeningPassesFor(k as never).includes("repair-truncated-source")),
);
check(
  "strip-broken-files is universal (via hardeningPassesFor)",
  entries.every(([k]) => hardeningPassesFor(k as never).includes("strip-broken-files")),
);

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL HARDENING-MATRIX TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
