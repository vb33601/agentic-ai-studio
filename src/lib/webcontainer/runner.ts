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
  handlers.onStatus("Mounting files…");
  await wc.mount(toFileSystemTree(files));

  let serverUrl: string | null = null;
  wc.on("server-ready", (_port, url) => {
    // The first server to bind becomes the preview (frontend in a split).
    if (serverUrl) return;
    serverUrl = url;
    handlers.onServerReady(url);
    handlers.onStatus("Running");
  });

  const procs: Array<Awaited<ReturnType<typeof wc.spawn>>> = [];

  // Start background services (e.g. an API backend) first so the frontend can
  // reach them, then start the preview app.
  for (const bg of plan.background) {
    handlers.onLog(`\n— starting background service: ${bg.dir || "root"} —\n`);
    procs.push(await installAndStart(wc, bg, files, handlers));
  }
  procs.push(await installAndStart(wc, plan.preview, files, handlers));

  setTimeout(() => {
    if (!serverUrl) handlers.onStatus("Still starting — installing/binding the dev server…");
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
