import type { RepoFile } from "./github";
import { detectStackPlan, type StackPlan } from "./dockerfile";

/**
 * Prepare a generated project of ANY language/framework for a container deploy
 * (Render Docker runtime, Railway, Fly.io, Cloud Run…).
 *
 * Unlike `render-prepare` (Node-specific: Prisma, CORS injection, $PORT
 * rewriting), this path is language-agnostic: it relies on the universal
 * Dockerfile engine to produce a correct, $PORT-bound image for the detected
 * framework, then:
 *  - injects the Dockerfile + .dockerignore (unless the repo already ships one),
 *  - strips PORT/DATABASE_URL from any committed .env so the host's values win,
 *  - reports whether the app needs a DATABASE_URL wired and which framework it is.
 *
 * Pure functions over {path, content} — safe on the server.
 */

export interface UniversalPrep {
  files: RepoFile[];
  plan: StackPlan;
  dockerfilePath: string;
  /** App needs a managed Postgres (driver detected) → wire DATABASE_URL. */
  needsDatabase: boolean;
  notes: string[];
}

const ENV_FILE = /(^|\/)\.env(\.|$)/;

// Manifest files that mark a NON-Node backend's root, by language.
const BACKEND_MANIFESTS = [
  /(^|\/)manage\.py$/, /(^|\/)requirements[^/]*\.txt$/, /(^|\/)pyproject\.toml$/, /(^|\/)Pipfile$/,
  /(^|\/)go\.mod$/, /(^|\/)Cargo\.toml$/, /(^|\/)composer\.json$/, /(^|\/)artisan$/,
  /(^|\/)pom\.xml$/, /(^|\/)build\.gradle(\.kts)?$/, /(^|\/)Gemfile$/, /(^|\/)mix\.exs$/, /\.csproj$/,
];

function dir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Locate a non-Node backend's root inside a (possibly fullstack/monorepo) file
 * set, so it can be containerized independently of a JS frontend that lives in a
 * sibling directory. Picks the shallowest dir holding a backend manifest,
 * preferring conventionally-named folders (backend/server/api). Returns null
 * when there's no non-Node backend.
 */
export function findBackendRoot(files: RepoFile[]): { dir: string; files: RepoFile[] } | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const f of files) {
    if (!BACKEND_MANIFESTS.some((re) => re.test(f.path))) continue;
    const d = dir(f.path);
    const depth = d ? d.split("/").length : 0;
    let score = -depth; // shallower wins
    if (/(^|\/)(backend|server|api|app)$/i.test(d)) score += 5;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (best === null) return null;
  if (best === "") return { dir: "", files };
  const prefix = `${best}/`;
  const scoped = files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
  return { dir: best, files: scoped };
}

/** Drop host-managed keys from a committed .env so the platform's values win. */
function sanitizeEnv(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^\s*(PORT|DATABASE_URL)\s*=/.test(line))
    .join("\n");
}

/** Already has a Dockerfile at the repo root? Then respect the author's. */
function hasRootDockerfile(files: RepoFile[]): boolean {
  return files.some((f) => f.path === "Dockerfile");
}

/**
 * Rewrite an app's IPv4-only listen address (0.0.0.0) to dual-stack `[::]`.
 *
 * Fly.io's proxy reaches the app over the private IPv6 (6PN) network, so a server
 * bound only to 0.0.0.0 (IPv4) is unreachable there — the edge completes TLS but
 * returns an empty reply (the symptom: works on Render, "won't deploy" on Fly).
 * `[::]` listens on IPv6 AND, with Linux's default `bindv6only=0`, accepts IPv4
 * too, so Render/Railway keep working unchanged. Covers gunicorn (`--bind/-b`),
 * uvicorn/hypercorn/daphne (`--host`), and Django's `runserver`.
 */
export function bindDualStack(dockerfile: string): string {
  return dockerfile
    .replace(/(-{1,2}b(?:ind)?[=\s]+)0\.0\.0\.0:/g, "$1[::]:")
    .replace(/(--host[=\s]+)0\.0\.0\.0\b/g, "$1::")
    .replace(/(runserver\s+)0\.0\.0\.0:/g, "$1[::]:");
}

export function prepareForContainer(input: RepoFile[]): UniversalPrep {
  const plan = detectStackPlan(input);

  // Sanitize committed env files (don't pin PORT/DATABASE_URL into the image).
  let files: RepoFile[] = input.map((f) =>
    ENV_FILE.test(f.path) ? { path: f.path, content: sanitizeEnv(f.content) } : f,
  );

  // Inject the generated Dockerfile + .dockerignore unless the repo already
  // provides its own (author's Dockerfile wins). Either way, rewrite an
  // IPv4-only bind to dual-stack [::] so the image is reachable on Fly's IPv6
  // proxy (no-op for already-dual-stack apps; harmless on Render/Railway).
  const notes = [...plan.notes];
  if (!hasRootDockerfile(files)) {
    files = [...files, { path: "Dockerfile", content: bindDualStack(plan.dockerfile) }];
  } else {
    notes.unshift("Using the project's existing Dockerfile (a generated one was not added).");
    files = files.map((f) => {
      if (f.path !== "Dockerfile") return f;
      const patched = bindDualStack(f.content);
      if (patched !== f.content) {
        notes.unshift("Rewrote the Dockerfile's listen address to [::] (dual-stack) for Fly.io IPv6 reachability.");
      }
      return { path: f.path, content: patched };
    });
  }
  if (!files.some((f) => f.path === ".dockerignore")) {
    files = [...files, { path: ".dockerignore", content: plan.dockerignore }];
  }

  return {
    files,
    plan,
    dockerfilePath: "./Dockerfile",
    needsDatabase: plan.needsDatabase,
    notes,
  };
}
