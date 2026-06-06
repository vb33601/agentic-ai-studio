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

export function prepareBackendForRender(input: RepoFile[]): BackendPrep {
  const backendDir = detectBackendDir(input);
  const scoped = reRoot(input, backendDir);

  const hasSchema = scoped.some((f) => /(^|\/)schema\.prisma$/.test(f.path));
  const files = scoped.map((f) => {
    let content = f.content;
    if (/(^|\/)schema\.prisma$/.test(f.path)) content = toPostgres(content);
    else if (SRC_EXT.test(f.path)) content = bindToEnvPort(content);
    return { path: f.path, content };
  });

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
  const entry =
    (mainField && files.some((f) => f.path === mainField) && mainField) ||
    entryCandidates.find((c) => files.some((f) => f.path === c)) ||
    mainField || "src/index.js";
  const startCommand = scripts.start ? "npm run start" : `node ${entry}`;

  const buildSteps = ["npm install"];
  if (hasSchema) {
    buildSteps.push("npx prisma generate");
    buildSteps.push("(npx prisma migrate deploy || npx prisma db push --accept-data-loss)");
  }

  return { files, buildCommand: buildSteps.join(" && "), startCommand, usesPrisma: hasSchema, backendDir };
}
