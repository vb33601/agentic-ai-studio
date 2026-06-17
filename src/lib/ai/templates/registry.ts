/**
 * TEMPLATE REGISTRY — the foundation of the re-architecture (Phase 1).
 *
 * Every build now STARTS from a complete, already-runnable app instead of an
 * empty directory. This is the single highest-leverage change: the agentic edit
 * loop edits an app that already builds + boots, so a dropped stream or a skipped
 * file degrades to "the starter still runs" instead of "broken/blank app". It is
 * the same insight dyad's `scaffold/` and opencode's working-tree model rely on.
 *
 * Each template is INTENTIONALLY minimal but COMPLETE and DEPLOY-READY:
 *  - it has every entry/config file its stack needs to install, build and boot,
 *  - it has zero broken local imports (findAppGaps == 0),
 *  - single-service templates pass the deploy engine's Dockerfile invariants.
 *
 * The model's job is then to EDIT this into the requested app via the edit tools
 * (see ../agent/tools.ts), never to reproduce boilerplate from scratch.
 */

export interface TemplateRuntime {
  /** Install command (informational; used by execution feedback in Phase 2). */
  install: string;
  /** Build command, or null for no build step (static). */
  build: string | null;
  /** Dev/start command. */
  dev: string;
  /** Port the app serves on locally. */
  port: number;
}

export interface Template {
  key: TemplateKey;
  label: string;
  /** Deploy-engine stack family (matches detectStackPlan output where relevant). */
  stack: string;
  framework: string;
  description: string;
  runtime: TemplateRuntime;
  /** path -> file content. A complete, runnable starting app. */
  files: Record<string, string>;
}

export type TemplateKey =
  | "static"
  | "react-vite"
  | "vue-vite"
  | "node-express"
  | "express-react";

// ---------------------------------------------------------------------------
// Shared fragments (kept DRY across templates)
// ---------------------------------------------------------------------------

const reactPkg = (name: string) =>
  JSON.stringify(
    {
      name,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview --host" },
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: { vite: "^5.4.8", "@vitejs/plugin-react": "^4.3.2" },
    },
    null,
    2,
  ) + "\n";

const reactViteConfig = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
});
`;

const reactIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;

const reactMain = `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`;

const reactApp = `export default function App() {
  return (
    <main className="app">
      <h1>Starter app</h1>
      <p>Edit <code>src/App.jsx</code> to build your UI.</p>
    </main>
  );
}
`;

const reactCss = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
.app { max-width: 720px; margin: 48px auto; padding: 0 16px; }
`;

const expressPkg = JSON.stringify(
  {
    name: "backend",
    version: "0.1.0",
    type: "commonjs",
    main: "index.js",
    scripts: { start: "node index.js", dev: "node index.js" },
    dependencies: { express: "^4.21.0", cors: "^2.8.5" },
  },
  null,
  2,
) + "\n";

const expressEntry = `const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Health check so the deployed/preview server always responds.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Example route — replace/extend with your API.
app.get("/api/hello", (_req, res) => res.json({ message: "Hello from the API" }));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("server on " + port));
`;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const TEMPLATES: Record<TemplateKey, Template> = {
  static: {
    key: "static",
    label: "Static site (HTML/CSS/JS)",
    stack: "static",
    framework: "static",
    description: "Plain HTML/CSS/JS — landing pages, games, single-page tools with no build step.",
    runtime: { install: "", build: null, dev: "serve .", port: 8080 },
    files: {
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>Starter site</h1>
      <p>Edit <code>index.html</code>, <code>styles.css</code> and <code>script.js</code>.</p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`,
      "styles.css": `* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
main { max-width: 720px; margin: 48px auto; padding: 0 16px; }
`,
      "script.js": `// App entry. Wire up DOM interactions here.
console.log("ready");
`,
    },
  },

  "react-vite": {
    key: "react-vite",
    label: "React + Vite SPA",
    stack: "node",
    framework: "vite",
    description: "Client-side React single-page app — dashboards, tools, interactive UIs with no backend.",
    runtime: { install: "npm install", build: "npm run build", dev: "npm run dev", port: 5173 },
    files: {
      "package.json": reactPkg("react-app"),
      "vite.config.js": reactViteConfig,
      "index.html": reactIndexHtml,
      "src/main.jsx": reactMain,
      "src/App.jsx": reactApp,
      "src/index.css": reactCss,
    },
  },

  "vue-vite": {
    key: "vue-vite",
    label: "Vue 3 + Vite SPA",
    stack: "node",
    framework: "vite",
    description: "Client-side Vue 3 single-page app.",
    runtime: { install: "npm install", build: "npm run build", dev: "npm run dev", port: 5173 },
    files: {
      "package.json": JSON.stringify(
        {
          name: "vue-app",
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview --host" },
          dependencies: { vue: "^3.5.0" },
          devDependencies: { vite: "^5.4.8", "@vitejs/plugin-vue": "^5.1.0" },
        },
        null,
        2,
      ) + "\n",
      "vite.config.js": `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({ plugins: [vue()], server: { host: true, port: 5173 } });
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
      "src/main.js": `import { createApp } from "vue";
import App from "./App.vue";
import "./index.css";

createApp(App).mount("#app");
`,
      "src/App.vue": `<template>
  <main class="app">
    <h1>Starter app</h1>
    <p>Edit <code>src/App.vue</code> to build your UI.</p>
  </main>
</template>

<script setup></script>
`,
      "src/index.css": reactCss,
    },
  },

  "node-express": {
    key: "node-express",
    label: "Node + Express API",
    stack: "node",
    framework: "express",
    description: "Backend-only HTTP/JSON API in Express.",
    runtime: { install: "npm install", build: null, dev: "npm run dev", port: 3001 },
    files: {
      "package.json": expressPkg,
      "index.js": expressEntry,
    },
  },

  "express-react": {
    key: "express-react",
    label: "Full-stack (Express API + React/Vite)",
    stack: "node",
    framework: "fullstack",
    description: "A backend Express API and a React/Vite frontend that calls it — full-stack CRUD apps.",
    runtime: { install: "npm install", build: "npm run build", dev: "npm run dev", port: 5173 },
    files: {
      // ---- backend ----
      "backend/package.json": expressPkg,
      "backend/index.js": `const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Example resource — replace/extend with your API.
let items = [];
app.get("/api/items", (_req, res) => res.json(items));
app.post("/api/items", (req, res) => {
  const item = { id: Date.now(), ...req.body };
  items.push(item);
  res.status(201).json(item);
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log("server on " + port));
`,
      // ---- frontend ----
      "frontend/package.json": reactPkg("frontend"),
      "frontend/vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Proxy API calls to the Express backend in dev.
    proxy: { "/api": "http://localhost:3001" },
  },
});
`,
      "frontend/index.html": reactIndexHtml,
      "frontend/src/main.jsx": reactMain,
      "frontend/src/App.jsx": `import { useEffect, useState } from "react";
import { getItems, addItem } from "./api.js";
import "./index.css";

export default function App() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    getItems().then(setItems).catch(() => {});
  }, []);

  return (
    <main className="app">
      <h1>Full-stack starter</h1>
      <p>Frontend calls the Express API. Edit <code>src/App.jsx</code> and <code>backend/index.js</code>.</p>
      <ul>
        {items.map((it) => (
          <li key={it.id}>{JSON.stringify(it)}</li>
        ))}
      </ul>
      <button onClick={async () => setItems(await addItem({ name: "item" }).then(() => getItems()))}>
        Add item
      </button>
    </main>
  );
}
`,
      "frontend/src/api.js": `// API client — same-origin "/api" is proxied to the backend in dev.
const BASE = import.meta.env.VITE_API_URL || "";

export async function getItems() {
  const res = await fetch(BASE + "/api/items");
  if (!res.ok) throw new Error("failed to load items");
  return res.json();
}

export async function addItem(item) {
  const res = await fetch(BASE + "/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error("failed to add item");
  return res.json();
}
`,
      "frontend/src/index.css": reactCss,
    },
  },
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function getTemplate(key: TemplateKey): Template {
  return TEMPLATES[key];
}

/**
 * Pick the best starting template for a request. Deterministic, keyword-driven,
 * and conservative — when unsure it returns a React SPA (the most common ask),
 * and the edit loop can still add backend files on top if needed.
 */
export function selectTemplate(request: string): Template {
  const t = (request || "").toLowerCase();

  const wantsBackend =
    /\b(back-?end|api|server|endpoints?|rest|express|fastapi|flask|django|rails|spring|\.net|database|crud|auth|login|sign[- ]?up)\b/.test(t);
  const wantsFrontend =
    /\b(front-?end|react|vue|svelte|angular|\bui\b|client|web ?app|page|dashboard|spa|tailwind|component)\b/.test(t);
  const isVue = /\bvue\b/.test(t);
  const isStatic =
    /\b(landing|landing ?page|static|html|game|canvas|portfolio|brochure|single ?file|one ?file)\b/.test(t) &&
    !wantsBackend &&
    !/\breact|vue|svelte\b/.test(t);

  // Full-stack: needs both halves (a UI that talks to an API/DB).
  if (wantsBackend && (wantsFrontend || /\bapp\b/.test(t)) && !/\b(api[- ]only|backend[- ]only|just an? api)\b/.test(t)) {
    return TEMPLATES["express-react"];
  }
  // Backend only.
  if (wantsBackend) return TEMPLATES["node-express"];
  // Static / no-build.
  if (isStatic) return TEMPLATES["static"];
  // Vue SPA.
  if (isVue) return TEMPLATES["vue-vite"];
  // Default: React SPA.
  return TEMPLATES["react-vite"];
}
