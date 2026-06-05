import { augmentPackageJson, type SourceFile } from "@/lib/ai/deps";

/**
 * Normalize a generated project so it builds reliably on Vercel.
 *
 * Robustness strategy:
 *  - Static sites (no package.json) deploy as-is (no build step → can't fail).
 *  - Vite/React projects: complete the manifest, force a FORGIVING build
 *    (`vite build` only — never `tsc && …`, since generated code often has type
 *    errors that would otherwise abort the build), and inject any missing
 *    config (vite.config, tsconfig, index.html entry) so the build has what it
 *    needs. Return explicit Vercel build settings.
 *  - Next.js projects: complete the manifest and let Vercel auto-build.
 */

export interface DeployPrep {
  files: SourceFile[];
  framework: string | null;
  buildCommand?: string;
  outputDirectory?: string;
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});
`;

// Deliberately loose — type errors must never block the deploy build.
const TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["DOM", "DOM.Iterable", "ESNext"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": false,
    "noEmit": true,
    "skipLibCheck": true,
    "allowJs": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src", "*.ts", "*.tsx"]
}
`;

function has(files: SourceFile[], re: RegExp): boolean {
  return files.some((f) => re.test(f.path));
}

export function prepareForDeploy(input: SourceFile[]): DeployPrep {
  let files = augmentPackageJson(input);
  const idx = files.findIndex((f) => f.path === "package.json" || f.path.endsWith("/package.json"));

  // No manifest → static site. Deploys with no build step.
  if (idx === -1) return { files, framework: null };

  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(files[idx].content);
  } catch {
    return { files, framework: null };
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const isNext = !!deps.next;
  const isVite = !!deps.vite || has(files, /(^|\/)vite\.config\.(js|ts|mjs|cjs)$/);

  if (isNext) {
    return { files, framework: "nextjs" };
  }

  if (isVite || deps.react) {
    // Treat React projects as Vite for a dependable bundler build.
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.build = "vite build"; // never `tsc && vite build`
    if (!pkg.scripts.dev) pkg.scripts.dev = "vite";
    pkg.devDependencies = pkg.devDependencies || {};
    if (!deps.vite) pkg.devDependencies.vite = "latest";
    if (!deps["@vitejs/plugin-react"]) pkg.devDependencies["@vitejs/plugin-react"] = "latest";
    if (!deps.typescript && has(files, /\.tsx?$/)) pkg.devDependencies.typescript = "latest";
    files = files.slice();
    files[idx] = { ...files[idx], content: JSON.stringify(pkg, null, 2) };

    if (!has(files, /(^|\/)vite\.config\.(js|ts|mjs|cjs)$/)) {
      files.push({ path: "vite.config.js", content: VITE_CONFIG });
    }
    if (!has(files, /(^|\/)tsconfig\.json$/) && has(files, /\.tsx?$/)) {
      files.push({ path: "tsconfig.json", content: TSCONFIG });
    }
    return { files, framework: "vite", buildCommand: "vite build", outputDirectory: "dist" };
  }

  return { files, framework: null };
}
