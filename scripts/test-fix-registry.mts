/**
 * Fix-registry completeness + recognition + propagation guarantees.
 *
 *   npx tsx scripts/test-fix-registry.mts
 *
 * This is the test that makes "circulate every fix across the whole engine" real:
 *   • Every matrix HardeningPass in use, and every runtime HardenRule, MUST have a
 *     registry entry — so a fix added for one technology can't be left unregistered
 *     for the 40+ others.
 *   • The new universal repair pass MUST be active for every stack.
 *   • matchKnownFix recognizes the real production failures; unmatchedFailure flags
 *     genuinely new ones.
 */
import { FIX_REGISTRY, FIX_IDS, matchKnownFix, unmatchedFailure, fixesForStack } from "../src/lib/deploy/fix-registry";
import { HARDENING_MATRIX, hardeningPassesFor } from "../src/lib/deploy/hardening-matrix";
import { HARDEN_RULES } from "../src/lib/deploy/harden";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// --- Unique ids. ---
check("fix ids are unique", FIX_IDS.size === FIX_REGISTRY.length, `${FIX_REGISTRY.length} entries, ${FIX_IDS.size} unique`);

// --- Every matrix pass in use has a registry entry tagged with that pass. ---
const stacks = Object.keys(HARDENING_MATRIX) as Array<Parameters<typeof hardeningPassesFor>[0]>;
const passesInUse = new Set<string>();
for (const s of stacks) for (const p of hardeningPassesFor(s)) passesInUse.add(p);
const registeredPasses = new Set(FIX_REGISTRY.map((f) => f.pass).filter(Boolean) as string[]);
for (const p of passesInUse) {
  check(`matrix pass "${p}" has a registry entry`, registeredPasses.has(p), "add it to FIX_REGISTRY");
}

// --- Every runtime HardenRule has a registry entry. ---
for (const r of HARDEN_RULES) {
  check(`harden rule "${r.id}" is registered`, FIX_IDS.has(r.id), "add it to FIX_REGISTRY");
}

// --- The new universal repair pass is active for EVERY stack. ---
check(
  "repair-truncated-source runs on every stack",
  stacks.every((s) => hardeningPassesFor(s).includes("repair-truncated-source")),
  stacks.filter((s) => !hardeningPassesFor(s).includes("repair-truncated-source")).join(","),
);
check(
  "strip-broken-files still runs on every stack",
  stacks.every((s) => hardeningPassesFor(s).includes("strip-broken-files")),
);

// --- Recognition: the real production errors map to the right fix. ---
const realVercelError =
  "src/pages/Settings.jsx:42:8: ERROR: Expected identifier but found end of file";
const m = matchKnownFix(realVercelError);
check("recognizes the real Settings.jsx truncation error", m.some((f) => f.id === "repair-truncated-source"), m.map((f) => f.id).join(","));

const samples: Array<[string, string]> = [
  ["dotnet-program-builder", "Program.cs(12,15): error CS1061: 'WebApplicationBuilder' does not contain a definition for 'CreateBuilder'"],
  ["dotnet-package-conflict", "error NU1605: Detected package downgrade: System.IdentityModel"],
  ["dotnet-di-register", "InvalidOperationException: Unable to resolve service for type 'IUserService'"],
  ["dep-reconcile", "ModuleNotFoundError: No module named 'requests'"],
  ["safe-array-iteration", "TypeError: Cannot read properties of undefined (reading 'map')"],
  ["cors", "Access to fetch has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header"],
  ["spring-datasource-postgres", "java.lang.RuntimeException: Driver org.h2.Driver claims to not accept jdbcUrl, jdbc:postgresql://pg-host:28007/defaultdb?currentSchema=app"],
  ["prisma-datasource-postgres", "Error: the URL must start with the protocol `file:`. Datasource provider sqlite does not match the postgresql URL."],
  ["dotnet-datasource-postgres", "System.ArgumentException: keyword 'host' not supported when opening SqliteConnection"],
  ["rails-datasource-postgres", "Please install the postgresql adapter: `gem install activerecord-postgresql-adapter` (could not load 'pg')"],
  ["django-datasource-postgres", "django.db.utils.OperationalError: attempt to write a readonly database (django.db.backends.sqlite3)"],
  ["laravel-datasource-postgres", "Illuminate\\Database\\QueryException: Database (database.sqlite) does not exist."],
  ["sqlalchemy-datasource-postgres", "sqlalchemy.exc.OperationalError: (sqlite3.OperationalError) unable to open database file"],
];
for (const [expectId, log] of samples) {
  check(`recognizes ${expectId}`, matchKnownFix(log).some((f) => f.id === expectId), matchKnownFix(log).map((f) => f.id).join(","));
}

// --- A genuinely novel failure matches nothing (→ author a new rule). ---
check("flags an unrecognized failure", unmatchedFailure("Segfault: heap corruption in libfoo.so at 0xdeadbeef"));
check("does NOT flag a recognized failure", !unmatchedFailure(realVercelError));

// --- Scoping sanity. ---
check("universal fixes apply to an arbitrary stack", fixesForStack("rust").some((f) => f.id === "repair-truncated-source"));
check(".NET fixes don't leak into python", !fixesForStack("python").some((f) => f.id === "dotnet-di-register"));

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL FIX-REGISTRY TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
