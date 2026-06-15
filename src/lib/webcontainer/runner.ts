import { WebContainer, type FileSystemTree } from "@webcontainer/api";
import type { WorkspaceFile } from "@/store/workspace";
import { detectImportedPackages } from "@/lib/ai/deps";

/**
 * WebContainers live-preview engine. Boots a single in-browser Node.js runtime,
 * mounts the workspace files, installs dependencies, and starts the project's
 * dev server. Only one WebContainer may exist per page, so boot is a singleton.
 *
 * Generated apps are NOT always a single package.json at the workspace root —
 * they may keep it in `frontend/`, or split into `frontend/` + `backend/`, or
 * contain several independent apps in sibling folders. So we DETECT the app
 * root(s) and run install/dev with the correct `cwd` instead of assuming root.
 */

let instance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;

export function webContainerSupported(): boolean {
  return typeof window !== "undefined" && window.crossOriginIsolated === true;
}

export async function getWebContainer(): Promise<WebContainer> {
  if (instance) return instance;
  if (!bootPromise) {
    bootPromise = WebContainer.boot().then((wc) => {
      instance = wc;
      return wc;
    });
  }
  return bootPromise;
}

/** Convert the flat workspace file list into a nested WebContainer tree. */
export function toFileSystemTree(files: WorkspaceFile[]): FileSystemTree {
  const root: FileSystemTree = {};
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let node = root;
    segments.forEach((segment, i) => {
      const isLeaf = i === segments.length - 1;
      if (isLeaf) {
        node[segment] = { file: { contents: file.content } };
      } else {
        const existing = node[segment];
        if (!existing || !("directory" in existing)) {
          node[segment] = { directory: {} };
        }
        node = (node[segment] as { directory: FileSystemTree }).directory;
      }
    });
  }
  return root;
}

/** Pick the npm script that starts a dev server, preferring live-reload ones. */
export function pickStartScript(pkg: ParsedPkg): string | null {
  const scripts = pkg.scripts ?? {};
  for (const candidate of ["dev", "start", "serve", "preview"]) {
    if (scripts[candidate]) return candidate;
  }
  return null;
}

type ParsedPkg = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** The directory part of a file path ("frontend/package.json" -> "frontend"). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

const FRONTEND_DEP_MARKERS = [
  "vite", "next", "react-scripts", "@angular/core", "nuxt", "@sveltejs/kit",
  "svelte", "vue", "astro", "parcel", "@vitejs/plugin-react", "react-dom", "gatsby",
];

/** One runnable app discovered in the workspace. */
export interface DetectedApp {
  /** Directory holding the package.json ("" = workspace root). */
  dir: string;
  pkg: ParsedPkg;
  startScript: string | null;
  isFrontend: boolean;
}

function depsOf(pkg: ParsedPkg): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);
}

function isFrontendApp(app: { pkg: ParsedPkg; startScript: string | null }): boolean {
  const deps = depsOf(app.pkg);
  if (FRONTEND_DEP_MARKERS.some((m) => deps.has(m))) return true;
  const cmd = app.startScript ? (app.pkg.scripts?.[app.startScript] || "") : "";
  return /\b(vite|next|react-scripts|astro|ng|vue-cli-service|parcel|webpack|nuxt|gatsby)\b/.test(cmd);
}

/**
 * Find every package.json in the workspace and classify it. Returns them sorted
 * shallowest-first so the workspace root (if any) comes before nested apps.
 */
export function detectApps(files: WorkspaceFile[]): DetectedApp[] {
  const apps: DetectedApp[] = [];
  for (const f of files) {
    const isPkg = f.path === "package.json" || f.path.endsWith("/package.json");
    if (!isPkg) continue;
    let pkg: ParsedPkg;
    try {
      pkg = JSON.parse(f.content);
    } catch {
      continue;
    }
    const startScript = pickStartScript(pkg);
    apps.push({ dir: dirOf(f.path), pkg, startScript, isFrontend: isFrontendApp({ pkg, startScript }) });
  }
  apps.sort((a, b) => a.dir.split("/").length - b.dir.split("/").length || a.dir.localeCompare(b.dir));
  return apps;
}

/**
 * Decide which app(s) to actually run for the preview:
 * - A workspace-root package.json wins outright (it usually orchestrates the
 *   whole project, e.g. `concurrently "npm run server" "npm run client"`).
 * - Otherwise, run every backend in the background and the first frontend as
 *   the preview server (frontend+backend split). If there's no frontend, run
 *   the first runnable app as the preview.
 */
export function planRun(apps: DetectedApp[]): { preview: DetectedApp; background: DetectedApp[] } | null {
  const runnable = apps.filter((a) => a.startScript);
  if (runnable.length === 0) return null;

  const root = runnable.find((a) => a.dir === "");
  if (root) return { preview: root, background: [] };

  const frontends = runnable.filter((a) => a.isFrontend);
  const backends = runnable.filter((a) => !a.isFrontend);
  const preview = frontends[0] || backends[0];
  const background = runnable.filter((a) => a !== preview && a.isFrontend === false);
  return { preview, background };
}

export interface RunHandlers {
  onLog: (chunk: string) => void;
  onServerReady: (url: string) => void;
  onStatus: (status: string) => void;
  /**
   * Optional: called with the full patched file set after the web-search
   * auto-fix repairs a failed preview build, so the caller can sync the edits
   * back into the editor/store. Omit it and the preview still self-heals in the
   * mounted FS — wiring it just keeps the visible files in step.
   */
  onFilesPatched?: (files: WorkspaceFile[]) => void;
}

export interface RunResult {
  teardown: () => void;
}

const NPX_TOOLS = new Set([
  "vite", "next", "react-scripts", "parcel", "webpack", "webpack-dev-server",
  "astro", "vue-cli-service", "ng", "nuxt", "remix", "serve", "http-server", "live-server",
]);

/** Package names from npm ETARGET "No matching version found for pkg@range" errors. */
function parseBadVersions(log: string): string[] {
  const names = new Set<string>();
  const re = /No matching version found for (@?[\w.-]+(?:\/[\w.-]+)?)@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) names.add(m[1]);
  return [...names];
}

/**
 * `npm install` that self-heals hallucinated dependency versions. Generated
 * package.json files sometimes pin versions that don't exist (e.g.
 * `jsonwebtoken@^9.1.2` when the latest is 9.0.x), which npm rejects with
 * ETARGET. On that failure we reset the offending packages to "latest" in
 * package.json and retry, so the preview installs instead of dead-ending.
 */
async function installWithHealing(
  wc: WebContainer,
  app: DetectedApp,
  handlers: RunHandlers,
  spawnOpts: { cwd: string } | undefined,
): Promise<void> {
  const where = app.dir ? `${app.dir}/` : "";
  const pkgPath = app.dir ? `${app.dir}/package.json` : "package.json";

  for (let attempt = 0; attempt < 4; attempt++) {
    handlers.onStatus(`Installing dependencies (${where || "root"})…`);
    let out = "";
    const install = await wc.spawn("npm", ["install", "--no-audit", "--no-fund"], spawnOpts);
    install.output.pipeTo(new WritableStream({ write: (d) => { out += d; handlers.onLog(d); } }));
    if ((await install.exit) === 0) return;

    const bad = parseBadVersions(out);
    if (bad.length === 0) {
      throw new Error(`npm install failed in ${where || "root"}.`);
    }
    const deps = (app.pkg.dependencies ??= {});
    const dev = (app.pkg.devDependencies ??= {});
    for (const name of bad) {
      if (name in dev) dev[name] = "latest";
      else deps[name] = "latest";
    }
    handlers.onStatus(`Fixing invalid version(s): ${bad.slice(0, 6).join(", ")} → latest…`);
    handlers.onLog(`\n[auto-fix] no published version matched for ${bad.join(", ")}; set to "latest" and retrying.\n`);
    await wc.fs.writeFile(pkgPath, JSON.stringify(app.pkg, null, 2));
  }
  throw new Error(`npm install kept failing in ${where || "root"} after fixing versions.`);
}

const SRC_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;
const RESOLVE_SUFFIXES = ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.jsx", "/index.ts", "/index.tsx"];

/** Resolve a relative import target against a file's directory. */
function joinRelative(fromDir: string, rel: string): string {
  const parts = fromDir ? fromDir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Rewrite `import { PrismaClient } from '@prisma/client'` to a default import +
 * destructure. `@prisma/client` is CommonJS, so under ESM ("type":"module")
 * named imports throw "Named export 'PrismaClient' not found".
 */
function fixPrismaImports(content: string): string {
  return content.replace(
    /import\s*\{([^}]+)\}\s*from\s*(['"])@prisma\/client\2\s*;?/g,
    (_m, names) => `import __prismaPkg from '@prisma/client';\nconst { ${String(names).trim()} } = __prismaPkg;`,
  );
}

/**
 * Pre-run repair of common generated-code crashes, applied to the mounted FS
 * before the dev server starts (deterministic, no model call):
 *  - @prisma/client (and other CJS) named imports → default import.
 *  - default-imported local modules that were never created → a stub file, so
 *    Vite/bundler doesn't hard-fail with "Failed to resolve import".
 */
async function repairSources(wc: WebContainer, files: WorkspaceFile[], handlers: RunHandlers): Promise<void> {
  const existing = new Set(files.map((f) => f.path));
  let importFixes = 0;
  const stubs: string[] = [];

  for (const f of files) {
    if (!SRC_EXT.test(f.path)) continue;

    const fixed = fixPrismaImports(f.content);
    if (fixed !== f.content) {
      try { await wc.fs.writeFile(f.path, fixed); importFixes++; } catch { /* ignore */ }
    }

    // Stub default-imported local modules that don't exist (e.g. App.jsx imports
    // ./pages/Signup.jsx but the model never created it).
    const re = /import\s+[A-Za-z_$][\w$]*\s+from\s*(['"])(\.[^'"]+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fixed))) {
      const spec = m[2];
      const target = joinRelative(dirOf(f.path), spec);
      if (RESOLVE_SUFFIXES.some((s) => existing.has(target + s))) continue;
      const stubPath = /\.\w+$/.test(target) ? target : `${target}.jsx`;
      if (existing.has(stubPath)) continue;
      const isComponent = /\.(jsx|tsx)$/.test(stubPath);
      const content = isComponent
        ? `import React from 'react';\n// Auto-generated stub: the original module was imported but never created.\nexport default function MissingModule() {\n  return React.createElement('div', { style: { padding: 24, color: '#b91c1c', fontFamily: 'system-ui' } }, 'Auto-stub for missing module: ${spec}');\n}\n`
        : `// Auto-generated stub for a missing module (${spec}).\nexport default {};\n`;
      try {
        const dir = dirOf(stubPath);
        if (dir) await wc.fs.mkdir(dir, { recursive: true });
        await wc.fs.writeFile(stubPath, content);
        existing.add(stubPath);
        stubs.push(stubPath);
      } catch { /* ignore */ }
    }
  }

  if (importFixes) handlers.onLog(`\n[auto-fix] rewrote ${importFixes} @prisma/client named import(s) to a default import.\n`);
  if (stubs.length) handlers.onLog(`\n[auto-fix] stubbed ${stubs.length} missing import(s): ${stubs.join(", ")}.\n`);
}

/** Spawn `npm install` (+ missing-dep safety net) then the dev script in `dir`. */
async function installAndStart(
  wc: WebContainer,
  app: DetectedApp,
  files: WorkspaceFile[],
  handlers: RunHandlers,
): Promise<Awaited<ReturnType<typeof wc.spawn>>> {
  const where = app.dir ? `${app.dir}/` : "";
  const spawnOpts = app.dir ? { cwd: app.dir } : undefined;

  await installWithHealing(wc, app, handlers, spawnOpts);

  // Safety net: install imported-but-undeclared packages, scoped to THIS app's
  // files so a sibling app's imports don't leak in.
  const appFiles = files.filter((f) => (app.dir ? f.path.startsWith(`${app.dir}/`) : true));
  const declared = depsOf(app.pkg);
  const missing = detectImportedPackages(appFiles).filter((p) => !declared.has(p));
  if (missing.length > 0) {
    handlers.onStatus(`Adding missing packages: ${missing.slice(0, 8).join(", ")}…`);
    const add = await wc.spawn("npm", ["install", ...missing], spawnOpts);
    add.output.pipeTo(new WritableStream({ write: (d) => handlers.onLog(d) }));
    await add.exit;
  }

  // Prisma: generate the client. The app imports @prisma/client but the actual
  // client is generated from schema.prisma into .prisma/client — without this
  // the server crashes with "Cannot find module '.prisma/client/default'".
  const usesPrisma =
    declared.has("@prisma/client") || declared.has("prisma") ||
    appFiles.some((f) => /(^|\/)schema\.prisma$/.test(f.path));
  if (usesPrisma) {
    handlers.onStatus(`Generating Prisma client (${where || "root"})…`);
    handlers.onLog(`\n[auto-fix] running 'prisma generate' so @prisma/client resolves.\n`);
    // Ensure a SQLite DATABASE_URL exists for the preview (external Postgres
    // can't be reached from the sandbox anyway).
    const schemaFile = appFiles.find((f) => /(^|\/)schema\.prisma$/.test(f.path));
    const isSqlite = !!schemaFile && /provider\s*=\s*["']sqlite["']/.test(schemaFile.content);
    if (isSqlite) {
      const envPath = app.dir ? `${app.dir}/.env` : ".env";
      const hasEnv = appFiles.some((f) => f.path === envPath && /DATABASE_URL/.test(f.content));
      if (!hasEnv) {
        try { await wc.fs.writeFile(envPath, 'DATABASE_URL="file:./dev.db"\n'); } catch { /* ignore */ }
      }
    }

    let genOut = "";
    const gen = await wc.spawn("npx", ["-y", "prisma", "generate"], spawnOpts);
    gen.output.pipeTo(new WritableStream({ write: (d) => { genOut += d; handlers.onLog(d); } }));
    const genCode = await gen.exit;

    // Prisma's native engine can't be downloaded/run inside WebContainer, so
    // generate fails (socket hang up fetching binaries.prisma.sh). Surface a
    // clear, actionable note instead of a cryptic "Cannot find module" crash,
    // and skip the futile db push.
    const engineBlocked =
      genCode !== 0 || /socket hang up|binaries\.prisma\.sh|failed to detect the libssl/i.test(genOut);
    if (engineBlocked) {
      handlers.onLog(
        `\n[note] Prisma's database engine can't run in the in-browser preview ` +
        `(WebContainer can't download/run the native engine). The FRONTEND previews ` +
        `fine — to run this backend for real, use the Deploy tab → "Deploy backend → ` +
        `Render", which runs Prisma on a real host wired to your managed Postgres.\n`,
      );
    } else if (isSqlite) {
      handlers.onStatus(`Setting up local SQLite database (${where || "root"})…`);
      handlers.onLog(`\n[auto-fix] creating local SQLite database (prisma db push).\n`);
      const push = await wc.spawn("npx", ["-y", "prisma", "db", "push", "--accept-data-loss"], spawnOpts);
      push.output.pipeTo(new WritableStream({ write: (d) => handlers.onLog(d) }));
      await push.exit; // best-effort
    }
  }

  const script = app.startScript!;
  const startCommand = (app.pkg.scripts?.[script] || "").trim();
  const tokens = startCommand.split(/\s+/).filter(Boolean);
  const tool = tokens[0];

  let proc: Awaited<ReturnType<typeof wc.spawn>>;
  if (tool && NPX_TOOLS.has(tool)) {
    handlers.onStatus(`Starting dev server (${tool}) in ${where || "root"}…`);
    const extra = tool === "vite" || tool === "astro" ? ["--host"] : [];
    proc = await wc.spawn("npx", ["-y", ...tokens, ...extra], spawnOpts);
  } else {
    handlers.onStatus(`Starting: npm run ${script} in ${where || "root"}…`);
    proc = await wc.spawn("npm", ["run", script], spawnOpts);
  }
  proc.output.pipeTo(new WritableStream({ write: (d) => handlers.onLog(d) }));
  return proc;
}

// Build-error signatures that warrant a web-search auto-fix (vs. a transient or
// environmental hiccup we shouldn't burn a model call on).
const BUILD_ERROR_SIGNAL =
  /could not resolve|failed to resolve import|is not exported by|cannot find module|module not found|error\s+ts\d+|invalid js syntax|unexpected token|failed to compile|ERR_MODULE_NOT_FOUND/i;

/**
 * Last resort when the preview build fails for a reason the deterministic
 * repairs above didn't cover: send the captured error log + files to the
 * web-search-grounded repair engine (`/api/deploy/repair`, patch mode), which
 * searches the known fix across the app's stack and returns search/replace edits.
 * Best-effort and fully isolated — any failure here just returns null and the
 * caller surfaces the original error, so it can never break a working preview.
 * Returns the patched files (already written into the mounted FS) or null.
 */
async function attemptWebSearchFix(
  wc: WebContainer,
  files: WorkspaceFile[],
  errorLog: string,
  handlers: RunHandlers,
): Promise<WorkspaceFile[] | null> {
  if (!BUILD_ERROR_SIGNAL.test(errorLog)) return null;
  try {
    handlers.onStatus("Build failed — searching the web for a known fix…");
    handlers.onLog("\n[auto-fix] searching known fixes for this error…\n");
    const res = await fetch("/api/deploy/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, buildLog: errorLog, mode: "patch" }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.changed || !Array.isArray(data.files)) {
      handlers.onLog(`[auto-fix] no reliable fix found${data?.report?.note ? `: ${data.report.note}` : "."}\n`);
      return null;
    }
    // Write only the files that actually changed back into the mounted FS.
    const before = new Map(files.map((f) => [f.path, f.content]));
    const patched = data.files as WorkspaceFile[];
    let written = 0;
    for (const f of patched) {
      if (before.get(f.path) === f.content) continue;
      try {
        const dir = dirOf(f.path);
        if (dir) await wc.fs.mkdir(dir, { recursive: true });
        await wc.fs.writeFile(f.path, f.content);
        written++;
      } catch {
        /* ignore individual write failures */
      }
    }
    const rep = data.report ?? {};
    if (rep.rootCause) handlers.onLog(`[auto-fix] ${rep.rootCause}\n`);
    if (Array.isArray(rep.editedPaths) && rep.editedPaths.length) handlers.onLog(`[auto-fix] patched ${rep.editedPaths.join(", ")}\n`);
    if (Array.isArray(rep.sources) && rep.sources[0]) handlers.onLog(`[auto-fix] per ${rep.sources[0].url}\n`);
    if (written === 0) return null;
    handlers.onFilesPatched?.(patched);
    return patched;
  } catch (e) {
    handlers.onLog(`[auto-fix] skipped: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/**
 * Mount files, install deps, and run the dev server(s). Detects where the app
 * actually lives (root, nested `frontend/`, or a `frontend/`+`backend/` split)
 * and runs each with the correct working directory. Returns a teardown that
 * kills every spawned process.
 */
export async function runProject(files: WorkspaceFile[], handlers: RunHandlers): Promise<RunResult> {
  const apps = detectApps(files);
  if (apps.length === 0) throw new Error("No package.json found — this isn't a Node project.");

  const plan = planRun(apps);
  if (!plan) {
    throw new Error('No runnable script found (need "dev", "start", "serve", or "preview").');
  }

  const wc = await getWebContainer();

  // Tee all log output into a rolling buffer so a failed build can be handed to
  // the web-search auto-fix with its real error text. Capped so it can't grow
  // unbounded. Everything below uses `h` instead of the raw handlers.
  let logBuffer = "";
  const h: RunHandlers = {
    ...handlers,
    onLog: (chunk) => {
      logBuffer = (logBuffer + chunk).slice(-12000);
      handlers.onLog(chunk);
    },
  };

  h.onStatus("Mounting files…");
  await wc.mount(toFileSystemTree(files));

  // Deterministically repair common generated-code crashes before starting.
  h.onStatus("Checking sources…");
  try {
    await repairSources(wc, files, h);
  } catch {
    // Repair is best-effort; never block the run on it.
  }

  let serverUrl: string | null = null;
  wc.on("server-ready", (_port, url) => {
    // The first server to bind becomes the preview (frontend in a split).
    if (serverUrl) return;
    serverUrl = url;
    h.onServerReady(url);
    h.onStatus("Running");
  });

  const procs: Array<Awaited<ReturnType<typeof wc.spawn>>> = [];

  // Start background services (e.g. an API backend) first so the frontend can
  // reach them, then start the preview app.
  for (const bg of plan.background) {
    h.onLog(`\n— starting background service: ${bg.dir || "root"} —\n`);
    procs.push(await installAndStart(wc, bg, files, h));
  }

  // Start the preview app. If it fails to install/build, iteratively run the
  // web-search auto-fix (patch the mounted FS) and restart — up to a few rounds,
  // since a free-model build can have SEVERAL distinct errors that surface one at
  // a time. The loop stops as soon as it starts, when auto-fix finds no further
  // fix (returns null), or after the attempt cap; a healthy preview never loops.
  const MAX_FIX_ATTEMPTS = 3;
  let curFiles = files;
  let curPlan = plan;
  let started = false;
  for (let attempt = 0; !started; attempt++) {
    try {
      procs.push(await installAndStart(wc, curPlan.preview, curFiles, h));
      started = true;
    } catch (err) {
      h.onLog(`\n[preview] start failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (attempt >= MAX_FIX_ATTEMPTS) throw err;
      const patched = await attemptWebSearchFix(wc, curFiles, logBuffer, h);
      if (!patched) throw err; // no known fix → surface the original error
      h.onStatus(`Retrying the preview with the patched code… (fix ${attempt + 1}/${MAX_FIX_ATTEMPTS})`);
      curFiles = patched;
      curPlan = planRun(detectApps(patched)) ?? curPlan;
      logBuffer = ""; // fresh buffer so the next failure's signature is clean
    }
  }

  setTimeout(() => {
    if (!serverUrl) h.onStatus("Still starting — installing/binding the dev server…");
  }, 25000);

  return {
    teardown: () => {
      for (const p of procs) {
        try {
          p.kill();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
