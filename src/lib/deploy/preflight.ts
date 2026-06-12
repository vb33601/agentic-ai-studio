import type { SourceFile } from "@/lib/ai/deps";
import { searchWeb } from "@/lib/ai/web-search";
import { prisma } from "@/lib/prisma";
import { ruleScores, weightOf } from "./learn";

/**
 * Technology-tagged PREFLIGHT REGISTRY: the basic rules each stack needs to run
 * correctly as a deployed app, plus the common break-classes that silently wreck
 * it (bad port bind, wrong DB connection shape, auth/identity type, frontend↔
 * client response-shape mismatch, …).
 *
 * Two tiers:
 *  - SEED (this file): curated, version-controlled rules distilled from real
 *    failures we've fixed. Deterministic, instant, the source of truth.
 *  - GROWN (Postgres, best-effort): on each generation/deploy we web-research the
 *    detected stack and upsert any new rules, so the registry KEEPS GROWING and
 *    future deploys of that stack reuse them without re-searching.
 *
 * Everything DB-touching is best-effort (try/catch) so a missing table or an
 * offline search never blocks a deploy — the seed rules always apply.
 */

/**
 * A deterministic, auto-applicable fix attached to a rule. Researched advisories
 * start WITHOUT one (they only inform the AI fixer); a fix is added either by
 * curation (seed) or by distilling a researched advisory, and is auto-applied
 * ONLY once `verified` is true — promoted after it has actually succeeded on real
 * deploys (the outcome ledger), so an unproven regex never touches user code.
 */
export interface RegistryFix {
  glob: string;   // RegExp source tested against the file path
  find: string;   // RegExp source
  replace: string;
  flags?: string; // default "g"
}

export interface PreflightRule {
  tech: string;
  ruleId: string;
  title: string;
  detail: string;
  source?: "seed" | "web";
  sourceUrl?: string;
  fix?: RegistryFix;
  verified?: boolean;
}

const r = (tech: string, ruleId: string, title: string, detail: string): PreflightRule => ({
  tech, ruleId, title, detail, source: "seed",
});

/** Curated seed rules, distilled from real fixes across this project. */
export const PREFLIGHT_SEED: PreflightRule[] = [
  // ---- universal backend ----
  r("backend", "port-bind", "Bind 0.0.0.0:$PORT", "A web server MUST listen on 0.0.0.0 (or [::]) and the host-injected $PORT, with a local fallback. A hardcoded host/port → unreachable container."),
  r("backend", "entry-exists", "Real entry file", "The start command/manifest must point at a file that exists and actually boots the server, or the container crashes with module-not-found."),
  r("backend", "secrets-from-env", "Config from env", "Read DATABASE_URL / secrets / PORT from the environment; never hardcode — the platform injects them at deploy."),
  // ---- node/express ----
  r("node", "express-cors", "Enable CORS", "Express backends must enable CORS (permissive or an env allow-list incl. *.vercel.app) or the browser blocks the frontend's calls."),
  {
    ...r("node", "listen-port", "app.listen(process.env.PORT)", "Listen on process.env.PORT with a fallback; bind all interfaces — a hardcoded port → unreachable container."),
    verified: true,
    // app.listen(3000) / .listen(8080,…) with a BARE numeric port → add the env
    // fallback. Idempotent: a call already using process.env.PORT has no bare
    // number to match. 2–5 digits avoids matching unrelated single-digit args.
    fix: { glob: "\\.(jsx?|tsx?|mjs|cjs)$", find: "(\\.listen\\(\\s*)(\\d{2,5})(\\s*[,)])", replace: "$1process.env.PORT || $2$3" },
  },
  // ---- python flask/fastapi/django ----
  r("flask", "gunicorn-bind", "gunicorn --bind [::]:$PORT", "Run under gunicorn bound to [::]/0.0.0.0 and $PORT; Flask's dev server / app.run under __main__ doesn't run in production."),
  r("flask", "jwt-string-sub", "JWT subject must be a string", "create_access_token(identity=str(user.id)) and int(get_jwt_identity()) on read — an int sub makes every protected route 422 'Subject must be a string'."),
  r("flask", "init-not-main", "Init/seed at module level", "Schema creation & seeding must run at import (or via the app factory), NOT only inside `if __name__ == '__main__'`, which gunicorn never executes."),
  r("python", "pg-driver", "Install psycopg2 for Postgres", "A SQLAlchemy/Django app given a Postgres DATABASE_URL needs a driver (psycopg2-binary) or it crashes on boot with ModuleNotFoundError."),
  r("fastapi", "uvicorn-bind", "uvicorn --host 0.0.0.0 --port $PORT", "ASGI server must bind all interfaces and $PORT."),
  r("django", "allowed-hosts", "ALLOWED_HOSTS for the deploy domain", "Set ALLOWED_HOSTS (and CSRF_TRUSTED_ORIGINS) for the host or Django returns 400 DisallowedHost."),
  // ---- .NET ----
  r("dotnet", "aspnetcore-urls", "ASPNETCORE_URLS=http://+:$PORT", "Rebind Kestrel to the injected $PORT via ASPNETCORE_URLS; `+` binds IPv4+IPv6."),
  r("dotnet", "npgsql-connstring", "Npgsql needs key-value, not a URL", "Npgsql can't read postgresql://… — supply a key-value string via ConnectionStrings__DefaultConnection (Server=;Port=;Database=;User Id=;Password=;SSL Mode=Require;Trust Server Certificate=true)."),
  // ---- spring ----
  r("spring", "datasource-jdbc", "SPRING_DATASOURCE_URL is JDBC", "Spring needs jdbc:postgresql://host:port/db plus SPRING_DATASOURCE_USERNAME/PASSWORD, not a postgres:// URL."),
  r("spring", "server-port", "server.port=$PORT", "Read PORT (server.port=${PORT}) so the app listens where the platform routes."),
  // ---- rails ----
  r("rails", "bind-port", "rails server -b 0.0.0.0 -p $PORT", "Bind all interfaces and $PORT; set SECRET_KEY_BASE; run db:prepare on boot."),
  // ---- frontend (any) ----
  r("frontend", "api-base-env", "API base from env", "Read the backend URL from an env var (VITE_API_URL/…) with a localhost fallback — never hardcode; the platform injects it at deploy."),
  r("frontend", "client-data-shape", "Match API client response shape", "A fetch wrapper returning res.json() yields the BODY — read fields directly (response.token), NOT axios-style response.data.token, or login silently fails."),
  r("frontend", "tailwind-setup", "Full Tailwind setup if used", "If you use Tailwind utility classes, include tailwindcss/postcss/autoprefixer + configs + a stylesheet with @tailwind directives IMPORTED from the entry, or the app ships unstyled."),
  r("frontend", "entry-exists", "Entry + root component exist", "index.html + main.jsx + root App (and every imported component) must exist or the build ships a blank page."),
];

/** Map a detected framework/stack slug to the registry's tech tags (most → 2). */
export function techTagsFor(framework: string): string[] {
  const f = framework.toLowerCase();
  const map: Record<string, string[]> = {
    express: ["backend", "node"], node: ["backend", "node"],
    flask: ["backend", "python", "flask"], fastapi: ["backend", "python", "fastapi"],
    django: ["backend", "python", "django"], python: ["backend", "python"],
    aspnet: ["backend", "dotnet"], dotnet: ["backend", "dotnet"],
    spring: ["backend", "spring"], rails: ["backend", "rails"],
    vite: ["frontend"], nextjs: ["frontend"], react: ["frontend"], static: ["frontend"],
  };
  return map[f] ?? ["backend"];
}

/** All seed rules for a framework (deterministic, instant). */
export function seedRulesFor(framework: string): PreflightRule[] {
  const tags = new Set(techTagsFor(framework));
  return PREFLIGHT_SEED.filter((rule) => tags.has(rule.tech));
}

/**
 * Web-research a stack's "must-haves + common errors" into candidate rules. Uses
 * the shared search layer (never throws). Coarse but real: each strong result
 * becomes an advisory rule the registry can store and surface. Distillation into
 * tighter rules is left to the AI auto-fix engine that consumes these.
 */
export async function researchStackRules(tech: string): Promise<PreflightRule[]> {
  const queries = [
    `${tech} production deployment common errors and required configuration`,
    `${tech} app won't start in docker container port binding fix`,
    `${tech} most common runtime exceptions and how to fix`,
  ];
  const seen = new Set<string>();
  const rules: PreflightRule[] = [];
  for (const q of queries) {
    const { results } = await searchWeb(q, 4);
    for (const res of results) {
      const key = res.url || res.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rules.push({
        tech,
        ruleId: `web-${hash(key)}`,
        title: (res.title || "").slice(0, 120) || "Researched advisory",
        detail: (res.snippet || res.title || "").slice(0, 600),
        source: "web",
        sourceUrl: res.url,
      });
    }
  }
  return rules;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Persisted (grown) rules for a tech. Best-effort: [] if the table/DB is absent. */
async function storedRulesFor(tech: string): Promise<PreflightRule[]> {
  try {
    const rows = await prisma.preflightRule.findMany({ where: { tech } });
    return rows.map((row) => ({ tech: row.tech, ruleId: row.ruleId, title: row.title, detail: row.detail, source: row.source as "seed" | "web", sourceUrl: row.sourceUrl ?? undefined }));
  } catch {
    return [];
  }
}

async function upsertRules(rules: PreflightRule[]): Promise<void> {
  for (const rule of rules) {
    try {
      await prisma.preflightRule.upsert({
        where: { tech_ruleId: { tech: rule.tech, ruleId: rule.ruleId } },
        update: { title: rule.title, detail: rule.detail, sourceUrl: rule.sourceUrl },
        create: { tech: rule.tech, ruleId: rule.ruleId, title: rule.title, detail: rule.detail, source: rule.source ?? "web", sourceUrl: rule.sourceUrl },
      });
    } catch {
      /* table absent / DB offline — keep going, seed rules still apply */
    }
  }
}

/**
 * On generation/deploy: ensure the registry has been researched for this stack,
 * GROW it with anything new, and return the full rule set (seed + stored). The
 * web research runs only when a tech hasn't been researched yet (cache-first via
 * the stored rows), so steady-state deploys don't re-search. Best-effort &
 * non-blocking — always returns at least the seed rules.
 */
export async function preflightForFramework(framework: string): Promise<PreflightRule[]> {
  const seed = seedRulesFor(framework);
  const primaryTech = techTagsFor(framework).slice(-1)[0]; // most specific tag
  const stored = await storedRulesFor(primaryTech);
  let rules: PreflightRule[];
  if (stored.length === 0) {
    // Not researched yet → research, persist (best-effort), grow the registry.
    const researched = await researchStackRules(primaryTech).catch(() => []);
    if (researched.length) await upsertRules(researched);
    rules = dedupe([...seed, ...researched]);
  } else {
    rules = dedupe([...seed, ...stored]);
  }
  // Learn: order by historical success so rules/fixes that have WORKED for this
  // tech float to the top and ones that have failed are demoted (neutral 0.5 when
  // there's no data yet). Curated seed rules tie-break above researched ones.
  const scores = await ruleScores(primaryTech);
  return rules
    .map((rule) => ({ rule, w: weightOf(scores, rule.ruleId) + (rule.source === "seed" ? 0.001 : 0) }))
    .sort((a, b) => b.w - a.w)
    .map(({ rule }) => rule);
}

function dedupe(rules: PreflightRule[]): PreflightRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const k = `${rule.tech}:${rule.ruleId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** One-time: persist the curated seed into the registry so it's queryable too. */
export async function ensureSeedPersisted(): Promise<void> {
  await upsertRules(PREFLIGHT_SEED.map((rule) => ({ ...rule, ruleId: `seed-${rule.ruleId}` })));
}

/** Short advisory lines for the deploy log (seed rules only — instant). */
export function preflightAdvisories(_files: SourceFile[], framework: string): string[] {
  return seedRulesFor(framework).map((rule) => `${rule.title} — ${rule.detail}`);
}

/**
 * Apply the registry's VERIFIED deterministic fixes for a framework to a file set.
 * Pure, idempotent, and conservative: only `verified` regex fixes whose tech tag
 * matches and whose glob matches the path are applied — researched-but-unproven
 * advisories never auto-edit code. Returns the (possibly) updated files + the ids
 * that fired. Synchronous, so it slots into the existing prepare pipelines.
 */
export function applyRegistryFixes<T extends { path: string; content: string }>(
  files: T[],
  framework: string,
): { files: T[]; applied: string[] } {
  const tags = new Set(techTagsFor(framework));
  const fixes = PREFLIGHT_SEED.filter((rule) => rule.verified && rule.fix && tags.has(rule.tech));
  if (fixes.length === 0) return { files, applied: [] };
  const applied = new Set<string>();
  const out = files.map((f) => {
    let content = f.content;
    for (const rule of fixes) {
      const fix = rule.fix!;
      if (!new RegExp(fix.glob).test(f.path)) continue;
      const next = content.replace(new RegExp(fix.find, fix.flags ?? "g"), fix.replace);
      if (next !== content) { applied.add(rule.ruleId); content = next; }
    }
    return content === f.content ? f : { ...f, content };
  });
  return { files: out, applied: [...applied] };
}

/**
 * Promotion gate: a stored, researched fix becomes auto-applicable (`verified`)
 * once it has a strong, corroborated track record — so the engine only starts
 * editing code with a fix AFTER it has proven itself. Curated seed fixes ship
 * pre-verified.
 */
export function shouldPromote(score: { success: number; total: number } | undefined): boolean {
  if (!score) return false;
  return score.total >= 3 && score.success / score.total >= 0.8;
}

/** Seed rules matching a detected technology list (for the auto-fix context). */
export function rulesForTechnologies(technologies: string[]): PreflightRule[] {
  const blob = technologies.join(" ").toLowerCase();
  const tags = new Set<string>();
  const kw: Array<[string, string[]]> = [
    ["express", ["backend", "node"]], ["node", ["backend", "node"]],
    ["flask", ["backend", "python", "flask"]], ["fastapi", ["backend", "python", "fastapi"]],
    ["django", ["backend", "python", "django"]], ["python", ["backend", "python"]],
    ["csproj", ["backend", "dotnet"]], ["dotnet", ["backend", "dotnet"]], ["aspnet", ["backend", "dotnet"]],
    ["spring", ["backend", "spring"]], ["rails", ["backend", "rails"]],
    ["react", ["frontend"]], ["vite", ["frontend"]], ["next", ["frontend"]], ["vue", ["frontend"]],
  ];
  for (const [k, ts] of kw) if (blob.includes(k)) ts.forEach((t) => tags.add(t));
  return PREFLIGHT_SEED.filter((rule) => tags.has(rule.tech));
}
