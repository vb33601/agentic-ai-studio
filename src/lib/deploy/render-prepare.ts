import type { RepoFile } from "./github";

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
}

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

export function prepareBackendForRender(input: RepoFile[]): BackendPrep {
  const backendDir = detectBackendDir(input);
  const scoped = reRoot(input, backendDir);

  const hasSchema = scoped.some((f) => /(^|\/)schema\.prisma$/.test(f.path));
  const files = scoped.map((f) => {
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

  // Start command: an explicit "start" script wins; otherwise run the real
  // entry file (avoid "dev" — it often uses --watch/nodemon).
  const entryCandidates = [
    "src/index.js", "src/server.js", "src/app.js", "src/main.js",
    "index.js", "server.js", "app.js",
  ];
  const mainField = typeof parsed?.main === "string" ? parsed.main : null;
  const entryExists =
    (mainField && files.some((f) => f.path === mainField)) ||
    entryCandidates.some((c) => files.some((f) => f.path === c));
  const entry =
    (mainField && files.some((f) => f.path === mainField) && mainField) ||
    entryCandidates.find((c) => files.some((f) => f.path === c)) ||
    mainField || "src/index.js";
  const startCommand = scripts.start ? "npm run start" : `node ${entry}`;

  // Is there actually a server to deploy? A real backend has backend deps, a
  // Prisma schema, or a real server entry file — and isn't a pure frontend.
  const deps = depKeys(parsed);
  const hasBackendDeps = BACKEND_DEPS.some((d) => deps.has(d));
  const isFrontendOnly = FRONTEND_DEPS.some((d) => deps.has(d)) && !hasBackendDeps;
  const hasBackend = !isFrontendOnly && (hasBackendDeps || hasSchema || !!entryExists);

  const hasMigrations = files.some((f) => /(^|\/)prisma\/migrations\/.+/.test(f.path));
  const buildSteps = ["npm install"];
  if (hasSchema) {
    buildSteps.push("npx prisma generate");
    // With committed migrations use migrate deploy; otherwise push the schema
    // (generated apps rarely ship a migrations folder). The app gets its OWN
    // Postgres schema (set via DATABASE_URL ?schema=…), so this is a clean,
    // empty namespace — no collision with the platform's or other apps' tables.
    buildSteps.push(hasMigrations ? "npx prisma migrate deploy" : "npx prisma db push --accept-data-loss");
  }

  return { files, buildCommand: buildSteps.join(" && "), startCommand, usesPrisma: hasSchema, backendDir, hasBackend };
}
