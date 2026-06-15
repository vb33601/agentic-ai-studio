import type { HardeningPass } from "./hardening-matrix";
import { recordFixOutcome, ruleScores, weightOf, type RuleScore } from "./learn";

/**
 * The rule engine's MEMORY — one canonical record of every deploy fix the engine
 * has learned to make, distilled from the production failures that motivated each
 * one. It exists so the system as a whole satisfies three properties the ad-hoc
 * collection of passes couldn't on its own:
 *
 *  1. **Recorded.** Every fix-to-date lives here with the error SIGNATURE that
 *     triggers it, the stacks it applies to, and the module that implements it —
 *     a single source of truth instead of knowledge scattered across a dozen files.
 *
 *  2. **Recognised.** `matchKnownFix(errorLog)` maps a raw build/deploy error back
 *     to the fixes that address it, so when a deploy fails the engine already knows
 *     "this is the truncated-source class — repair-truncated-source handles it"
 *     instead of rediscovering it. New failures that match NOTHING are the signal
 *     that a genuinely new fix is needed (see `unmatchedFailure`).
 *
 *  3. **Propagated + self-correcting.** Each entry declares the stacks it applies
 *     to, and `fix-registry.test.mts` asserts every `HardeningPass` and every
 *     runtime `HardenRule` has a registry entry — so a fix added for one technology
 *     can't be silently left unregistered for the 40+ others. Outcomes feed
 *     `learn.ts`: `rankFixes` orders applicable fixes by their learned success
 *     rate, and a fix whose success rate decays (it started breaking deploys) sorts
 *     down and is flagged — the "fixing one thing broke another" feedback loop.
 *
 * Keep this list in lockstep with the implementing modules: adding a pass/rule
 * without a registry entry fails the completeness test by design.
 */

export type FixPhase = "build" | "deploy" | "health" | "smoke" | "runtime";

export interface FixRule {
  /** Stable id — ALSO the `ruleId` used by learn.ts, so outcomes attribute here. */
  id: string;
  title: string;
  /** What goes wrong without it (the production symptom). */
  symptom: string;
  /** Error-log signatures that identify this failure class, for matchKnownFix(). */
  signatures: RegExp[];
  /** Stacks/frameworks this applies to. `["*"]` = universal. */
  appliesTo: string[];
  /** The source module that implements the fix. */
  module: string;
  /** Which deploy phase the failure surfaces in. */
  phase: FixPhase;
  /** The matrix pass this corresponds to, when it is one. */
  pass?: HardeningPass;
}

export const FIX_REGISTRY: FixRule[] = [
  // ─────────────────────── Universal source-integrity fixes ───────────────────────
  {
    id: "repair-truncated-source",
    title: "Repair source the generator cut off mid-construct",
    symptom:
      "An LLM-generated file ends mid-statement (`function` with nothing after it, an unclosed brace), so the bundler/compiler dies and — on Fly — the app is created but no machine ever releases.",
    signatures: [
      /Expected identifier but found end of file/i,
      /Unexpected end of (?:file|input)/i,
      /Unexpected token, expected/i,
      /Unterminated (?:string|template|comment|regexp)/i,
      /declaration or statement expected/i,
      /\bCS1513\b/,                 // C#: } expected (truncated mid-method/class)
      /\bCS1002\b/,                 // C#: ; expected (truncated mid-statement)
      /error[: ].*['"}\]] expected/i,
    ],
    appliesTo: ["*"],
    module: "truncation.ts",
    phase: "build",
    pass: "repair-truncated-source",
  },
  {
    id: "strip-broken-files",
    title: "Drop source files that are actually markup/XML",
    symptom:
      "A `.cs/.fs/.vb` whose body is really an MSBuild `<Project>` is compiled as code and fails (StockPortfolio: CS1525 on '<').",
    signatures: [/CS1525/, /error CS\d+: *Invalid expression term '<'/, /\bThe name '.*' does not exist\b/],
    appliesTo: ["*"],
    module: "schema.ts",
    phase: "build",
    pass: "strip-broken-files",
  },

  // ─────────────────────── Schema / migrations (ORM-bearing stacks) ───────────────────────
  {
    id: "schema-autocreate",
    title: "No migrations — auto-create the schema from the model",
    symptom:
      "Generated migration scaffolding doesn't compile (.NET) or drifts from the models (Django/Rails/Prisma) and kills the build or first boot.",
    signatures: [/relation \".*\" does not exist/i, /no such table/i, /PendingModelChangesWarning/i, /Migration .* failed/i],
    appliesTo: ["dotnet", "django", "rails", "spring", "node"],
    module: "schema.ts",
    phase: "deploy",
    pass: "schema-autocreate",
  },

  // ─────────────────────── .NET-specific defect classes ───────────────────────
  {
    id: "dotnet-program-builder",
    title: "Strip a hallucinated `builder.CreateBuilder()` that fails the .NET publish",
    symptom:
      "Generated Program.cs emits a bogus `var app = builder.CreateBuilder();` (CreateBuilder is only the static WebApplication.CreateBuilder) → CS1061, the publish fails to compile, and on Fly the app is created but no release/machine ever appears: stuck 'pending' forever with zero deploy feedback.",
    signatures: [
      /does not contain a definition for 'CreateBuilder'/i,
      /\bCS1061\b.*CreateBuilder/i,
      /'WebApplicationBuilder'.*CreateBuilder/i,
    ],
    appliesTo: ["dotnet"],
    module: "dotnet.ts",
    phase: "build",
    pass: "dotnet-program-builder",
  },
  {
    id: "dotnet-package-conflict",
    title: "Resolve .NET NU1605 package downgrade at the source",
    symptom: "Generated package pins downgrade a transitive dependency; restore aborts (NU1605), or the app 500s on a missing assembly.",
    signatures: [/NU1605/, /Detected package downgrade/i],
    appliesTo: ["dotnet"],
    module: "dotnet.ts",
    phase: "build",
    pass: "dotnet-package-conflict",
  },
  {
    id: "dotnet-di-register",
    title: "Register injected-but-unregistered .NET services",
    symptom: "A controller injects an app service Program.cs never wired into DI → every request 500s 'Unable to resolve service'.",
    signatures: [/Unable to resolve service for type/i, /InvalidOperationException: Unable to resolve/i],
    appliesTo: ["dotnet"],
    module: "dotnet.ts",
    phase: "health",
    pass: "dotnet-di-register",
  },
  {
    id: "dotnet-di-prune",
    title: "Prune DI registrations for undefined services",
    symptom: "AddScoped<IFoo, Foo> with no such type fails the build with CS0246.",
    signatures: [/CS0246/, /The type or namespace name '.*' could not be found/i],
    appliesTo: ["dotnet"],
    module: "dotnet.ts",
    phase: "build",
    pass: "dotnet-di-prune",
  },

  // ─────────────────────── Datasource coercion (baked-in local DB → managed Postgres) ───────────────────────
  // One class of defect across every ORM-bearing stack: the generator hard-codes a
  // local-dev database (H2/SQLite/DB_CONNECTION=sqlite); the pipeline injects a
  // managed Postgres URL but the baked-in driver/provider/dialect hijacks it, so the
  // app deploys then dies at boot/first query. Each entry re-points it to Postgres.
  {
    id: "spring-datasource-postgres",
    title: "Spring: bind the Postgres driver/dialect so a baked-in H2 datasource can't hijack the managed URL",
    symptom:
      "A generated Spring app ships an H2 dev datasource (driver pinned in application.properties, H2 the only DB dependency). The pipeline injects a Postgres jdbc URL but not the driver/dialect, so HikariCP boots with org.h2.Driver, rejects the jdbc:postgresql URL, and the whole context fails: entityManagerFactory → userRepository → app down (0 machines on Fly).",
    signatures: [
      /Driver org\.h2\.Driver claims to not accept jdbcUrl/i,
      /claims to not accept jdbcUrl, *jdbc:postgresql/i,
      /Unable to build Hibernate SessionFactory/i,
    ],
    appliesTo: ["spring"],
    module: "datasource/spring.ts + db-env.ts",
    phase: "deploy",
    pass: "spring-datasource-postgres",
  },
  {
    id: "prisma-datasource-postgres",
    title: "Prisma: switch the datasource provider sqlite → postgresql",
    symptom:
      "A generated app's schema.prisma pins `provider = \"sqlite\"` (url file:./dev.db). The pipeline injects a Postgres DATABASE_URL, but Prisma refuses a postgres URL under a sqlite provider — `prisma db push`/client init errors 'the URL must start with the protocol file:' — so deploy or first query fails.",
    signatures: [
      /the URL must start with the protocol `?file:/i,
      /provider.*sqlite.*does not match/i,
      /datasource .* provider .* sqlite/i,
    ],
    appliesTo: ["node", "bun"],
    module: "datasource/prisma.ts",
    phase: "deploy",
    pass: "prisma-datasource-postgres",
  },
  {
    id: "dotnet-datasource-postgres",
    title: ".NET/EF: swap UseSqlite() → UseNpgsql() for the managed Postgres",
    symptom:
      "Generated EF Core apps call `UseSqlite(connectionString)` in Program.cs. Fed the managed Postgres connection string, SQLite's parser throws 'keyword 'host' not supported' (or 'Format of the initialization string'), 500ing every request.",
    signatures: [
      /keyword 'host' not supported/i,
      /SqliteConnection.*host/i,
      /Format of the initialization string does not conform/i,
    ],
    appliesTo: ["dotnet"],
    module: "datasource/dotnet.ts",
    phase: "runtime",
    pass: "dotnet-datasource-postgres",
  },
  {
    id: "rails-datasource-postgres",
    title: "Rails: re-point database.yml adapter sqlite3 → postgresql (+ pg gem)",
    symptom:
      "A generated Rails app's config/database.yml uses `adapter: sqlite3` for production and ships only the sqlite3 gem. With the managed Postgres DATABASE_URL it either loads the wrong adapter (LoadError: pg) or silently writes to ephemeral SQLite that resets every redeploy. (The pg gem is added to the Gemfile; the image's non-frozen `bundle install` resolves it without touching Gemfile.lock by hand.)",
    signatures: [
      /Please install the postgresql adapter/i,
      /could not load .*['"]pg['"]/i,
      /Specified 'sqlite3' for database adapter, but the gem is not loaded/i,
    ],
    appliesTo: ["rails"],
    module: "datasource/rails.ts",
    phase: "deploy",
    pass: "rails-datasource-postgres",
  },
  {
    id: "django-datasource-postgres",
    title: "Django: honor the managed Postgres DATABASE_URL instead of hard-coded SQLite",
    symptom:
      "A generated Django settings.py hard-codes `ENGINE: django.db.backends.sqlite3` and never reads DATABASE_URL, so the injected Postgres is ignored and writes go to ephemeral SQLite (data lost on redeploy; or the sqlite file is read-only and 500s).",
    signatures: [
      /django\.db\.backends\.sqlite3/i,
      /attempt to write a readonly database/i,
      /unable to open database file/i,
    ],
    appliesTo: ["django"],
    module: "datasource/django.ts",
    phase: "runtime",
    pass: "django-datasource-postgres",
  },
  {
    id: "laravel-datasource-postgres",
    title: "Laravel: set DB_CONNECTION=pgsql (+ discrete DB_*) for the managed Postgres",
    symptom:
      "A generated Laravel app defaults DB_CONNECTION to sqlite, so the managed Postgres is ignored — it writes to a local SQLite file (ephemeral, resets on redeploy) or 500s with 'database file does not exist'.",
    signatures: [
      /Database \(.*\.sqlite\) does not exist/i,
      /could not find driver/i,
      /SQLSTATE\[HY000\].*database/i,
    ],
    appliesTo: ["laravel"],
    module: "datasource/laravel.ts + db-env.ts",
    phase: "runtime",
    pass: "laravel-datasource-postgres",
  },

  // ─────────────────────── Cross-stack CORS ───────────────────────
  {
    id: "cors",
    title: "Open CORS for the split-deployed frontend (web frameworks)",
    symptom: "A backend ships no CORS, so the Vercel-hosted frontend gets 'Failed to fetch' / blocked-by-CORS in the browser.",
    signatures: [/blocked by CORS policy/i, /No 'Access-Control-Allow-Origin'/i, /Failed to fetch/i],
    appliesTo: ["node", "python"],
    module: "cors-harden.ts",
    phase: "smoke",
    pass: "cors",
  },
  {
    id: "dotnet-cors",
    title: "Open CORS on a generated .NET API",
    symptom: "Generated ASP.NET APIs ship no CORS policy, so the split frontend's calls are blocked in the browser.",
    signatures: [/blocked by CORS policy/i, /No 'Access-Control-Allow-Origin'/i],
    appliesTo: ["dotnet"],
    module: "dotnet.ts",
    phase: "smoke",
    pass: "dotnet-cors",
  },

  // ─────────────────────── Runtime readiness (deps) ───────────────────────
  {
    id: "dep-reconcile",
    title: "Add deps used in code but missing from the manifest",
    symptom: "An interpreted app installs only declared deps; an undeclared import crashes on first request.",
    signatures: [/ModuleNotFoundError: No module named/i, /Cannot find module '/i, /cannot load such file/i],
    appliesTo: ["python", "node", "bun", "ruby"],
    module: "runtime-harden.ts",
    phase: "runtime",
    pass: "dep-reconcile",
  },
  {
    id: "go-mod-tidy",
    title: "Back-fill go.mod/go.sum from source",
    symptom: "Generated Go source imports packages absent from go.mod → the build fails to resolve them.",
    signatures: [/missing go\.sum entry/i, /no required module provides package/i],
    appliesTo: ["go"],
    module: "runtime-harden.ts",
    phase: "build",
    pass: "go-mod-tidy",
  },

  // ─────────────────────── Fly IPv6 reachability ───────────────────────
  {
    id: "fly-needs-dockerfile",
    title: "Synthesize a Dockerfile for Node backends deployed to Fly",
    symptom:
      "Fly builds a Docker image, but the Node backend path ships only Render-native build/start commands (no Dockerfile) → `flyctl deploy` fails 'Dockerfile not found' and the Fly app hangs at 0 machines.",
    signatures: [
      /failed to fetch an image or build from source/i,
      /[Dd]ockerfile '.*' not found/,
      /Dockerfile not found/i,
    ],
    appliesTo: ["node"],
    module: "providers/container-deploy.ts",
    phase: "build",
  },
  {
    id: "bind-dual-stack",
    title: "Bind [::] so the app is reachable on Fly's IPv6 proxy",
    symptom: "An app bound only to 0.0.0.0 (IPv4) is unreachable behind Fly's IPv6 proxy: TLS completes, empty reply. (Works on Render.)",
    signatures: [/empty reply from server/i, /connection reset by peer/i, /instance refused connection/i],
    appliesTo: ["*"],
    module: "universal-prepare.ts",
    phase: "smoke",
  },

  // ─────────────────────── Frontend (Vercel) build/look ───────────────────────
  {
    id: "ensure-tailwind-setup",
    title: "Synthesize a real Tailwind setup when classes are used but never configured",
    symptom: "Components use Tailwind utility classes but the app never set Tailwind up → it deploys 'successfully' but renders as raw, unstyled HTML.",
    signatures: [/Cannot find module 'tailwindcss'/i, /@tailwind|tailwind\.config/i],
    appliesTo: ["node"],
    module: "frontend-prepare.ts",
    phase: "build",
  },
  {
    id: "pin-tailwind-v3",
    title: "Pin Tailwind to v3 (v4 moved the PostCSS plugin)",
    symptom: "v3-style `@tailwind` config installs v4 (latest) → `vite build` fails on the relocated PostCSS plugin.",
    signatures: [/tailwindcss directly as a PostCSS plugin/i, /@tailwindcss\/postcss/i],
    appliesTo: ["node"],
    module: "frontend-prepare.ts",
    phase: "build",
  },
  {
    id: "stub-missing-imports",
    title: "Stub still-missing local imports",
    symptom: "A module imports a local file the generator never produced → bundler 'Failed to resolve import'.",
    signatures: [/Failed to resolve import/i, /Could not resolve "\.\//i, /Module not found: Can't resolve/i],
    appliesTo: ["node"],
    module: "prepare.ts",
    phase: "build",
  },
  {
    id: "api-response-data-compat",
    title: "Make a fetch client's body also readable as `.data`",
    symptom: "A fetch client returns the raw body but consumers read it axios-style (`response.data.x`) → `.data` is always undefined and login silently stores nothing.",
    signatures: [/Cannot (?:read|destructure) propert(?:y|ies) of undefined \(reading 'data'\)/i],
    appliesTo: ["node"],
    module: "harden.ts",
    phase: "runtime",
  },
  {
    id: "safe-destructure",
    title: "Default destructuring of a nullable RHS to {} / []",
    symptom: "`const { token } = res.data` throws when an API response is empty, crashing the whole render.",
    signatures: [/Cannot destructure property '.*' of/i],
    appliesTo: ["node"],
    module: "harden.ts",
    phase: "runtime",
  },
  {
    id: "safe-array-iteration",
    title: "Default `obj.list.map(...)` over a nullable chain to []",
    symptom: "`data.users.map(...)` throws 'Cannot read properties of undefined (reading map)' when the API returns nothing.",
    signatures: [/Cannot read properties of undefined \(reading '(?:map|filter|forEach|reduce|some|every|find)'\)/i],
    appliesTo: ["node"],
    module: "harden.ts",
    phase: "runtime",
  },
];

/** Every registered fix id (also the set of valid learning ruleIds). */
export const FIX_IDS: ReadonlySet<string> = new Set(FIX_REGISTRY.map((f) => f.id));

/** Fixes whose declared scope covers a given stack/framework. */
export function fixesForStack(stack: string): FixRule[] {
  return FIX_REGISTRY.filter((f) => f.appliesTo.includes("*") || f.appliesTo.includes(stack));
}

/**
 * Map a raw build/deploy error log back to the fixes that address it. The engine's
 * "I've seen this class before" recognizer — drives auto-application and tells the
 * operator which pass should have caught it.
 */
export function matchKnownFix(errorLog: string): FixRule[] {
  if (!errorLog) return [];
  return FIX_REGISTRY.filter((f) => f.signatures.some((re) => re.test(errorLog)));
}

/** True when a failure matches NO known fix — the trigger to author a new rule. */
export function unmatchedFailure(errorLog: string): boolean {
  return errorLog.trim().length > 0 && matchKnownFix(errorLog).length === 0;
}

export interface RankedFix extends FixRule {
  /** Learned success rate in (0,1); 0.5 when unseen. */
  weight: number;
  /** Below this, the fix has been REGRESSING deploys and should be reviewed. */
  flagged: boolean;
}

/**
 * Order the fixes applicable to a stack by their learned success rate, so the
 * engine prefers what has actually been working and surfaces (flags) any fix whose
 * outcomes have decayed — i.e. a fix that started breaking other deploys. Falls
 * back to curated order when there's no outcome data yet.
 */
export async function rankFixes(stack: string, flagThreshold = 0.4): Promise<RankedFix[]> {
  let scores: Map<string, RuleScore>;
  try {
    scores = await ruleScores(stack);
  } catch {
    scores = new Map();
  }
  return fixesForStack(stack)
    .map((f) => {
      const weight = weightOf(scores, f.id);
      return { ...f, weight, flagged: (scores.get(f.id)?.total ?? 0) >= 3 && weight < flagThreshold };
    })
    .sort((a, b) => b.weight - a.weight);
}

/** Record the result of applying a registered fix (no-op without a DB). */
export async function recordFix(
  stack: string,
  fixId: string,
  success: boolean,
  opts: { errorSignature?: string; phase?: FixPhase; details?: string } = {},
): Promise<void> {
  await recordFixOutcome({
    tech: stack,
    ruleId: fixId,
    action: fixId,
    success,
    errorSignature: opts.errorSignature,
    phase: opts.phase === "runtime" ? "deploy" : opts.phase,
    details: opts.details,
  });
}
