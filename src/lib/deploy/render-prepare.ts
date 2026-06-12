import type { RepoFile } from "./github";
import { applyRegistryFixes } from "./preflight";

/**
 * Prepare a generated backend for Render + a managed Postgres (Aiven).
 *
 * Auto-detects the backend even when the user selected a PARENT folder (a
 * monorepo root, or a full-stack app with frontend/+backend/): it finds the
 * package.json folder that looks like a server (express/fastify/Prisma/…, not a
 * frontend or the root orchestrator), re-roots to it, then:
 *  - swaps the Prisma datasource sqlite → postgresql (preview uses SQLite),
 *  - binds the server to Render's $PORT (generated apps often hardcode a port),
 *  - derives build & start commands (install + prisma generate + migrate/push).
 *
 * Pure functions over {path, content} files; safe on the server.
 */

export interface BackendPrep {
  files: RepoFile[];
  buildCommand: string;
  startCommand: string;
  usesPrisma: boolean;
  /** The detected backend source folder within the input ("" = already root). */
  backendDir: string;
  /**
   * Whether the input actually contains a runnable server. False for
   * frontend-only projects (or monorepo roots whose `backend/` was never
   * generated) — deploying those to Render just crashes at `node …` startup.
   */
  hasBackend: boolean;
  /** Non-fatal advisories to show in the deploy log (e.g. ephemeral storage). */
  warnings: string[];
}

// File-based SQLite drivers: they work on Render but write to EPHEMERAL disk, so
// data is lost on restart/redeploy. (Prisma+sqlite is handled separately by the
// sqlite→postgres swap, so it's excluded here.)
const RAW_SQLITE_DEPS = ["better-sqlite3", "sqlite3", "sql.js"];

const SRC_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;

const BACKEND_DEPS = [
  "express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "hapi", "restify",
  "mongoose", "sequelize", "typeorm", "pg", "mysql2", "sqlite3", "better-sqlite3",
  "apollo-server", "apollo-server-express", "socket.io", "@prisma/client", "prisma",
];
const FRONTEND_DEPS = [
  "vite", "next", "react-scripts", "@vitejs/plugin-react", "react-dom",
  "@angular/core", "vue", "svelte", "@sveltejs/kit", "nuxt", "gatsby", "astro",
];

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function readJson(content: string): Record<string, unknown> | null {
  try { return JSON.parse(content); } catch { return null; }
}

function depKeys(parsed: Record<string, unknown> | null): Set<string> {
  return new Set([
    ...Object.keys((parsed?.dependencies as Record<string, string> | undefined) || {}),
    ...Object.keys((parsed?.devDependencies as Record<string, string> | undefined) || {}),
  ]);
}

/**
 * Pick the backend folder among the workspace's package.json folders. Scores by
 * backend deps, a backend-ish folder name, and a Prisma schema underneath;
 * skips pure frontends. Returns "" when there's a single app at the root.
 */
export function detectBackendDir(files: RepoFile[]): string {
  const pkgs = files.filter((f) => f.path === "package.json" || f.path.endsWith("/package.json"));
  if (pkgs.length <= 1) return pkgs.length ? dirOf(pkgs[0].path) : "";

  let best = dirOf(pkgs[0].path);
  let bestScore = -Infinity;
  for (const p of pkgs) {
    const dir = dirOf(p.path);
    const deps = depKeys(readJson(p.content));
    const backendHits = BACKEND_DEPS.filter((d) => deps.has(d)).length;
    const isFrontend = FRONTEND_DEPS.some((d) => deps.has(d));
    if (isFrontend && backendHits === 0) continue; // pure frontend — never the backend

    let score = backendHits * 2;
    if (/(^|\/)(backend|server|api)$/i.test(dir)) score += 6;
    const prefix = dir ? `${dir}/` : "";
    if (files.some((f) => f.path.startsWith(prefix) && /(^|\/)schema\.prisma$/.test(f.path))) score += 4;
    if (score > bestScore) { bestScore = score; best = dir; }
  }
  return best;
}

function reRoot(files: RepoFile[], dir: string): RepoFile[] {
  if (!dir) return files;
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
}

function toPostgres(schema: string): string {
  return schema.replace(/provider\s*=\s*["']sqlite["']/g, 'provider = "postgresql"');
}

/** Make a server listen on Render's injected $PORT instead of a hardcoded one. */
function bindToEnvPort(content: string): string {
  return content.replace(/\.listen\(\s*(\d{2,5})\b/g, (_m, port) => `.listen(process.env.PORT || ${port}`);
}

/** @prisma/client is CommonJS — named imports break under ESM. Use default import. */
function fixPrismaImport(content: string): string {
  return content.replace(
    /import\s*\{([^}]+)\}\s*from\s*(['"])@prisma\/client\2\s*;?/g,
    (_m, names) => `import __prismaPkg from '@prisma/client';\nconst { ${String(names).trim()} } = __prismaPkg;`,
  );
}

/** Drop DATABASE_URL/PORT from a committed .env so the host's values win. */
function sanitizeEnv(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^\s*(DATABASE_URL|PORT)\s*=/.test(line))
    .join("\n");
}

/**
 * Pin Prisma to v6. The generated schema uses `url = env(...)` in the datasource,
 * which Prisma 7 rejects (P1012 — must move to prisma.config.ts + a driver
 * adapter). v6 still supports it, so deploys build without a schema rewrite.
 */
function pinPrismaV6(pkgContent: string): string {
  try {
    const p = JSON.parse(pkgContent);
    for (const sec of ["dependencies", "devDependencies"] as const) {
      if (p[sec]?.["@prisma/client"]) p[sec]["@prisma/client"] = "^6.0.0";
      if (p[sec]?.["prisma"]) p[sec]["prisma"] = "^6.0.0";
    }
    return JSON.stringify(p, null, 2);
  } catch {
    return pkgContent;
  }
}

const ENV_FILE = /(^|\/)\.env(\.|$)/;

/**
 * Give a deployed app its OWN Postgres schema so its tables never collide with
 * the platform's (or another app's) tables in the shared Aiven `defaultdb`.
 * Prisma creates the schema on `db push`/`migrate`.
 */
export function appDatabaseUrl(baseUrl: string, appName: string): string {
  const schema = appName.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z_]/, "a_").slice(0, 48);
  return baseUrl + (baseUrl.includes("?") ? "&" : "?") + `schema=${schema}`;
}

/**
 * DATABASE_URL for a NON-Prisma container app (Flask/Django/FastAPI, Rails, …)
 * that reads the URL directly. Unlike the Prisma path we must NOT append the
 * Prisma-only `schema=` param (libpq/psycopg2/ActiveRecord reject it — it crashes
 * the app at boot), and we normalize the scheme to `postgresql://` because
 * SQLAlchemy 2.x rejects the bare `postgres://` Aiven hands out.
 *
 * When `schema` is given, the app is ISOLATED to its own schema via the libpq
 * `options=-c search_path=<schema>,public` connection param (honored by
 * psycopg2 / libpq / lib-pq-based drivers — Python, Ruby, PHP, Go). Without it,
 * every container app shares `public` and their tables collide. (Npgsql/JDBC use
 * their own schema params via `databaseEnvForFramework`, not the URL.)
 */
export function containerDatabaseUrl(baseUrl: string, schema?: string): string {
  let url = baseUrl.replace(/^postgres:\/\//, "postgresql://");
  // Defensively drop a Prisma-style schema param if the base ever carries one.
  url = url.replace(/([?&])schema=[^&]*/g, "$1").replace(/[?&]$/, "").replace(/\?&/, "?").replace(/&&/g, "&");
  if (schema && /^[a-z][a-z0-9_]*$/.test(schema)) {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
  }
  return url;
}

/**
 * Make the backend honor the frontend's (dynamic) origin for cross-origin calls.
 * The browser on the Vercel domain calls the Render backend directly whenever the
 * frontend uses an absolute API URL (VITE_API_URL/etc.), so the server must send
 * CORS headers for that origin — which isn't known until deploy time.
 *
 * The frontend's URL is dynamic: Vercel serves it at both a stable production
 * alias (`<project>.vercel.app`) and an immutable per-deploy URL
 * (`<project>-<hash>.vercel.app`) — both end in `.vercel.app`. So instead of
 * pinning one URL (which misses the other and needs a second deploy to fix), the
 * backend reflects ANY `*.vercel.app` origin, plus an explicit `CORS_ORIGIN`
 * allow-list for anything else. We:
 *  - rewrite hardcoded localhost CORS origins to this rule,
 *  - inject the `cors` middleware into an Express server that has none,
 *  - add `cors` to dependencies when we rely on it.
 */
const CORS_ORIGIN_FN =
  "(origin, cb) => cb(null, !origin || /\\.vercel\\.app$/.test(origin) || (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean).includes(origin))";

function usesExpress(files: RepoFile[]): boolean {
  return files.some(
    (f) => SRC_EXT.test(f.path) && /(require\(\s*['"]express['"]\s*\)|from\s+['"]express['"])/.test(f.content),
  );
}

function hasCorsUsage(files: RepoFile[]): boolean {
  return files.some((f) => SRC_EXT.test(f.path) && /\bcors\s*\(/.test(f.content));
}

/** Replace hardcoded localhost CORS origins with the dynamic allow rule. */
function normalizeCorsOrigin(content: string): string {
  return content
    .replace(/origin\s*:\s*(["'])https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\1/g, `origin: ${CORS_ORIGIN_FN}`)
    .replace(/origin\s*:\s*\[[^\]]*(?:localhost|127\.0\.0\.1)[^\]]*\]/g, `origin: ${CORS_ORIGIN_FN}`);
}

/** Inject `cors` into the Express entry file that defines `… = express()`. */
function injectCors(content: string): string | null {
  const init = /((?:const|let|var)\s+(\w+)\s*=\s*express\(\)\s*;?)/.exec(content);
  if (!init) return null;
  const appVar = init[2];
  const esm = /(^|\n)\s*import\s.+from\s/.test(content) || /(^|\n)\s*import\s+['"]/.test(content);
  const importLine = esm ? "import cors from 'cors';\n" : "const cors = require('cors');\n";
  const middleware = `\n${appVar}.use(cors({ origin: ${CORS_ORIGIN_FN}, credentials: true }));`;
  // Add the import at the very top, the middleware right after the app is created.
  const withMiddleware = content.replace(init[1], `${init[1]}${middleware}`);
  return importLine + withMiddleware;
}

function addDep(pkgContent: string, name: string, version: string, dev = false): string {
  try {
    const p = JSON.parse(pkgContent);
    const sec = dev ? "devDependencies" : "dependencies";
    p[sec] = p[sec] || {};
    if (!p[sec][name] && !p.dependencies?.[name] && !p.devDependencies?.[name]) p[sec][name] = version;
    return JSON.stringify(p, null, 2);
  } catch {
    return pkgContent;
  }
}

/** Wire CORS across the backend files. Returns the (possibly) updated files. */
function wireBackendCors(files: RepoFile[], entry: string): RepoFile[] {
  const out = files.map((f) =>
    SRC_EXT.test(f.path) ? { path: f.path, content: normalizeCorsOrigin(f.content) } : f,
  );

  let reliesOnCors = out.some((f) => SRC_EXT.test(f.path) && /\bcors\s*\(/.test(f.content));

  // No CORS anywhere but it's an Express app → inject it into the entry file.
  if (!hasCorsUsage(out) && usesExpress(out)) {
    const i = out.findIndex((f) => f.path === entry);
    if (i !== -1) {
      const injected = injectCors(out[i].content);
      if (injected) {
        out[i] = { path: entry, content: injected };
        reliesOnCors = true;
      }
    }
  }

  if (reliesOnCors) {
    const pi = out.findIndex((f) => f.path === "package.json");
    if (pi !== -1) out[pi] = { path: "package.json", content: addDep(out[pi].content, "cors", "^2.8.5") };
  }
  return out;
}

/**
 * Resolve how to seed the database after the schema is applied, so deploys load
 * initial/seed data — not just create empty tables. Honors, in order: a configured
 * `prisma.seed`, an npm `seed` script, or a bare prisma/seed file (for which we add
 * the `prisma.seed` config + a `tsx`/`node` runner). Returns the build step to run
 * plus any package.json change needed.
 */
function resolveSeed(
  files: RepoFile[],
  parsed: Record<string, unknown> | null,
  scripts: Record<string, string>,
): { step: string | null; pkg: string | null } {
  const prismaCfg = (parsed?.prisma as { seed?: unknown } | undefined) || undefined;
  if (prismaCfg?.seed) return { step: "npx prisma db seed", pkg: null };
  if (typeof scripts.seed === "string") return { step: "npm run seed", pkg: null };

  const seedFile = files.find((f) => /(^|\/)(prisma\/)?seed\.(t|j)sx?$/.test(f.path));
  if (!seedFile) return { step: null, pkg: null };

  const pi = files.findIndex((f) => f.path === "package.json");
  if (pi === -1) return { step: null, pkg: null };
  const isTs = /\.tsx?$/.test(seedFile.path);
  try {
    const p = JSON.parse(files[pi].content);
    p.prisma = { ...(p.prisma || {}), seed: isTs ? `tsx ${seedFile.path}` : `node ${seedFile.path}` };
    if (isTs) {
      p.devDependencies = p.devDependencies || {};
      if (!p.devDependencies.tsx && !p.dependencies?.tsx) p.devDependencies.tsx = "^4.0.0";
    }
    return { step: "npx prisma db seed", pkg: JSON.stringify(p, null, 2) };
  } catch {
    return { step: null, pkg: null };
  }
}

/** Pull a script's run target, e.g. "node src/index.js" -> "src/index.js". */
function scriptEntryTarget(script: string | undefined): string | null {
  if (!script) return null;
  const m = /\b(?:node|nodemon|ts-node|tsx)\b([^&|;]*)/.exec(script);
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/).filter(Boolean).filter((t) => !t.startsWith("-"));
  return tokens.find((t) => /\.[cm]?[jt]sx?$/.test(t)) || tokens[0] || null;
}

/** A source file that imports/requires a server framework — the strongest
 *  signal of real backend code (vs `express` merely living in an orchestrator's
 *  root deps for `concurrently`). */
function importsServerFramework(content: string): boolean {
  return /(?:require\(\s*['"]|from\s+['"])(express|fastify|koa|@nestjs\/core|@hapi\/hapi|restify|apollo-server[\w-]*)['"]/.test(content);
}

/** Real, deployable backend source: a Prisma schema or a file that imports a
 *  server framework. Used so we don't fabricate/deploy a backend for a monorepo
 *  ROOT that just has `express` in its deps but no actual server. */
function hasServerSource(files: RepoFile[]): boolean {
  return files.some(
    (f) =>
      /(^|\/)schema\.prisma$/.test(f.path) ||
      (SRC_EXT.test(f.path) && importsServerFramework(f.content)),
  );
}

/** Whether a package.json "start" script actually runs THIS service — not a
 *  monorepo orchestrator that delegates to a sibling dir (`--prefix`/`cd`) or
 *  runs several processes (concurrently), nor one pointing at a missing entry. */
function startScriptRunnable(start: string | undefined, files: RepoFile[]): boolean {
  if (!start) return false;
  if (/\bconcurrently\b|\bnpm-run-all\b/.test(start)) return false;
  const deleg = /(?:--prefix|--cwd|-C)\s+(\S+)|\bcd\s+(\S+)/.exec(start);
  if (deleg) {
    const dir = (deleg[1] || deleg[2]).replace(/['"]/g, "").replace(/\/$/, "");
    return files.some((f) => f.path === `${dir}/package.json`);
  }
  const target = scriptEntryTarget(start);
  if (target) return files.some((f) => f.path === target);
  return true; // a command we can't introspect (e.g. "node .") — trust it
}

/** Relative require/import specifier (no extension) from a dir to a target file. */
function relRequire(fromDir: string, target: string): string {
  const noExt = target.replace(/\.[cm]?[jt]sx?$/, "");
  const from = fromDir ? fromDir.split("/") : [];
  const to = noExt.split("/");
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const rel = [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Mount base for a router file: "authRoutes.js" -> "auth", "dealRoutes.js" -> "deal". */
function mountBase(routeFile: string): string {
  const fname = (routeFile.split("/").pop() || routeFile).replace(/\.[cm]?[jt]sx?$/, "");
  return fname.replace(/(routes?|router)$/i, "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase() || "api";
}

/** Naive English plural so a router mounts at both the singular and the plural
 *  REST path (e.g. "company" -> "companies") — clients use either convention. */
function pluralize(base: string): string {
  if (/[^aeiou]y$/.test(base)) return base.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(base)) return base + "es";
  return base + "s";
}

/**
 * Generated backends sometimes ship every route/controller but NO server
 * bootstrap — the file `main`/`start` points at never gets generated. `node
 * <entry>` then crash-loops with MODULE_NOT_FOUND and the Render deploy fails.
 * When the entry is missing, synthesize a minimal Express server that enables
 * CORS for the Vercel frontend, parses JSON, mounts every router found under
 * routes/ (at `/api/<name>` + plural, inferred from filename), and binds to
 * Render's $PORT — so the service boots instead of failing. Mirrors the
 * frontend's `ensureViteEntry`.
 */
function ensureBackendEntry(
  files: RepoFile[],
  entryPath: string,
  parsed: Record<string, unknown> | null,
): { files: RepoFile[]; synthesized: boolean } {
  if (files.some((f) => f.path === entryPath)) return { files, synthesized: false };

  const esm = parsed?.type === "module";
  const entryDir = dirOf(entryPath);
  const routeFiles = files
    .filter((f) => /(^|\/)routes\/[^/]+\.[cm]?[jt]sx?$/.test(f.path))
    .map((f) => f.path)
    .sort();

  const imports: string[] = [];
  const mounts: string[] = [];
  routeFiles.forEach((rf, i) => {
    const spec = relRequire(entryDir, rf) + (esm ? ".js" : "");
    const v = `r${i}`;
    imports.push(esm ? `import ${v} from '${spec}';` : `const ${v} = require('${spec}');`);
    const base = mountBase(rf);
    const plural = pluralize(base);
    const paths = [...new Set([`/api/${base}`, `/api/${plural}`])];
    mounts.push(`app.use(${JSON.stringify(paths)}, ${v});`);
  });

  const head = esm
    ? "import express from 'express';\nimport cors from 'cors';"
    : "const express = require('express');\nconst cors = require('cors');";
  const content = `// Auto-generated server entry. The app was missing "${entryPath}" (no server
// bootstrap was generated), so the deploy created one: it enables CORS for the
// Vercel frontend, parses JSON, mounts the routers under routes/, and binds to
// Render's $PORT. Mount paths are inferred from filenames — adjust if your
// client calls different ones.
${head}

const app = express();
app.use(cors({ origin: ${CORS_ORIGIN_FN}, credentials: true }));
app.use(express.json());

app.get('/', (req, res) => res.json({ ok: true }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

${imports.join("\n")}
${mounts.join("\n")}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on ' + PORT));
`;

  let out = [...files, { path: entryPath, content }];
  // The synthesized server needs express; ensure it's a dependency.
  const pi = out.findIndex((f) => f.path === "package.json");
  if (pi !== -1) out[pi] = { path: "package.json", content: addDep(out[pi].content, "express", "^4.19.2") };
  return { files: out, synthesized: true };
}

/** Resolve a relative import specifier against the importing file's directory. */
function resolveRelPath(fromDir: string, spec: string): string {
  const parts = (fromDir ? fromDir.split("/") : []).concat(spec.split("/"));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/");
}

const MODULE_EXTS = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];

/** Does a file satisfying this resolved import path exist in the set? */
function importTargetExists(resolved: string, paths: Set<string>): boolean {
  for (const e of MODULE_EXTS) if (paths.has(resolved + e)) return true;
  for (const e of MODULE_EXTS.filter(Boolean)) if (paths.has(`${resolved}/index${e}`)) return true;
  return false;
}

/**
 * Generated backends frequently `require('./routes/auth')` (and controllers,
 * middleware, etc.) that the model never actually created — the build passes but
 * the server crash-loops at boot with MODULE_NOT_FOUND, the Render deploy fails,
 * and any frontend that calls it hangs forever on a loading screen.
 *
 * Stub every missing RELATIVE import so the server boots and serves instead of
 * crashing. The stub is a Proxy over an Express Router: it works mounted as a
 * router (`app.use('/api/x', stub)`), as middleware, and as any destructured
 * handler (`const { login } = require(...)`) — each unknown member resolves to a
 * 501 "Not implemented" handler. The referenced feature is unavailable until the
 * real file is generated, but the rest of the app runs.
 */
function stubMissingBackendImports(files: RepoFile[]): RepoFile[] {
  const paths = new Set(files.map((f) => f.path));
  // target path -> { esm, names } unioned across all importers of that target.
  const missing = new Map<string, { esm: boolean; names: Set<string> }>();

  const REL = /(?:require\(\s*|(?:import|export)\b[^'"]*?\bfrom\s*|import\s*)['"](\.[^'"]+)['"]/g;
  for (const f of files) {
    if (!SRC_EXT.test(f.path)) continue;
    const dir = dirOf(f.path);
    let m: RegExpExecArray | null;
    REL.lastIndex = 0;
    while ((m = REL.exec(f.content))) {
      const spec = m[1];
      const resolved = resolveRelPath(dir, spec);
      if (!resolved || importTargetExists(resolved, paths)) continue;
      const usesImport = /\bimport\b|\bexport\b/.test(m[0]);
      const entry = missing.get(resolved) || { esm: false, names: new Set<string>() };
      if (usesImport) {
        entry.esm = true;
        // Collect named bindings so ESM `import { a, b } from './x'` links.
        const named = new RegExp(`import\\s+([^'";]+?)\\s+from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`).exec(f.content);
        const braces = named && /\{([^}]*)\}/.exec(named[1]);
        if (braces) braces[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean).forEach((n) => entry.names.add(n));
      }
      missing.set(resolved, entry);
    }
  }
  if (missing.size === 0) return files;

  const out = [...files];
  for (const [target, info] of missing) {
    if (/\.json$/.test(target)) {
      out.push({ path: target, content: "{}\n" });
      continue;
    }
    const path = `${target}.js`;
    if (paths.has(path)) continue;
    const named = [...info.names].map((n) => `export const ${n} = handler;`).join("\n");
    // The Proxy lets the stub work BOTH as a mounted router/middleware and as a
    // source of named handlers (`const { login } = require(...)`). Framework and
    // JS-internal props (set/handle/emit/then/_*…) MUST pass through to the real
    // Router untouched — otherwise Express's `fn.handle && fn.set` sub-app check
    // misfires (a fake `.set` makes it mount the stub as an app and crash). Only
    // genuine, unknown identifier-looking members resolve to the 501 handler.
    const proxyDef = `const PASS = new Set(['handle','set','emit','on','once','off','addListener','removeListener','mount','listen','init','engine','render','route','param','use','all','get','post','put','delete','patch','options','head','stack','then','catch','finally','constructor','prototype','toString','valueOf']);
const wrap = (t) => new Proxy(t, { get: (o, p, r) => (typeof p !== 'string' || (p in o) || PASS.has(p) || p[0] === '_') ? Reflect.get(o, p, r) : handler });`;
    const body = info.esm
      ? `import express from 'express';
const router = express.Router();
const handler = (req, res) => res.status(501).json({ error: 'Not implemented (auto-generated stub).' });
${proxyDef}
${named}
export default wrap(router);
`
      : `const express = require('express');
const router = express.Router();
const handler = (req, res) => res.status(501).json({ error: 'Not implemented (auto-generated stub).' });
${proxyDef}
module.exports = wrap(router);
`;
    out.push({
      path,
      content: `// Auto-generated stub: '${target}' was imported but never created in the\n// generated app. This no-op keeps the server booting (it would otherwise\n// crash-loop with MODULE_NOT_FOUND); the referenced feature is unavailable\n// until the real module is generated.\n${body}`,
    });
    paths.add(path);
  }
  return out;
}

export function prepareBackendForRender(input: RepoFile[]): BackendPrep {
  const backendDir = detectBackendDir(input);
  const scoped = reRoot(input, backendDir);

  const hasSchema = scoped.some((f) => /(^|\/)schema\.prisma$/.test(f.path));
  let files = scoped.map((f) => {
    let content = f.content;
    if (/(^|\/)schema\.prisma$/.test(f.path)) content = toPostgres(content);
    else if (ENV_FILE.test(f.path)) content = sanitizeEnv(content);
    else if (SRC_EXT.test(f.path)) content = fixPrismaImport(bindToEnvPort(content));
    else return { path: f.path, content };
    return { path: f.path, content };
  });

  // Pin Prisma to v6 so the schema's `url = env(...)` is accepted (Prisma 7 P1012).
  if (hasSchema) {
    const i = files.findIndex((f) => f.path === "package.json");
    if (i !== -1) files[i] = { path: "package.json", content: pinPrismaV6(files[i].content) };
  }

  // Pin Node 22 LTS via a .node-version file (Render's most reliable selector,
  // alongside the NODE_VERSION env var). Node 24 — Render's default — has no
  // prebuilt binaries for native deps like better-sqlite3 and fails to compile
  // them. 22 has prebuilts and runs everything generated backends use.
  if (!files.some((f) => f.path === ".node-version" || f.path === ".nvmrc")) {
    files.push({ path: ".node-version", content: "22\n" });
  }

  const pkg = files.find((f) => f.path === "package.json");
  const parsed = pkg ? readJson(pkg.content) : null;
  const scripts = (parsed?.scripts as Record<string, string> | undefined) || {};

  // Resolve the server entry. Prefer the start/main script's actual target so a
  // synthesized fallback lands at the exact path the start command runs. (Avoid
  // "dev" — it often uses --watch/nodemon.)
  const entryCandidates = [
    "src/index.js", "src/server.js", "src/app.js", "src/main.js",
    "index.js", "server.js", "app.js",
  ];
  const mainField = typeof parsed?.main === "string" ? parsed.main : null;
  const startTarget = scriptEntryTarget(scripts.start);
  const entry =
    startTarget ||
    (mainField && files.some((f) => f.path === mainField) && mainField) ||
    entryCandidates.find((c) => files.some((f) => f.path === c)) ||
    mainField || "src/index.js";

  // Is there ACTUAL server code to deploy? A real backend has a server entry
  // file, a Prisma schema, or source that imports a server framework — NOT just
  // `express` sitting in a monorepo-root orchestrator's deps (for concurrently).
  // Deploying such a root produced a broken service (`npm run start --prefix
  // backend` with no backend/ dir, or a fabricated health-only stub).
  const entryInInput = files.some((f) => f.path === entry);
  const serverSource = hasServerSource(files);
  const realBackend = entryInInput || serverSource;

  // Synthesize a minimal Express bootstrap ONLY when there is real server source
  // whose entry file is missing (routes/controllers generated, server entry
  // forgotten) — so it boots instead of crash-looping with MODULE_NOT_FOUND.
  let entryPresent = entryInInput;
  let synthesizedEntry = false;
  if (realBackend && !entryInInput) {
    const ens = ensureBackendEntry(files, entry, parsed);
    files = ens.files;
    synthesizedEntry = ens.synthesized;
    entryPresent = ens.synthesized;
  }

  // Start command: an explicit "start" wins only if it actually runs THIS
  // service; otherwise run the resolved entry directly.
  const startCommand = startScriptRunnable(scripts.start, files) ? "npm run start" : `node ${entry}`;

  // Wire CORS so the (dynamic) Vercel frontend can call this backend directly.
  files = wireBackendCors(files, entry);

  // Stub any relative import the entry/sources reference but that was never
  // generated (e.g. `require('./routes/auth')` with no routes/auth file) so the
  // server boots instead of crash-looping with MODULE_NOT_FOUND — which would
  // take the backend down and leave the frontend stuck on a loading screen.
  files = stubMissingBackendImports(files);

  // Apply the registry's verified deterministic fixes for Node backends
  // (e.g. hardcoded app.listen(port) → process.env.PORT fallback).
  files = applyRegistryFixes(files, "node").files;

  const deps = depKeys(parsed);
  const hasBackendDeps = BACKEND_DEPS.some((d) => deps.has(d));
  const isFrontendOnly = FRONTEND_DEPS.some((d) => deps.has(d)) && !hasBackendDeps;
  const hasBackend = !isFrontendOnly && realBackend;

  const hasMigrations = files.some((f) => /(^|\/)prisma\/migrations\/.+/.test(f.path));
  const buildSteps = ["npm install"];
  if (hasSchema) {
    // Normalize the schema BEFORE generate/push. LLM-generated schemas often
    // declare a relation on only one side (e.g. `Task.company Company?` with no
    // `Company.tasks Task[]` back-relation), which Prisma rejects at validation
    // time with P1012 ("missing an opposite relation field") and aborts the
    // build. `prisma format` deterministically inserts the missing back-relation
    // field, fixing the most common generated-schema failure. Non-fatal: a
    // schema format can't repair (e.g. ambiguous relations) would fail the
    // subsequent generate/push anyway with a clearer error, so don't let format
    // itself introduce a new failure for apps that currently build fine.
    // Subshell so the `|| echo` recovers ONLY a format failure — it must not
    // swallow a failure of the preceding `npm install` (flat `&&`/`||` are
    // left-associative with equal precedence, so an unwrapped `|| echo` here
    // would let an install failure fall through to generate/push).
    buildSteps.push('( npx prisma format || echo "⚠ prisma format failed — continuing" )');
    buildSteps.push("npx prisma generate");
    // With committed migrations use migrate deploy; otherwise push the schema
    // (generated apps rarely ship a migrations folder). The app gets its OWN
    // Postgres schema (set via DATABASE_URL ?schema=…), so this is a clean,
    // empty namespace — no collision with the platform's or other apps' tables.
    buildSteps.push(hasMigrations ? "npx prisma migrate deploy" : "npx prisma db push --accept-data-loss");
    // Load seed/initial data after the schema exists, so deploys aren't left with
    // empty tables. resolveSeed may also patch package.json (prisma.seed config).
    const seed = resolveSeed(files, parsed, scripts);
    if (seed.step) {
      // Seeding is best-effort: a brittle generated seed (bad model refs, dup
      // keys) must NOT fail an otherwise-good deploy — the schema is already
      // applied. Make it non-fatal so the service still ships.
      buildSteps.push(`${seed.step} || echo "⚠ seed step failed — continuing without seed data"`);
      if (seed.pkg) {
        const pi = files.findIndex((f) => f.path === "package.json");
        if (pi !== -1) files[pi] = { path: "package.json", content: seed.pkg };
      }
    }
  }

  // Advisories. Raw file-based SQLite runs on Render but its data lives on
  // ephemeral disk — gone on every restart/redeploy. Steer toward the managed
  // Postgres (Prisma apps get DATABASE_URL wired automatically).
  const warnings: string[] = [];
  if (synthesizedEntry) {
    warnings.push(
      `The app had no server entry (${entry}) — one was generated so the backend boots. Routers under routes/ were mounted at /api/<name> (+plural); if your frontend calls different paths, ask the builder to generate the real server entry and redeploy.`,
    );
  }
  if (RAW_SQLITE_DEPS.some((d) => deps.has(d))) {
    warnings.push(
      "This backend uses file-based SQLite (better-sqlite3/sqlite3). It will run, but Render's disk is ephemeral so the database resets on every restart/redeploy. For persistent data, switch to the managed Postgres (e.g. Prisma with provider \"postgresql\" reading process.env.DATABASE_URL).",
    );
  }

  return { files, buildCommand: buildSteps.join(" && "), startCommand, usesPrisma: hasSchema, backendDir, hasBackend, warnings };
}
