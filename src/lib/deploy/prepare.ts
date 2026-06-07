import { augmentPackageJson, type SourceFile } from "@/lib/ai/deps";

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
  // Build-resilience: stub missing local imports + pin Tailwind to v3 (applies
  // to ALL Vercel deploys — provider grid and full-stack).
  files = stubMissingImports(files);
  files = pinTailwindV3(files);
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
    // Vite needs an index.html entry at the root or the build hard-fails.
    files = ensureViteIndexHtml(files);
    return { files, framework: "vite", buildCommand: "vite build", outputDirectory: "dist" };
  }

  // Any other recognized framework → complete manifest, let Vercel's preset build.
  // Unrecognized JS app → static.
  return { files, framework: slug };
}
