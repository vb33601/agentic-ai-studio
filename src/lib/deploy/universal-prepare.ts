import type { RepoFile } from "./github";
import { detectStackPlan, type StackPlan } from "./dockerfile";
import { checkDockerfileInvariants } from "./stack-invariants";
import { prepareSchema } from "./schema";
import { fixDotnetPackageConflicts, autoRegisterDotnetServices, pruneDanglingServiceRegistrations, ensureDotnetCors, detectMissingDotnetApi } from "./dotnet";
import { hardenRuntime } from "./runtime-harden";
import { hardeningPassesFor } from "./hardening-matrix";
import { hardenBackendFiles } from "./harden-backend";
import { applyRegistryFixes } from "./preflight";

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
  // A .NET solution references projects across sibling dirs (Api → Domain → Infra),
  // so root at the .sln's directory — scoping to a single .csproj dir would drop its
  // project references and `dotnet publish` fails to restore them. (Shallowest .sln.)
  const sln = files
    .filter((f) => /\.sln$/.test(f.path))
    .sort((a, b) => dir(a.path).split("/").length - dir(b.path).split("/").length)[0];
  if (sln) {
    const d = dir(sln.path);
    if (d === "") return { dir: "", files };
    const prefix = `${d}/`;
    return { dir: d, files: files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), content: f.content })) };
  }

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
 * too, so Render/Railway keep working unchanged. Covers every bind WE control in a
 * generated (or author-provided) Dockerfile across the configured stacks:
 *  - gunicorn/puma `-b|--bind 0.0.0.0:PORT` and the bare `-b 0.0.0.0` (Rails, port via -p),
 *  - uvicorn/hypercorn/daphne `--host 0.0.0.0`,
 *  - rackup `-o 0.0.0.0` (Sinatra/Rack),
 *  - PHP's built-in server `-S 0.0.0.0:PORT` (Laravel/Symfony),
 *  - Django's `runserver 0.0.0.0:PORT`,
 *  - URL hosts `http://+|*|0.0.0.0:PORT` (ASP.NET `ASPNETCORE_URLS`, Perl/Mojo `-l`).
 * Binds that live in app SOURCE (Go `:PORT`, Node `listen(PORT)`) already default to
 * dual-stack; ones the app hardcodes (Rust/Phoenix config) can't be rewritten here.
 */
export function bindDualStack(dockerfile: string): string {
  return dockerfile
    .replace(/(-{1,2}b(?:ind)?[=\s]+)0\.0\.0\.0:/g, "$1[::]:")
    .replace(/(-{1,2}b(?:ind)?[=\s]+)0\.0\.0\.0(?=\s|$|["'])/g, "$1[::]")
    .replace(/(--host[=\s]+)0\.0\.0\.0\b/g, "$1::")
    .replace(/(-o[=\s]+)0\.0\.0\.0\b/g, "$1::")
    .replace(/(-S[=\s]+)0\.0\.0\.0:/g, "$1[::]:")
    .replace(/(runserver\s+)0\.0\.0\.0:/g, "$1[::]:")
    .replace(/(\bhttps?:\/\/)(?:\+|\*|0\.0\.0\.0)(:)/g, "$1[::]$2");
}

export function prepareForContainer(input: RepoFile[]): UniversalPrep {
  const plan = detectStackPlan(input);

  // Verify the generated Dockerfile still carries the build-correctness directives
  // its stack requires (see stack-invariants.ts). A violation means a planner
  // regressed and would ship an app that fails its REMOTE build minutes later with
  // an opaque error — fail loud here instead. The 45-stack harness asserts every
  // fixture passes these same invariants, so this gate never fires on a healthy build.
  const violations = checkDockerfileInvariants(plan);
  if (violations.length) {
    throw new Error(
      `Generated Dockerfile failed build-invariant checks for ${plan.stack}/${plan.framework}:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    );
  }

  // Sanitize committed env files (don't pin PORT/DATABASE_URL into the image).
  let files: RepoFile[] = input.map((f) =>
    ENV_FILE.test(f.path) ? { path: f.path, content: sanitizeEnv(f.content) } : f,
  );

  // Apply the plan's source patches (e.g. an injected /health route) so the
  // deployed app affirmatively confirms liveness instead of being inferred "up"
  // from a tolerated 404. Patches are keyed by path and REPLACE the original — so
  // they must run BEFORE hardening, otherwise they'd clobber the hardened source.
  if (plan.sourcePatches?.length) {
    const patchByPath = new Map(plan.sourcePatches.map((p) => [p.path, p.content] as const));
    files = files.map((f) => (patchByPath.has(f.path) ? { path: f.path, content: patchByPath.get(f.path)! } : f));
  }

  // Runtime-harden Python source LAST, so it operates on the final file (incl. any
  // source patches above) and can't be overwritten: JWT string-subject + run
  // __main__-gated init under gunicorn — crash classes that survive the build and
  // break login/boot.
  files = hardenBackendFiles(files).files;

  // Apply the registry's verified deterministic fixes for this stack (no-op when
  // the framework has none — researched-but-unproven fixes never auto-apply).
  files = applyRegistryFixes(files, plan.framework).files;

  // No-migrations / auto-create-schema strategy (see schema.ts): drop broken
  // migration scaffolding and switch the app to build its schema from the model
  // at startup, so generated apps that ship hallucinated migrations still build
  // and write straight to a freshly-created database. Returns the sanitized file
  // set and a Dockerfile whose DB step is rewritten to the no-migration form.
  const schema = prepareSchema(plan, files, plan.dockerfile);
  files = schema.files;
  let dockerfile = schema.dockerfile;

  // Resolve the .NET NU1605 package downgrade at the source (drop redundant
  // IdentityModel pins) so the build is conflict-free AND the version JwtBearer
  // was compiled against actually ships — otherwise the app builds but 500s on
  // first request with a missing-assembly error. See dotnet.ts.
  const dotnet = fixDotnetPackageConflicts(files);
  files = dotnet.files;

  // Auto-register app-defined services that controllers inject but Program.cs
  // never wired into DI — otherwise the app builds but every request to that
  // controller 500s with "Unable to resolve service" (breaks login/register).
  const dotnetDi = autoRegisterDotnetServices(files);
  files = dotnetDi.files;

  // Remove DI registrations for services the generator listed but never created
  // (AddScoped<IStaffService, StaffService> with no such type) — they fail the
  // build with CS0246. Nothing references them, so dropping them is safe.
  const dotnetPrune = pruneDanglingServiceRegistrations(files);
  files = dotnetPrune.files;

  // Ensure the backend accepts cross-origin calls from its Vercel-hosted frontend
  // (generated .NET APIs often ship no CORS → "Failed to fetch" in the browser).
  const dotnetCors = ensureDotnetCors(files);
  files = dotnetCors.files;

  // Loudly flag a backend that ships no HTTP endpoints (MapControllers but no
  // controllers/minimal routes) — a generation gap the deploy engine can't fix.
  const dotnetApi = detectMissingDotnetApi(files);

  // Cross-stack runtime readiness: reconcile deps used in code but missing from
  // the manifest (Python/Node/Ruby) or self-resolve them at build (Go), so the
  // app doesn't deploy green and then crash on first import/require. See
  // runtime-harden.ts.
  const runtime = hardenRuntime(plan, files, dockerfile);
  files = runtime.files;
  dockerfile = runtime.dockerfile;

  // Inject the generated Dockerfile + .dockerignore unless the repo already
  // provides its own (author's Dockerfile wins). Either way, rewrite an
  // IPv4-only bind to dual-stack [::] so the image is reachable on Fly's IPv6
  // proxy (no-op for already-dual-stack apps; harmless on Render/Railway).
  const notes = [
    `Hardening passes for ${plan.stack}: ${hardeningPassesFor(plan.stack).join(", ")}.`,
    ...plan.notes, ...schema.notes, ...dotnet.notes, ...dotnetDi.notes, ...dotnetPrune.notes, ...dotnetCors.notes, ...dotnetApi.notes, ...runtime.notes,
  ];
  if (!hasRootDockerfile(files)) {
    files = [...files, { path: "Dockerfile", content: bindDualStack(dockerfile) }];
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
