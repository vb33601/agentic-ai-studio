import { augmentPackageJson, type SourceFile } from "@/lib/ai/deps";
import { hardenFiles } from "./harden";
import { repairTruncatedSource } from "./truncation";

/**
 * Normalize a generated project so it deploys reliably on Vercel across a wide
 * range of frameworks and languages.
 *
 * Strategy:
 *  - Detect the framework/language from manifest files + dependencies and map it
 *    to the correct Vercel framework preset (Vercel supports ~40 JS presets +
 *    static + serverless functions for Node/Python/Go/Ruby).
 *  - React/Vite projects get a FORGIVING build (`vite build`, never `tsc && …`)
 *    plus injected config, since generated code often has type errors.
 *  - Anything not recognized as a buildable web app deploys as STATIC (its files
 *    are served), so every project deploys instead of erroring.
 *
 * Note: a static host can serve any language's files but cannot *run* a backend
 * server (Flask/Django/Rails/etc.) unless it's structured as serverless functions.
 */

export interface DeployPrep {
  files: SourceFile[];
  framework: string | null;
  buildCommand?: string;
  outputDirectory?: string;
  /** Subdirectory the app actually lives in (e.g. "frontend"); undefined = root. */
  rootDirectory?: string;
  note?: string;
}

/** The directory part of a path ("frontend/package.json" -> "frontend"). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Choose the app's package.json: a root one wins (it usually orchestrates the
 * project); otherwise the shallowest nested one (e.g. `frontend/package.json`).
 * Returns -1 when there is none.
 */
function pickAppPackageJson(files: SourceFile[]): number {
  let best = -1;
  let bestDepth = Infinity;
  files.forEach((f, i) => {
    if (f.path !== "package.json" && !f.path.endsWith("/package.json")) return;
    const depth = f.path === "package.json" ? 0 : dirOf(f.path).split("/").length;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = i;
    }
  });
  return best;
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], build: { outDir: "dist" } });
`;

/**
 * Re-root the file set so `dir` becomes the deployment root: strip the `dir/`
 * prefix and drop anything outside it. Inline (files[]) deployments to Vercel
 * IGNORE the `rootDirectory` project setting — that only applies to
 * Git-connected projects — so when the app lives in a subdirectory we must
 * physically move it to the root instead of pointing Vercel at the subdir.
 */
function reRootFiles(files: SourceFile[], dir: string): SourceFile[] {
  if (!dir) return files;
  const prefix = `${dir}/`;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
}

/** Locate the app's client entry module so a synthesized index.html can load it. */
function findViteEntry(files: SourceFile[]): string {
  const preferred = [
    "src/main.jsx", "src/main.tsx", "src/main.js", "src/main.ts",
    "src/index.jsx", "src/index.tsx", "src/index.js", "src/index.ts",
    "main.jsx", "main.tsx", "main.js", "main.ts",
  ];
  for (const p of preferred) if (files.some((f) => f.path === p)) return p;
  const any = files.find((f) => /(^|\/)(main|index)\.(jsx?|tsx?)$/.test(f.path) && f.path !== "vite.config.js");
  return any?.path ?? "src/main.jsx";
}

const indexHtml = (entry: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/${entry}"></script>
  </body>
</html>
`;

/**
 * A Vite build hard-fails with "Could not resolve entry module index.html" if
 * there is no index.html at the build root. Generated apps frequently omit it or
 * bury it under src/, so guarantee one at the root pointing at the real entry.
 */
function ensureViteIndexHtml(files: SourceFile[]): SourceFile[] {
  if (files.some((f) => f.path === "index.html")) return files;
  return [...files, { path: "index.html", content: indexHtml(findViteEntry(files)) }];
}

const ENTRY_SCRIPT_RE = /<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i;

/** Import specifier from `fromDir` to a module file (extension stripped). */
function importSpecifier(fromDir: string, target: string): string {
  const noExt = target.replace(/\.(jsx?|tsx?)$/, "");
  const from = fromDir ? fromDir.split("/") : [];
  const to = noExt.split("/");
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const rel = [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

const APP_PLACEHOLDER = `export default function App() {
  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 720, margin: "40px auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#b91c1c" }}>App entry was auto-generated</h1>
      <p style={{ color: "#555", marginTop: 8 }}>
        This project was missing its root <code>App</code> / entry module, so a
        placeholder was created so it would still deploy. Ask the builder to
        generate the app's entry and root component, then redeploy.
      </p>
    </div>
  );
}
`;

const mainEntry = (appImport: string, withCss: boolean) => `import React from "react";
import { createRoot } from "react-dom/client";
import App from "${appImport}";${withCss ? '\nimport "./index.css";' : ""}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

/**
 * Guarantee the entry module that index.html loads actually exists. Generated
 * apps regularly ship an index.html pointing at /src/main.jsx but never create
 * main.jsx (or App.jsx) — Rollup then fails with "failed to resolve import
 * /src/main.jsx". Synthesize the missing entry (and a placeholder App when there
 * is none to mount) so the build succeeds.
 */
function ensureViteEntry(files: SourceFile[]): SourceFile[] {
  const indexIdx = files.findIndex((f) => f.path === "index.html");
  if (indexIdx === -1) return files;
  const index = files[indexIdx];
  const scriptMatch = index.content.match(ENTRY_SCRIPT_RE);
  const entry = (scriptMatch?.[1] ?? "/src/main.jsx").replace(/^\.?\//, "");
  const out = [...files];

  // When index.html has NO module <script> tag at all, the entry would never
  // load even if it existed → a blank page. Inject the script (and a #root mount
  // point if missing) pointing at the entry so the app actually boots.
  if (!scriptMatch) {
    let html = index.content;
    if (!/id=["']root["']/.test(html)) {
      html = /<\/body>/i.test(html)
        ? html.replace(/<\/body>/i, `  <div id="root"></div>\n</body>`)
        : `${html}\n<div id="root"></div>`;
    }
    const tag = `  <script type="module" src="/${entry}"></script>`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}\n</body>`) : `${html}\n${tag}`;
    out[indexIdx] = { ...index, content: html };
  }

  // Already present (exact path or same path with a different JS/TS extension).
  const base = entry.replace(/\.(jsx?|tsx?)$/, "");
  if (out.some((f) => f.path === entry || new RegExp(`^${base}\\.(jsx?|tsx?)$`).test(f.path))) return out;

  const entryDir = dirOf(entry);
  // Find an existing App component anywhere to mount; otherwise create one.
  let appPath = out.find((f) => /(^|\/)App\.(jsx?|tsx?)$/.test(f.path))?.path;
  if (!appPath) {
    appPath = `${entryDir ? `${entryDir}/` : ""}App${/\.tsx$/.test(entry) ? ".tsx" : ".jsx"}`;
    out.push({ path: appPath, content: APP_PLACEHOLDER });
  }
  const withCss = out.some((f) => f.path === `${entryDir ? `${entryDir}/` : ""}index.css`);
  out.push({ path: entry, content: mainEntry(importSpecifier(entryDir, appPath), withCss) });
  return out;
}

const JS_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;
const RESOLVE_SUFFIXES = ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.jsx", "/index.ts", "/index.tsx"];

function joinRelative(fromDir: string, rel: string): string {
  const parts = fromDir ? fromDir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// Relative module specifier inside an import/export/require, capturing the spec.
const REL_IMPORT_RE = /(\bfrom\s*|\bimport\s*|\brequire\(\s*|\bimport\(\s*)(['"])(\.[^'"]+)\2/g;

/** Basename of a module path with any JS/TS extension stripped. */
function moduleBase(p: string): string {
  return (p.split("/").pop() || p).replace(/\.(jsx?|tsx?)$/, "");
}

/**
 * Repair broken RELATIVE imports whose target doesn't exist but unambiguously
 * matches a real file elsewhere in the project. Generated code frequently gets
 * the relative depth wrong — e.g. components/Layout.jsx importing
 * "./components/ui/button" when it should be "./ui/button" — which fails the
 * build with "Could not resolve …". When exactly one file in the set has the
 * imported basename, rewrite the specifier to the correct relative path. Skips
 * imports that already resolve, and ambiguous (multiple-match) ones.
 */
function repairImportPaths(files: SourceFile[]): SourceFile[] {
  const paths = new Set(files.map((f) => f.path));
  const resolves = (target: string) => RESOLVE_SUFFIXES.some((s) => paths.has(target + s));
  // Index module files by basename so a misrouted import can be relocated.
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    if (!JS_EXT.test(f.path)) continue;
    const b = moduleBase(f.path);
    (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(f.path);
  }

  return files.map((f) => {
    if (!JS_EXT.test(f.path)) return f;
    const dir = dirOf(f.path);
    const content = f.content.replace(REL_IMPORT_RE, (full, pre, q, spec) => {
      const target = joinRelative(dir, spec);
      if (resolves(target)) return full; // already correct
      const matches = byBase.get(moduleBase(spec));
      if (!matches || matches.length !== 1) return full; // missing or ambiguous
      return `${pre}${q}${importSpecifier(dir, matches[0])}${q}`;
    });
    return content === f.content ? f : { ...f, content };
  });
}

/** Named bindings a module exports (default and `export *` flagged separately). */
function collectNamedExports(content: string): { names: Set<string>; hasStar: boolean } {
  const names = new Set<string>();
  // export const/let/var/function/class NAME
  const declRe = /export\s+(?:async\s+)?(?:const|let|var|async\s+function\*?|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content))) names.add(m[1]);
  // export { a, b as c }  — also re-exports `export { a } from '...'`. The
  // EXPORTED name is what importers reference (the alias after `as`, if any).
  const braceRe = /export\s*\{([^}]*)\}/g;
  while ((m = braceRe.exec(content))) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(seg);
      const exported = asMatch ? asMatch[1] : seg;
      if (/^[A-Za-z_$][\w$]*$/.test(exported) && exported !== "default") names.add(exported);
    }
  }
  // `export * from '...'` re-exports an unknown surface → can't reason about it.
  const hasStar = /export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from/.test(content);
  return { names, hasStar };
}

/** Levenshtein edit distance (iterative, single row). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[i - 1], dp[i]) + 1;
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * The single export name closest to `want`, or null when there is no confident,
 * unambiguous match. Confidence scales with length so plural/case/typo slips on
 * longer names (serviceRequestApi → serviceRequestsApi) are fixed while short,
 * unrelated names are left alone. Same first letter required as a cheap guard.
 */
function closestExport(want: string, names: Set<string>): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  let tie = false;
  for (const n of names) {
    const d = editDistance(want.toLowerCase(), n.toLowerCase());
    if (d < bestD) { bestD = d; best = n; tie = false; }
    else if (d === bestD) tie = true;
  }
  if (!best || tie) return null;
  if (want[0]?.toLowerCase() !== best[0]?.toLowerCase()) return null;
  const limit = Math.min(2, Math.max(1, Math.floor(Math.min(want.length, best.length) / 4)));
  return bestD <= limit ? best : null;
}

// import { a, b as c } from './x'  — captures an optional default prefix so it
// is preserved on rewrite. [^}] matches newlines, so multi-line imports work.
const NAMED_IMPORT_RE = /import\s+((?:[A-Za-z_$][\w$]*\s*,\s*)?)\{([^}]*)\}\s*from\s*(['"])(\.[^'"]+)\3/g;

/**
 * Reconcile NAMED imports against a local module that exists but doesn't export
 * the requested name. Generated code routinely mismatches singular/plural or
 * casing between an export and its importers — e.g. `services/api` exports
 * `serviceRequestsApi` but pages `import { serviceRequestApi }` — which Rollup
 * rejects with `"X" is not exported by "Y"`, hard-failing `vite build`. When the
 * target exports exactly one close match, alias the import to it
 * (`import { serviceRequestsApi as serviceRequestApi }`) so every existing usage
 * of the local name keeps working without touching consumer code. Conservative:
 * skips modules with `export *`, names that already resolve, and ambiguous or
 * distant matches; runs after repairImportPaths (so the target path is correct)
 * and before stubMissingImports (genuinely missing modules still get stubbed).
 */
function reconcileNamedImports(files: SourceFile[]): SourceFile[] {
  const byPath = new Map(files.map((f) => [f.path, f.content] as const));
  const resolve = (target: string): string | null => {
    for (const s of RESOLVE_SUFFIXES) if (byPath.has(target + s)) return target + s;
    return null;
  };
  const exportCache = new Map<string, { names: Set<string>; hasStar: boolean }>();
  const exportsOf = (path: string) => {
    let e = exportCache.get(path);
    if (!e) { e = collectNamedExports(byPath.get(path) ?? ""); exportCache.set(path, e); }
    return e;
  };

  return files.map((f) => {
    if (!JS_EXT.test(f.path)) return f;
    const dir = dirOf(f.path);
    const content = f.content.replace(NAMED_IMPORT_RE, (full, defPrefix, clause, q, spec) => {
      const resolved = resolve(joinRelative(dir, spec));
      if (!resolved || resolved === f.path) return full;
      const { names, hasStar } = exportsOf(resolved);
      if (hasStar || names.size === 0) return full;
      let changed = false;
      const parts = clause.split(",").map((raw: string) => {
        const seg = raw.trim();
        if (!seg) return raw;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(seg);
        const imported = asMatch ? asMatch[1] : seg;
        if (!/^[A-Za-z_$][\w$]*$/.test(imported) || names.has(imported)) return raw;
        const fix = closestExport(imported, names);
        if (!fix) return raw;
        changed = true;
        return ` ${fix} as ${asMatch ? asMatch[2] : imported}`;
      });
      return changed ? `import ${defPrefix}{${parts.join(",")} } from ${q}${spec}${q}` : full;
    });
    return content === f.content ? f : { ...f, content };
  });
}

// Strong JSX signals (closing tag, self-closing tag, fragment, or returning a
// component) — tight enough to avoid TS generics / less-than false positives.
const JSX_SIGNAL =
  /<\/[A-Za-z][\w.]*\s*>|<[A-Za-z][\w.]*(\s[^<>]*)?\/>|<>|<\/>|(?:return|=>)\s*\(?\s*<[A-Za-z]/;

/**
 * Generated apps frequently put JSX in a `.js`/`.ts` file (e.g. a hook or
 * context that returns `<Provider>…`). Vite/Rollup only parse JSX in `.jsx`/
 * `.tsx`, so the build hard-fails with "contains invalid JS syntax … name the
 * file with the .jsx or .tsx extension". Rename those files to .jsx/.tsx —
 * imports are almost always extensionless so resolution still works — and fix
 * any explicit `.js`/`.ts` import specifiers that pointed at a renamed file.
 */
function renameJsxSourceFiles(files: SourceFile[]): SourceFile[] {
  const renames = new Map<string, string>();
  const taken = new Set(files.map((f) => f.path));
  for (const f of files) {
    const m = /\.(js|ts)$/.exec(f.path);
    if (!m || !JSX_SIGNAL.test(f.content)) continue;
    const np = f.path.replace(/\.(js|ts)$/, m[1] === "ts" ? ".tsx" : ".jsx");
    if (taken.has(np)) continue;
    renames.set(f.path, np);
    taken.add(np);
  }
  if (renames.size === 0) return files;
  // resolved-path-without-ext -> new extension, for fixing explicit imports.
  const renamedNoExt = new Map<string, string>();
  for (const [oldP, newP] of renames) renamedNoExt.set(oldP.replace(/\.(js|ts)$/, ""), newP.endsWith(".tsx") ? "tsx" : "jsx");
  return files.map((f) => {
    const newPath = renames.get(f.path) ?? f.path;
    let content = f.content;
    if (JS_EXT.test(f.path)) {
      content = content.replace(
        /(\bfrom\s*|\bimport\s*|\brequire\(\s*|\bimport\(\s*)(['"])(\.[^'"]+?)\.(?:js|ts)\2/g,
        (full, pre, q, spec) => {
          const nx = renamedNoExt.get(joinRelative(dirOf(f.path), spec));
          return nx ? `${pre}${q}${spec}.${nx}${q}` : full;
        },
      );
    }
    return content === f.content && newPath === f.path ? f : { ...f, path: newPath, content };
  });
}

/** Stub default-imported local modules that don't exist so the build doesn't
 *  fail with UNRESOLVED_IMPORT (e.g. main.jsx imports a never-created ./App.jsx). */
function stubMissingImports(files: SourceFile[]): SourceFile[] {
  const existing = new Set(files.map((f) => f.path));
  const out = [...files];
  for (const f of files) {
    if (!JS_EXT.test(f.path)) continue;
    const re = /import\s+[A-Za-z_$][\w$]*\s+from\s*(['"])(\.[^'"]+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content))) {
      const target = joinRelative(dirOf(f.path), m[2]);
      if (RESOLVE_SUFFIXES.some((s) => existing.has(target + s))) continue;
      const stubPath = /\.\w+$/.test(target) ? target : `${target}.jsx`;
      if (existing.has(stubPath)) continue;
      out.push({
        path: stubPath,
        content: /\.(jsx|tsx)$/.test(stubPath)
          ? `// Auto-stub: "${m[2]}" was imported but never generated.\nexport default function MissingModule() {\n  return (\n    <div style={{ padding: 24, fontFamily: "system-ui", color: "#b91c1c" }}>\n      ⚠ This component (<code>${m[2]}</code>) was referenced but never generated. Ask the builder to create it, then redeploy.\n    </div>\n  );\n}\n`
          : `export default {};\n`,
      });
      existing.add(stubPath);
    }
  }
  return out;
}

/**
 * Pin Tailwind to v3 when used. Generated apps use v3-style `@tailwind`
 * directives + a PostCSS config with `tailwindcss` as a plugin, but install v4
 * (latest), whose PostCSS plugin moved to `@tailwindcss/postcss` → the build
 * fails. v3 keeps the existing config/directives working. Also ensures
 * postcss/autoprefixer exist.
 */
function pinTailwindV3(files: SourceFile[]): SourceFile[] {
  const usesTailwind = files.some(
    (f) =>
      (/(^|\/)package\.json$/.test(f.path) && /["']tailwindcss["']\s*:/.test(f.content)) ||
      (/(^|\/)postcss\.config\./.test(f.path) && /tailwindcss/.test(f.content)) ||
      /(^|\/)tailwind\.config\./.test(f.path) ||
      (/\.css$/.test(f.path) && /@tailwind\b/.test(f.content)),
  );
  if (!usesTailwind) return files;
  const idx = files.findIndex((f) => f.path === "package.json" || f.path.endsWith("/package.json"));
  if (idx === -1) return files;
  try {
    const p = JSON.parse(files[idx].content);
    p.dependencies = p.dependencies || {};
    p.devDependencies = p.devDependencies || {};
    delete p.dependencies.tailwindcss;
    p.devDependencies.tailwindcss = "^3.4.0";
    if (!p.dependencies.autoprefixer && !p.devDependencies.autoprefixer) p.devDependencies.autoprefixer = "^10.4.0";
    if (!p.dependencies.postcss && !p.devDependencies.postcss) p.devDependencies.postcss = "^8.4.0";
    const next = files.slice();
    next[idx] = { ...files[idx], content: JSON.stringify(p, null, 2) };
    return next;
  } catch {
    return files;
  }
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext", "lib": ["DOM", "DOM.Iterable", "ESNext"], "module": "ESNext",
    "moduleResolution": "bundler", "jsx": "react-jsx", "strict": false, "noEmit": true,
    "skipLibCheck": true, "allowJs": true, "esModuleInterop": true, "resolveJsonModule": true, "isolatedModules": true
  },
  "include": ["src", "*.ts", "*.tsx"]
}
`;

const has = (files: SourceFile[], re: RegExp) => files.some((f) => re.test(f.path));

/** Map a JS project to a Vercel framework preset (most specific first). */
function detectJsFramework(deps: Record<string, string>, files: SourceFile[]): string | null {
  const d = (name: string) => name in deps;
  const table: Array<[boolean, string]> = [
    [d("next"), "nextjs"],
    [d("nuxt") || d("nuxt3") || has(files, /(^|\/)nuxt\.config\./), "nuxtjs"],
    [d("@sveltejs/kit") || has(files, /(^|\/)svelte\.config\./), "sveltekit"],
    [d("@remix-run/react") || d("@remix-run/node"), "remix"],
    [d("gatsby") || has(files, /(^|\/)gatsby-config\./), "gatsby"],
    [d("astro") || has(files, /(^|\/)astro\.config\./), "astro"],
    [d("@docusaurus/core"), "docusaurus-2"],
    [d("vitepress"), "vitepress"],
    [d("vuepress"), "vuepress"],
    [d("@11ty/eleventy"), "eleventy"],
    [d("@redwoodjs/core"), "redwoodjs"],
    [d("gridsome"), "gridsome"],
    [d("@angular/core") || has(files, /(^|\/)angular\.json$/), "angular"],
    [d("@stencil/core"), "stencil"],
    [d("ember-cli"), "ember"],
    [d("solid-start") || d("@solidjs/start"), "solidstart"],
    [d("preact") && !d("react"), "preact"],
    [d("react-scripts"), "create-react-app"],
    [d("vite"), "vite"], // generic Vite (Vue/Svelte/React on Vite all build fine)
    [d("@vue/cli-service") || has(files, /(^|\/)vue\.config\./), "vue"],
    [d("svelte"), "svelte"],
    [d("parcel") || d("parcel-bundler"), "parcel"],
    [d("hexo"), "hexo"],
  ];
  for (const [match, slug] of table) if (match) return slug;
  return null;
}

/** Detect a non-JS static-site generator / language by signature files. */
function detectByFiles(files: SourceFile[]): string | null {
  if (has(files, /(^|\/)_config\.yml$/)) return "jekyll";
  if (has(files, /(^|\/)config\.toml$/) || has(files, /(^|\/)hugo\.toml$/)) return "hugo";
  if (has(files, /(^|\/)config\.zola\.toml$/)) return "zola";
  return null;
}

export function prepareForDeploy(input: SourceFile[]): DeployPrep {
  let files = augmentPackageJson(input);
  // Build-resilience: FIRST repair any syntactically-truncated source (the
  // generator's output got cut off mid-file — `function` with nothing after it,
  // an unclosed brace), which otherwise fails the bundler with an opaque
  // "Expected identifier but found end of file". Run before the import-repair
  // chain so the salvaged/stubbed module participates in named-import
  // reconciliation. See truncation.ts.
  files = repairTruncatedSource(files).files;
  // Then: rename JSX-in-.js/.ts files to .jsx/.tsx, repair misrouted relative
  // imports, stub still-missing local imports, and pin Tailwind to v3 (applies to
  // ALL Vercel deploys — provider grid and full-stack).
  files = renameJsxSourceFiles(files);
  files = repairImportPaths(files);
  files = reconcileNamedImports(files);
  files = stubMissingImports(files);
  files = pinTailwindV3(files);
  // Runtime-hardening: neutralize common crash classes (unsafe destructuring of
  // API responses, .map over undefined) that survive the build and only throw in
  // the browser. See harden.ts.
  files = hardenFiles(files).files;
  let idx = pickAppPackageJson(files);

  // No package.json: a JS site generator by file signature, else pure static
  // (works for any language's files — HTML output, docs, source, etc.).
  if (idx === -1) {
    return { files, framework: detectByFiles(files) };
  }

  // The app may live in a subdirectory (e.g. "frontend"). Inline deployments
  // ignore Vercel's rootDirectory setting, so physically re-root the files to
  // that directory instead of returning a rootDirectory for Vercel to honor.
  const appDir = dirOf(files[idx].path);
  if (appDir) {
    files = reRootFiles(files, appDir);
    idx = pickAppPackageJson(files);
    if (idx === -1) return { files, framework: detectByFiles(files) };
  }

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(files[idx].content);
  } catch {
    return { files, framework: null };
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const slug = detectJsFramework(deps, files) ?? detectByFiles(files);

  // Vite or a plain React app (no meta-framework) → forgiving Vite build +
  // injected config. (CRA/Next/etc. keep their own correct Vercel presets.)
  const reactish = slug === "vite" || (!slug && !!deps.react);
  if (reactish) {
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.build = "vite build"; // never `tsc && vite build`
    if (!pkg.scripts.dev) pkg.scripts.dev = "vite";
    pkg.devDependencies = pkg.devDependencies || {};
    if (!deps.vite) pkg.devDependencies.vite = "latest";
    if (!deps["@vitejs/plugin-react"]) pkg.devDependencies["@vitejs/plugin-react"] = "latest";
    if (!deps.typescript && has(files, /\.tsx?$/)) pkg.devDependencies.typescript = "latest";
    files = files.slice();
    files[idx] = { ...files[idx], content: JSON.stringify(pkg, null, 2) };
    if (!has(files, /(^|\/)vite\.config\.(js|ts|mjs|cjs)$/)) files.push({ path: "vite.config.js", content: VITE_CONFIG });
    if (!has(files, /(^|\/)tsconfig\.json$/) && has(files, /\.tsx?$/)) files.push({ path: "tsconfig.json", content: TSCONFIG });
    // Vite needs an index.html entry at the root or the build hard-fails — and
    // the module that index.html loads must actually exist.
    files = ensureViteIndexHtml(files);
    files = ensureViteEntry(files);
    return { files, framework: "vite", buildCommand: "vite build", outputDirectory: "dist" };
  }

  // Any other recognized framework → complete manifest, let Vercel's preset build.
  // Unrecognized JS app → static.
  return { files, framework: slug };
}
