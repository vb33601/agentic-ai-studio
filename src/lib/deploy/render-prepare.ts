import type { RepoFile } from "./github";

/**
 * Prepare a generated backend for Render + a managed Postgres (Aiven):
 *  - swap the Prisma datasource from sqlite → postgresql (preview uses SQLite),
 *  - bind the server to Render's $PORT (generated apps often hardcode a port),
 *  - derive build & start commands (install + prisma generate + migrate/push).
 *
 * Pure functions over {path, content} files; safe on the server.
 */

export interface BackendPrep {
  files: RepoFile[];
  buildCommand: string;
  startCommand: string;
  usesPrisma: boolean;
}

const SRC_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;

function readJson(content: string): Record<string, unknown> | null {
  try { return JSON.parse(content); } catch { return null; }
}

/** Swap `provider = "sqlite"` to `"postgresql"` in a schema.prisma. */
function toPostgres(schema: string): string {
  return schema.replace(/provider\s*=\s*["']sqlite["']/g, 'provider = "postgresql"');
}

/** Make a server listen on Render's injected $PORT instead of a hardcoded one. */
function bindToEnvPort(content: string): string {
  // `.listen(5000` / `.listen(3000, ` → `.listen(process.env.PORT || 5000`
  return content.replace(
    /\.listen\(\s*(\d{2,5})\b/g,
    (_m, port) => `.listen(process.env.PORT || ${port}`,
  );
}

export function prepareBackendForRender(input: RepoFile[]): BackendPrep {
  let usesPrisma = false;
  const files = input.map((f) => {
    let content = f.content;
    if (/(^|\/)schema\.prisma$/.test(f.path)) {
      usesPrisma = true;
      content = toPostgres(content);
    } else if (SRC_EXT.test(f.path)) {
      content = bindToEnvPort(content);
    }
    return { path: f.path, content };
  });

  const pkg = files.find((f) => f.path === "package.json");
  const parsed = pkg ? readJson(pkg.content) : null;
  const scripts = (parsed?.scripts as Record<string, string> | undefined) || {};
  const deps = {
    ...(parsed?.dependencies as Record<string, string> | undefined),
    ...(parsed?.devDependencies as Record<string, string> | undefined),
  };
  if (deps["@prisma/client"] || deps["prisma"]) usesPrisma = true;

  // Start command: prefer an explicit "start" script; otherwise run the main
  // entry directly (avoid "dev" — it often uses --watch / nodemon).
  const main = (parsed?.main as string | undefined) || "src/server.js";
  const startCommand = scripts.start ? "npm run start" : `node ${main}`;

  const buildSteps = ["npm install"];
  if (usesPrisma) {
    buildSteps.push("npx prisma generate");
    // Apply the schema: migrations if present, else push the schema directly.
    buildSteps.push("(npx prisma migrate deploy || npx prisma db push --accept-data-loss)");
  }
  const buildCommand = buildSteps.join(" && ");

  return { files, buildCommand, startCommand, usesPrisma };
}
