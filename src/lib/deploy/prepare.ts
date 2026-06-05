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
  note?: string;
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], build: { outDir: "dist" } });
`;

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
  const idx = files.findIndex((f) => f.path === "package.json" || f.path.endsWith("/package.json"));

  // No package.json: a JS site generator by file signature, else pure static
  // (works for any language's files — HTML output, docs, source, etc.).
  if (idx === -1) {
    return { files, framework: detectByFiles(files) };
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
    return { files, framework: "vite", buildCommand: "vite build", outputDirectory: "dist" };
  }

  // Any other recognized framework → complete manifest, let Vercel's preset build.
  // Unrecognized JS app → static.
  return { files, framework: slug };
}
