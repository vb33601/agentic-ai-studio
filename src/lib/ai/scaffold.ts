/**
 * Deterministic scaffold fallback — the LAST-RESORT completeness guarantee.
 *
 * After generation + the verify/repair loop, some essential, STACK-STANDARD
 * files may still be missing (a weak/free model skipped them, or truncated).
 * Those files are pure boilerplate — identical across apps — so we can fill them
 * deterministically, with NO model involved, guaranteeing the app actually boots
 * instead of showing a blank page or crashing on a missing entry.
 *
 * Principles:
 *  - Only ADD files that are missing; never overwrite the model's output.
 *  - Only emit safe, stack-standard boilerplate (entry/config/bootstrap). App
 *    LOGIC is left to the model + repair loop — we never fabricate business code.
 *  - Works for files produced via createFile OR markdown blocks (the caller
 *    merges both before calling here), and across stacks.
 */

export interface ScaffoldFile {
  path: string;
  content: string;
}
interface FileLike {
  path: string;
  content: string;
}

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
const join = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);

/** The path prefix up to and including the first occurrence of `seg` (e.g. the
 *  "frontend"/"backend" root in `app/frontend/src/App.jsx`). */
function rootBySegment(paths: string[], seg: string): string | null {
  for (const p of paths) {
    const parts = p.split("/");
    const idx = parts.indexOf(seg);
    if (idx >= 0) return parts.slice(0, idx + 1).join("/");
  }
  return null;
}

// ---------------------------------------------------------------------------
// templates (kept minimal and standard — safe to drop into any app of the stack)
// ---------------------------------------------------------------------------

const reactPkg = (ts: boolean) =>
  JSON.stringify(
    {
      name: "frontend",
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "vite", build: ts ? "tsc -b && vite build" : "vite build", preview: "vite preview" },
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: {
        vite: "^5.4.8",
        "@vitejs/plugin-react": "^4.3.2",
        ...(ts ? { typescript: "^5.6.0", "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0" } : {}),
      },
    },
    null,
    2,
  );

const reactViteConfig = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
`;

const reactIndexHtml = (entry: string) => `<!doctype html>
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

const reactMain = (ts: boolean) => `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App${ts ? "" : ".jsx"}";
import "./index.css";

createRoot(document.getElementById("root")${ts ? "!" : ""}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

const reactApp = `export default function App() {
  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>App</h1>
      <p>This screen was scaffolded so the app boots. Replace it with your UI.</p>
    </main>
  );
}
`;

const reactCss = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
`;

const tsconfig = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2020", useDefineForClassFields: true, lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", resolveJsonModule: true,
      isolatedModules: true, noEmit: true, jsx: "react-jsx", strict: true,
    },
    include: ["src"],
  },
  null,
  2,
);

const vuePkg = JSON.stringify(
  {
    name: "frontend", private: true, version: "0.1.0", type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: { vue: "^3.5.0" },
    devDependencies: { vite: "^5.4.8", "@vitejs/plugin-vue": "^5.1.0" },
  }, null, 2,
);
const vueViteConfig = `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({ plugins: [vue()], server: { port: 5173 } });
`;
const vueMain = `import { createApp } from "vue";
import App from "./App.vue";
createApp(App).mount("#app");
`;
const vueApp = `<template>
  <main style="max-width:720px;margin:40px auto;padding:0 16px;font-family:system-ui">
    <h1>App</h1>
    <p>Scaffolded so the app boots. Replace with your UI.</p>
  </main>
</template>
<script setup></script>
`;
const vueIndexHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>App</title></head>
  <body><div id="app"></div><script type="module" src="/src/main.js"></script></body>
</html>
`;

const staticIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main><h1>App</h1><p>Scaffolded so the app boots. Replace with your content.</p></main>
    <script src="script.js"></script>
  </body>
</html>
`;

const expressPkg = JSON.stringify(
  {
    name: "backend", version: "0.1.0", type: "commonjs",
    main: "index.js", scripts: { start: "node index.js", dev: "node index.js" },
    dependencies: { express: "^4.21.0", cors: "^2.8.5" },
  }, null, 2,
);
const expressEntry = `const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Health check so the deployed/preview server always responds.
app.get("/health", (_req, res) => res.json({ ok: true }));

// NOTE: scaffolded entry. Mount your routers here, e.g.
//   app.use("/api/notes", require("./routes/notes"));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("server on " + port));
`;

const dotnetCsproj = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`;
const dotnetProgram = `var builder = WebApplication.CreateBuilder(args);

// Auto-discovers every *Controller in the assembly the model generated.
builder.Services.AddControllers();
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
  p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();
app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { ok = true }));

// Bind to the host-injected port (Render/containers) with a local fallback.
var port = Environment.GetEnvironmentVariable("PORT") ?? "5000";
app.Run($"http://0.0.0.0:{port}");
`;

// ---------------------------------------------------------------------------
// scaffolders
// ---------------------------------------------------------------------------

function scaffoldReact(artifacts: FileLike[], have: Set<string>, add: (p: string, c: string) => void, feRoot: string) {
  const ts = artifacts.some((a) => /\.tsx$/.test(a.path)) || artifacts.some((a) => /\/tsconfig(\.\w+)?\.json$/.test(a.path));
  const ext = ts ? "tsx" : "jsx";
  const entry = `src/main.${ts ? "tsx" : "jsx"}`;
  if (!artifacts.some((a) => a.path === join(feRoot, "package.json"))) add(join(feRoot, "package.json"), reactPkg(ts));
  if (!artifacts.some((a) => /vite\.config\.[jt]s$/.test(a.path) && dirOf(a.path) === feRoot)) add(join(feRoot, "vite.config.js"), reactViteConfig);
  if (!artifacts.some((a) => a.path === join(feRoot, "index.html"))) add(join(feRoot, "index.html"), reactIndexHtml(entry));
  if (ts && !artifacts.some((a) => /tsconfig\.json$/.test(a.path) && dirOf(a.path) === feRoot)) add(join(feRoot, "tsconfig.json"), tsconfig);
  if (!artifacts.some((a) => a.path === join(feRoot, `src/main.${ext}`) || a.path === join(feRoot, "src/main.tsx") || a.path === join(feRoot, "src/main.jsx")))
    add(join(feRoot, entry), reactMain(ts));
  if (!artifacts.some((a) => a.path === join(feRoot, `src/App.${ext}`) || a.path === join(feRoot, "src/App.tsx") || a.path === join(feRoot, "src/App.jsx")))
    add(join(feRoot, `src/App.${ext}`), reactApp);
  if (!artifacts.some((a) => a.path === join(feRoot, "src/index.css"))) add(join(feRoot, "src/index.css"), reactCss);
}

function scaffoldVue(artifacts: FileLike[], add: (p: string, c: string) => void, feRoot: string) {
  if (!artifacts.some((a) => a.path === join(feRoot, "package.json"))) add(join(feRoot, "package.json"), vuePkg);
  if (!artifacts.some((a) => /vite\.config\.[jt]s$/.test(a.path) && dirOf(a.path) === feRoot)) add(join(feRoot, "vite.config.js"), vueViteConfig);
  if (!artifacts.some((a) => a.path === join(feRoot, "index.html"))) add(join(feRoot, "index.html"), vueIndexHtml);
  if (!artifacts.some((a) => a.path === join(feRoot, "src/main.js") || a.path === join(feRoot, "src/main.ts"))) add(join(feRoot, "src/main.js"), vueMain);
  if (!artifacts.some((a) => a.path === join(feRoot, "src/App.vue"))) add(join(feRoot, "src/App.vue"), vueApp);
}

/**
 * Given the final file set and the user's request, return any missing
 * stack-standard files needed for the app to BOOT. Pure & deterministic.
 */
export function ensureScaffold(artifacts: FileLike[], requestText: string): ScaffoldFile[] {
  if (!artifacts.length && !requestText) return [];
  const paths = artifacts.map((a) => a.path);
  const have = new Set(paths);
  const out: ScaffoldFile[] = [];
  const add = (p: string, c: string) => {
    if (!have.has(p)) { out.push({ path: p, content: c }); have.add(p); }
  };
  const lc = (requestText || "").toLowerCase();

  // ---- FRONTEND: guarantee it boots (the worst failure is a blank page) ----
  const reactFiles = artifacts.filter((a) => /\.(jsx|tsx)$/.test(a.path) || (/\.(js|ts)$/.test(a.path) && /from ["']react["']|react-dom/.test(a.content)));
  const vueFiles = artifacts.filter((a) => /\.vue$/.test(a.path));
  const wantsFrontend = /\b(front-?end|react|vue|svelte|angular|\bui\b|client|web ?app|web ?page|\bpage\b|vite|next\.?js|tailwind|spa|single[- ]page)\b/.test(lc);

  if (reactFiles.length) {
    const feRoot = rootBySegment(paths, "frontend") ?? deriveFeRoot(reactFiles[0].path);
    scaffoldReact(artifacts, have, add, feRoot);
  } else if (vueFiles.length) {
    const feRoot = rootBySegment(paths, "frontend") ?? deriveFeRoot(vueFiles[0].path);
    scaffoldVue(artifacts, add, feRoot);
  } else if (wantsFrontend && !artifacts.some((a) => /(^|\/)index\.html$/.test(a.path))) {
    // A frontend was requested but NONE exists — drop in a runnable React shell so
    // the user gets a working starting point instead of nothing.
    const feRoot = rootBySegment(paths, "frontend") ?? (rootBySegment(paths, "backend") ? rootBySegment(paths, "backend")!.replace(/backend$/, "frontend") : "frontend");
    scaffoldReact(artifacts, have, add, feRoot);
  }

  // ---- BACKEND entry guarantees (only fill a missing standard bootstrap) ----
  // Node/Express: an entry that listens on PORT (preview-runnable).
  const nodeBackend = rootBySegment(paths, "backend");
  const hasExpress = artifacts.some((a) => /express/.test(a.content) && /\.(js|ts|cjs|mjs)$/.test(a.path));
  if ((hasExpress || (nodeBackend && artifacts.some((a) => a.path === join(nodeBackend, "package.json") && /express/.test(a.content)))) &&
      !artifacts.some((a) => /(^|\/)(index|server|app)\.(js|cjs|mjs|ts)$/.test(a.path) && (!nodeBackend || a.path.startsWith(nodeBackend)))) {
    const beRoot = nodeBackend ?? "backend";
    add(join(beRoot, "index.js"), expressEntry);
    if (!artifacts.some((a) => a.path === join(beRoot, "package.json"))) add(join(beRoot, "package.json"), expressPkg);
  }

  // .NET (ASP.NET Core): a standard controller-wiring Program.cs auto-discovers
  // any *Controller the model produced; bind PORT + CORS. Add .csproj if missing.
  const dotnetFiles = artifacts.filter((a) => /\.(cs|csproj)$/.test(a.path) || /Microsoft\.AspNetCore|\bWebApplication\b|AddControllers/.test(a.content));
  if (dotnetFiles.length || /\b(\.net|asp\.?net|c#|csharp)\b/.test(lc)) {
    const beRoot = rootBySegment(paths, "backend") ?? deriveDotnetRoot(dotnetFiles) ?? "backend";
    if (!artifacts.some((a) => /(^|\/)Program\.cs$/.test(a.path))) add(join(beRoot, "Program.cs"), dotnetProgram);
    if (!artifacts.some((a) => /\.csproj$/.test(a.path))) add(join(beRoot, "Api.csproj"), dotnetCsproj);
  }

  return out;
}

/** Frontend root = the path up to (but excluding) `src/…`, else the file's dir. */
function deriveFeRoot(filePath: string): string {
  const i = filePath.indexOf("/src/");
  if (i >= 0) return filePath.slice(0, i);
  if (filePath.startsWith("src/")) return "";
  return dirOf(filePath);
}

/** .NET root = the dir holding the .csproj, else the shallowest .cs dir. */
function deriveDotnetRoot(dotnetFiles: FileLike[]): string | null {
  const proj = dotnetFiles.find((a) => /\.csproj$/.test(a.path));
  if (proj) return dirOf(proj.path);
  const cs = dotnetFiles.find((a) => /\.cs$/.test(a.path));
  return cs ? dirOf(cs.path).replace(/\/(Controllers|Models|Services|Data|DTOs|dto)$/i, "") : null;
}
