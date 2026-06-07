# Agentic AI Studio — Platform Guide & Training

A complete reference for how this platform works: its architecture, the key
files, the chat → code-generation → preview → deploy pipeline, and how to
generate **end-to-end applications in any technology**.

> If you only read one section, read **§7 Generating end-to-end apps** and
> **§8 The deploy pipeline** — that's where most questions (and most deploy
> failures) live.

---

## 1. What this is

A full-stack, chat-driven application builder. You describe an app; an LLM
generates the files; you preview them live in the browser; then you one-click
deploy the frontend to **Vercel**, the backend to **Render** (wired to a managed
**Aiven** Postgres), or download a ready-to-run `.zip` (with a Dockerfile) for
any stack.

- **Frontend/runtime:** Next.js 16 (App Router, standalone output), React 19,
  Tailwind, Zustand for state.
- **AI:** Vercel AI SDK v6 (`streamText`/`generateText`, UI message streams,
  tool calling) over **OpenRouter** models.
- **DB (platform's own):** Prisma v7 + Postgres (Aiven). See
  `prisma/schema.prisma`.
- **In-browser preview:** WebContainers (StackBlitz) run Node apps client-side.
- **Deploy targets:** Vercel (frontend), Render + Aiven (backend), zip/Docker.

The platform itself is deployed to Render at `agentic-ai-studio.onrender.com`
from the `deploy/render` branch (Docker). See the deploy memory / `render.yaml`.

---

## 2. Tech stack & conventions

- **Next.js 16 is not the Next.js in your training data.** Read
  `node_modules/next/dist/docs/` before changing framework-level code. Builds
  must run with `NODE_ENV=production` (see `package.json` → `build`).
- **Routing:** App Router. API routes live in `src/app/api/**/route.ts`.
- **State:** Zustand stores in `src/store/` (`chat.ts`, `workspace.ts`). These
  are the source of truth for the UI; request params are read lazily from them.
- **Server vs client:** deploy/codegen prep logic is pure functions over
  `{ path, content }` files so it runs safely on the server. UI is client
  components (`"use client"`).
- **Identity:** local-first, no login. Each browser carries a stable
  `x-user-id` (see `src/lib/user-id.ts`); all chat APIs are scoped to it.

---

## 3. Architecture & request flow

```
                          ┌─────────────────────────────────────────────┐
   Browser (workspace)    │  Zustand stores: chat.ts, workspace.ts       │
   ┌───────────────────┐  └─────────────────────────────────────────────┘
   │ ChatWindow        │ ── POST /api/chat ─────────► streamText (OpenRouter)
   │ CodeEditor        │        │  prompt-pipeline pre/post-process
   │ FileExplorer      │        │  tools (createFile, generateImage, search…)
   │ PreviewPanel      │ ◄── UI message stream (tokens + tool parts)
   │ DeployPanel       │
   └───────────────────┘ ── POST /api/deploy           → Vercel
                          ── POST /api/deploy/render    → GitHub + Render
                          ── POST /api/deploy/fullstack → Render + Vercel
```

1. **Chat:** the user sends a message. `ChatWindow` streams from `/api/chat`.
2. **Codegen:** the model writes files via the `createFile` tool *or* as fenced
   markdown code blocks. Both are extracted into the workspace file store.
3. **Preview:** static sites render in a sandboxed iframe; Node apps run in a
   WebContainer (`Run app`).
4. **Deploy:** the selected app's files are normalized and shipped to a target.

---

## 4. Directory map — the files that matter

### App / API routes (`src/app/`)
| File | Role |
|---|---|
| `api/chat/route.ts` | Main generation endpoint. Resolves the agent, builds the system prompt, runs `streamText` with tools, drives the output pipeline. |
| `api/agent/route.ts` | Non-chat single-shot agent endpoint. |
| `api/deploy/route.ts` | Deploy a frontend to **Vercel** (inline files). |
| `api/deploy/render/route.ts` | Deploy a **backend** to Render (via GitHub). |
| `api/deploy/fullstack/route.ts` | Backend→Render + frontend→Vercel, wired together. |
| `api/chats/**` | CRUD for chats & messages (Prisma). |
| `api/models/route.ts` | Model catalog for the selector. |
| `api/image/route.ts`, `api/parse/route.ts` | Image gen, document parsing. |
| `layout.tsx`, `page.tsx`, `providers.tsx` | Shell, workspace mount, providers. |

### AI / codegen (`src/lib/ai/`)
| File | Role |
|---|---|
| `agents.ts` | **Agent definitions**: system prompts, allowed tools, temperature, step limits, and `detectAgentType`. The biggest lever on output quality. |
| `prompt-pipeline.ts` | Pre-process (shape/rewrite the prompt) and post-process (quality scoring, refine, artifact QA, the build-quality contract). |
| `tools.ts` | Tool definitions (`createFile`, `generateImage`, web search, etc.). |
| `providers.ts` | `resolveModel(modelId, provider)` — wires models to OpenRouter. |
| `models-catalog.ts` | The list of selectable models. |
| `extract-files.ts` | Pull files out of markdown code fences (fallback path). |
| `tool-parts.ts` | Read tool parts back off UI messages. |
| `deps.ts` | `augmentPackageJson` — adds imported-but-undeclared npm deps. |

### Deploy pipeline (`src/lib/deploy/`)
| File | Role |
|---|---|
| `prepare.ts` | **Normalize any project for Vercel.** Framework detection, re-rooting, build-resilience (import repair, missing-import stubs, Tailwind pin, entry/index.html synthesis). See §8. |
| `frontend-prepare.ts` | Detect the frontend sub-app, wire it to the backend URL (env + `vercel.json` proxy), pin Tailwind. |
| `render-prepare.ts` | Detect the backend sub-app, swap Prisma sqlite→postgres, bind `$PORT`, derive build/start commands, and report `hasBackend`. |
| `vercel.ts` | Vercel API client (`deployToVercel`, status polling). |
| `render.ts` | Render API client (`createRenderService`). |
| `github.ts` | Create a repo and push files (Render builds from a repo). |
| `dockerfile.ts`, `download.ts` | `.zip` export with a Dockerfile + deploy guide. |

### Workspace, preview, state
| File | Role |
|---|---|
| `src/store/workspace.ts` | Files, active file/tab, build log, selected app. |
| `src/store/chat.ts` | Sessions, model/agent selection, tool/enhance toggles. |
| `src/lib/workspace/apps.ts` | `detectAppGroups` / `filesForApp` — split a multi-app chat into deployable sub-apps and re-root the selected one. |
| `src/lib/webcontainer/runner.ts` | Boot a Node app in-browser, auto-heal common install/build issues. |
| `src/components/workspace/*` | Code editor, file explorer, preview, deploy panels. |
| `src/components/chat/*` | Chat window, input, message rendering, selectors. |

---

## 5. The chat → codegen flow (in `api/chat/route.ts`)

1. Parse body: `messages`, `modelId`, `provider`, `agentType`, `enableTools`,
   `enhancePrompt`, `refineOutput`, `temperature`.
2. **Resolve the agent** — explicit selection wins; `orchestrator` (default)
   auto-routes via `detectAgentType(lastText)`.
3. Pull the agent's `systemPrompt`, allowed `tools`, `temperature`, `maxSteps`.
4. **Pre-process** (`preprocessPrompt`): always add a system *augmentation*
   (the quality contract); optionally rewrite vague/short/complex prompts with a
   cheap model. Fail-open.
5. **Tool availability:** if the model can't/ won't call tools, a markdown
   file-output fallback is appended to the system prompt so code still reaches
   the workspace.
6. **Stream** with `streamText`, then **post-process** via
   `applyOutputPipeline`: stream tokens live, then (only for low-quality answers)
   append a refined section; for artifact agents, run build-QA + one bounded
   auto-repair pass over generated files.

Two ways files reach the workspace: the **`createFile` tool**, or **fenced
code blocks** whose info line starts with the file path
(```` ```html index.html ````). Always emit complete, runnable files.

---

## 6. Agents & prompt pipeline

Agents are defined in `src/lib/ai/agents.ts`. The **artifact agents** —
`coding`, `appBuilder`, `gameDev`, `uiux` — get the `BUILD_CONTRACT` from
`prompt-pipeline.ts`, which enforces:

- Complete, production-ready output: no placeholders/TODOs/"...".
- The **entry/start file + root component must exist for ANY stack**, and every
  transitively-imported file must exist.
- Polished, responsive, accessible UI; realistic sample data; empty/loading
  states.

`detectArtifactFlags` (in `prompt-pipeline.ts`) flags concrete weaknesses
(empty files, placeholders, missing viewport meta, imported-but-uncreated local
modules) and the route's bounded **auto-repair** pass re-creates flagged files.

> Improving generation quality is mostly editing **agent prompts** +
> **`BUILD_CONTRACT`** + **`detectArtifactFlags`**, not the deploy pipeline.

---

## 7. Generating end-to-end apps in ANY technology

The platform is stack-agnostic by design. What changes per stack is (a) what the
model generates and (b) which deploy target + preset is used.

### What "end-to-end" means here
- **Frontend** → Vercel (or any static/JS preset Vercel supports).
- **Backend/API** → Render (long-running Node server) wired to Aiven Postgres.
- **Any other stack** → download the `.zip` (includes a Dockerfile) and run it
  anywhere.

### How to get a good end-to-end app
1. **Pick the agent.** `App Builder` for full apps, `Coding` for focused code,
   `Game Dev`, `UI/UX`, or leave `Orchestrator` to auto-route.
2. **Describe the whole app in one prompt**: stack, screens/features, data
   model, and that you want it production-ready and deployable. Example:
   > "Build a CRM as a **Vite + React** frontend and an **Express + Prisma
   > (Postgres)** backend in a monorepo (`frontend/`, `backend/`). Contacts,
   > companies, deals CRUD with auth. Include the entry files, sample data, and
   > make every import resolve."
3. **Structure for deploy** — ask for a monorepo with clearly named folders so
   detection works:
   - Frontend folder name: `frontend` / `client` / `web` / `app` / `ui`.
   - Backend folder name: `backend` / `server` / `api`.
4. **Preview** static sites instantly; click **Run app** for Node apps.
5. **Deploy:**
   - Frontend-only → **Vercel** tile.
   - Backend → **Backend only → Render** (needs a real server).
   - Both → **Deploy full app** (skips the backend automatically if there isn't
     a real one).

### Per-stack notes (what the platform supports out of the box)
- **Vite (React/Vue/Svelte/Solid):** auto-detected; forgiving `vite build`,
  `dist` output; missing `vite.config`/`tsconfig`/`index.html`/entry are
  synthesized; Tailwind pinned to v3.
- **Next.js, CRA, Nuxt, SvelteKit, Astro, Gatsby, Remix, Angular, Vue-CLI,
  Docusaurus, …** → mapped to their Vercel preset (`prepare.ts → detectJsFramework`).
- **Static sites / any language's HTML output** → deployed as static.
- **Node backends (Express/Fastify/Koa/Nest/…):** detected by deps or a real
  server entry; `$PORT` binding injected; build/start derived.
- **Prisma apps:** sqlite (preview) → postgres (deploy) swap; Prisma pinned to
  v6 for `url = env(...)`; each app gets its own Postgres `schema`.
- **Anything else (Python/Go/Rust/…):** download the `.zip` — it ships with a
  Dockerfile so it runs on any container host.

---

## 8. The deploy pipeline & build-resilience (the part that breaks)

Generated code is imperfect, so the pipeline **normalizes and self-heals** every
project before shipping. All of this lives in `src/lib/deploy/`.

### Frontend → Vercel (`prepare.ts`, then `vercel.ts`)
`prepareForDeploy(files)` runs, in order:
1. `augmentPackageJson` — declare imported-but-missing npm packages.
2. **`repairImportPaths`** — fix misrouted *relative* imports (e.g.
   `components/Layout.jsx` importing `./components/ui/button` → `./ui/button`)
   when exactly one file matches the basename. *(Fixes "Could not resolve …".)*
3. `stubMissingImports` — stub default-imported local modules that were never
   created (visible "missing component" placeholder).
4. `pinTailwindV3` — generated apps use v3 directives but install v4 (whose
   PostCSS plugin moved) → pin to v3.
5. Pick the app's `package.json`, then **re-root** to its folder. *Inline
   (files[]) deployments ignore Vercel's `rootDirectory`*, so we physically move
   the app to the deployment root.
6. Detect the framework → preset. For Vite/React: forgiving `vite build`,
   inject `vite.config`/`tsconfig` if missing.
7. **`ensureViteIndexHtml`** — guarantee a root `index.html` (Vite hard-fails
   without one).
8. **`ensureViteEntry`** — guarantee the module `index.html` loads actually
   exists; synthesize `main` (+ a placeholder `App` to mount) if missing.
   *(Fixes "failed to resolve import /src/main.jsx".)*

`frontend-prepare.ts` additionally wires the frontend to the backend URL:
localhost→URL rewrite, `.env.production` (`VITE_API_URL`/etc.), and a
`vercel.json` `/api/*` proxy.

### Backend → Render (`render-prepare.ts`, `github.ts`, `render.ts`)
`prepareBackendForRender(files)`:
1. `detectBackendDir` — pick the server folder (backend deps / `server`/`api`
   name / Prisma schema), skip pure frontends.
2. Swap Prisma `sqlite`→`postgresql`, sanitize `.env`, bind `.listen(PORT)` to
   `process.env.PORT`, fix `@prisma/client` ESM import, pin Prisma v6.
3. Derive `buildCommand` (`npm install` [+ `prisma generate` + `db push`]) and
   `startCommand` (explicit `start` script, else the real entry file).
4. **`hasBackend`** — true only if there's a real server (backend deps, Prisma,
   or a real entry) and it isn't a pure frontend. The routes **skip the Render
   deploy when false** instead of shipping a service that crashes with
   "Cannot find module". *(Fixes phantom-backend deploys.)*

### Full-stack (`api/deploy/fullstack/route.ts`)
Deploys the backend first (if `hasBackend`), then the frontend wired to the
backend URL. Either side can fail independently; the response reports both.

### Download (`download.ts`, `dockerfile.ts`)
Zips the selected app with a generated Dockerfile + deploy guide so any
stack/language runs anywhere.

---

## 9. Troubleshooting deploy errors

| Symptom (build log) | Cause | Handled by |
|---|---|---|
| `Could not resolve entry module "index.html"` | No root `index.html` (app under `src/`, or omitted) | `reRootFiles` + `ensureViteIndexHtml` |
| `failed to resolve import "/src/main.jsx"` | `index.html` entry module never generated | `ensureViteEntry` |
| `Could not resolve "./x/y" from "…"` | Wrong relative import path in generated code | `repairImportPaths` (single match) / `stubMissingImports` (default imports) |
| `Cannot find module '…/src/index.js'` (Render) | No real backend; phantom deploy | `hasBackend` gate |
| Tailwind PostCSS plugin error | v4 installed against v3 config | `pinTailwindV3` |
| Prisma P1012 (`url = env`) | Prisma v7 rejects `url` in schema | `pinPrismaV6` |
| `Failed to resolve import "<pkg>"` | Dep imported but not in package.json | `augmentPackageJson` |

**How to diagnose a live failure** (read-only API calls are fine):
- Vercel build log:
  `GET https://api.vercel.com/v3/deployments/<id>/events?builds=1` (Bearer `VERCEL_TOKEN`).
- Vercel uploaded files:
  `GET https://api.vercel.com/v6/deployments/<id>/files`.
- Render logs:
  `GET https://api.render.com/v1/logs?ownerId=<owner>&resource=<srv-id>` (Bearer `RENDER_API_KEY`).

When the failure is a **codegen** problem (missing/incorrect files), the durable
fix is in the agent prompts / `BUILD_CONTRACT` / `detectArtifactFlags`; the
deploy pipeline only makes it survivable.

---

## 10. Environment variables

Server-side (set on the platform's Render service **and** in local `.env.local`):

| Var | Used for |
|---|---|
| `DATABASE_URL` | Platform's own Postgres (Aiven). |
| `OPENROUTER_API_KEY` | All LLM calls. |
| `VERCEL_TOKEN` | Frontend deploys. `VERCEL_PUBLIC_DEPLOYMENTS=true` makes them public. |
| `GITHUB_TOKEN` | Create repos for Render backend deploys (needs repo create perms). |
| `RENDER_API_KEY` | Create Render services. |
| `DEFAULT_DATABASE_URL` | Aiven URL injected into deployed backends (one schema per app). |
| `PROMPT_ENHANCER_MODEL` | Override the cheap model for prompt rewrite/refine. |

> The auto-mode classifier blocks agent-run Render/Vercel **mutations** and
> production DB migrations — run those via the `!` shell prefix or a dashboard,
> or grant explicit approval.

---

## 11. Extending the platform

- **Add a model:** `src/lib/ai/models-catalog.ts` (+ `providers.ts` if needed).
- **Add/tune an agent:** `src/lib/ai/agents.ts` (prompt, tools, temperature,
  steps) and the contracts in `prompt-pipeline.ts`.
- **Add a tool:** `src/lib/ai/tools.ts`, then allow it for an agent in
  `agents.ts`.
- **Add a deploy provider:** a client in `src/lib/deploy/`, a route under
  `src/app/api/deploy/`, and a tile in `deploy-panel.tsx`.
- **Improve build-resilience:** add a normalization/repair step in
  `prepare.ts` (frontend) or `render-prepare.ts` (backend), and a row to §9.

---

## 12. Quick start for contributors

```bash
npm install
npm run dev            # http://localhost:3000
npm run build          # NODE_ENV=production (Turbopack)
npx prisma generate    # after schema changes
# Apply schema to a DB (needs that DB's DATABASE_URL):
DATABASE_URL=<url> npx prisma db push
```

Deploy of the platform itself: push `deploy/render` → Render auto-builds the
Docker image. The Docker build runs `prisma generate` + `next build` only — it
does **not** migrate the DB, so schema changes need a manual `prisma db push`.
