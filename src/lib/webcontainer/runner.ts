import { WebContainer, type FileSystemTree } from "@webcontainer/api";
import type { WorkspaceFile } from "@/store/workspace";

/**
 * WebContainers live-preview engine. Boots a single in-browser Node.js runtime,
 * mounts the workspace files, installs dependencies, and starts the project's
 * dev server. Only one WebContainer may exist per page, so boot is a singleton.
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
export function pickStartScript(pkg: { scripts?: Record<string, string> }): string | null {
  const scripts = pkg.scripts ?? {};
  for (const candidate of ["dev", "start", "serve", "preview"]) {
    if (scripts[candidate]) return candidate;
  }
  return null;
}

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "http", "https", "crypto", "stream", "util", "events", "url",
  "child_process", "buffer", "process", "assert", "zlib", "net", "tls", "dns", "querystring",
]);

/** Map an import specifier to its installable npm package name (or null). */
function packageName(spec: string): string | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) return null;
  if (spec.startsWith("node:")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  const name = spec.split("/")[0];
  if (!name || NODE_BUILTINS.has(name)) return null;
  return name;
}

/**
 * Scan source files for imported packages so we can install any the generated
 * package.json forgot to declare (the cause of "Failed to resolve import X").
 */
function detectImportedPackages(files: WorkspaceFile[]): string[] {
  const re = /(?:import[^'"]*?from\s*|import\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
  const found = new Set<string>();
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.path)) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      const name = packageName(m[1]);
      if (name) found.add(name);
    }
  }
  return [...found];
}

export interface RunHandlers {
  onLog: (chunk: string) => void;
  onServerReady: (url: string) => void;
  onStatus: (status: string) => void;
}

export interface RunResult {
  teardown: () => void;
}

/**
 * Mount files, install deps, and run the dev server. Returns a teardown that
 * kills the running process. Throws with a helpful message on failure.
 */
export async function runProject(files: WorkspaceFile[], handlers: RunHandlers): Promise<RunResult> {
  const pkgFile = files.find((f) => f.path === "package.json" || f.name === "package.json");
  if (!pkgFile) throw new Error("No package.json found — this isn't a Node project.");

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgFile.content);
  } catch {
    throw new Error("package.json is not valid JSON.");
  }

  const startScript = pickStartScript(pkg);
  if (!startScript) throw new Error('No runnable script found (need "dev", "start", "serve", or "preview").');

  const wc = await getWebContainer();

  handlers.onStatus("Mounting files…");
  await wc.mount(toFileSystemTree(files));

  handlers.onStatus("Installing dependencies…");
  const install = await wc.spawn("npm", ["install"]);
  install.output.pipeTo(new WritableStream({ write: (d) => handlers.onLog(d) }));
  const installCode = await install.exit;
  if (installCode !== 0) throw new Error(`npm install failed (exit ${installCode}).`);

  // Safety net: install any imported packages the package.json forgot to
  // declare (e.g. zustand, framer-motion) so Vite/bundler imports resolve.
  const declared = new Set([
    ...Object.keys((pkg as { dependencies?: Record<string, string> }).dependencies || {}),
    ...Object.keys((pkg as { devDependencies?: Record<string, string> }).devDependencies || {}),
  ]);
  const missing = detectImportedPackages(files).filter((p) => !declared.has(p));
  if (missing.length > 0) {
    handlers.onStatus(`Adding missing packages: ${missing.slice(0, 8).join(", ")}…`);
    const add = await wc.spawn("npm", ["install", ...missing]);
    add.output.pipeTo(new WritableStream({ write: (d) => handlers.onLog(d) }));
    await add.exit;
  }

  let serverUrl: string | null = null;
  wc.on("server-ready", (_port, url) => {
    serverUrl = url;
    handlers.onServerReady(url);
    handlers.onStatus("Running");
  });

  // Known frontend dev tools: run the command via `npx -y` so a binary that the
  // generated package.json forgot to declare is fetched automatically (this is
  // why "vite: command not found" happened). Bind to 0.0.0.0 so WebContainers
  // can detect the port.
  const NPX_TOOLS = new Set([
    "vite", "next", "react-scripts", "parcel", "webpack", "webpack-dev-server",
    "astro", "vue-cli-service", "ng", "nuxt", "remix", "serve", "http-server", "live-server",
  ]);
  const startCommand = (pkg.scripts?.[startScript] || "").trim();
  const tokens = startCommand.split(/\s+/).filter(Boolean);
  const tool = tokens[0];

  let proc: Awaited<ReturnType<typeof wc.spawn>>;
  if (tool && NPX_TOOLS.has(tool)) {
    handlers.onStatus(`Starting dev server (${tool})…`);
    const extra = tool === "vite" || tool === "astro" ? ["--host"] : [];
    proc = await wc.spawn("npx", ["-y", ...tokens, ...extra]);
  } else {
    handlers.onStatus(`Starting: npm run ${startScript}…`);
    proc = await wc.spawn("npm", ["run", startScript]);
  }
  proc.output.pipeTo(new WritableStream({ write: (d) => handlers.onLog(d) }));

  // Surface a hint if no server appears in a reasonable window.
  setTimeout(() => {
    if (!serverUrl) handlers.onStatus("Still starting — installing/binding the dev server…");
  }, 25000);

  return {
    teardown: () => {
      proc.kill();
    },
  };
}
