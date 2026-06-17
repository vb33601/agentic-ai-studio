/**
 * Phase-0 re-architecture EVAL HARNESS.
 *
 * Drives the REAL generation pipeline (POST /api/chat on a running dev server)
 * across a fixed prompt set spanning the platform's supported stacks, captures the
 * files each build actually produced (from the UI-message stream — both the
 * createFile tool calls AND markdown fences, exactly like the server's
 * gatherArtifacts), and scores every build on deterministic, structural
 * "would-it-build-and-boot" criteria. The output is an objective SUCCESS-RATE
 * BASELINE — the number the agentic-edit-loop re-architecture must move.
 *
 * It is OBSERVATIONAL: it changes nothing in the pipeline, so the same harness
 * re-runs unchanged against each phase to chart progress (15-20% → target).
 *
 * Usage (start the dev server first: `npm run dev`):
 *   BASE=http://localhost:3000 npx tsx scripts/eval-harness.mts
 *   # options:
 *   #   ONLY=static-html,fullstack-express   only these prompt ids
 *   #   ROUNDS=3                             run each prompt N times (LLM is nondeterministic)
 *   #   GEN_TIMEOUT_MS=600000                per-build cap (default 10 min)
 *   #   CONCURRENCY=1                        parallel builds (default 1 — be kind to rate limits)
 *   #   OUT=/tmp/aip-eval/run.json           where to write the JSON report
 *
 * Scoring — a build PASSES only when ALL hard criteria hold:
 *   1. produced >= expected.minFiles
 *   2. no completeness gaps — findAppGaps() finds no truncated files, no broken
 *      local imports/namespaces, and no missing backend/frontend half.
 *   3. deploy-ready — the deploy engine detects a stack and its Dockerfile passes
 *      every build-correctness invariant (checkDockerfileInvariants).
 *   4. the stream did not fatally error and at least one file was produced.
 * The server's own completeness verdict (data-verification) is recorded as
 * advisory context but does not gate the pass (we score independently of it).
 */
import { findAppGaps, findIncompleteFiles } from "../src/lib/ai/incomplete-files";
import { detectStackPlan } from "../src/lib/deploy/dockerfile";
import { checkDockerfileInvariants } from "../src/lib/deploy/stack-invariants";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE = process.env.BASE || "http://localhost:3000";
const GEN_TIMEOUT_MS = Number(process.env.GEN_TIMEOUT_MS) || 600_000; // 10 min/build
const ROUNDS = Math.max(1, Number(process.env.ROUNDS) || 1);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 1);
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = process.env.OUT || `/tmp/aip-eval/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

interface File { path: string; content: string }
interface Prompt {
  id: string;
  stack: string;
  prompt: string;
  expect: { minFiles: number; wantBackend?: boolean; wantFrontend?: boolean };
}

// A fixed, representative spread of the stacks + app types the studio claims to
// build. Kept deliberately stable so the baseline is comparable across phases.
const PROMPTS: Prompt[] = [
  { id: "static-html", stack: "static", expect: { minFiles: 1 },
    prompt: "Create a single file index.html containing an <h1> that says Hello World and a styled button. Only that one file." },
  { id: "static-landing", stack: "static", expect: { minFiles: 2, wantFrontend: true },
    prompt: "Build a responsive marketing landing page with a hero, features grid, and footer. Use separate index.html, styles.css and script.js with a working mobile nav toggle." },
  { id: "game-canvas", stack: "static", expect: { minFiles: 1 },
    prompt: "Build a playable Snake game that runs in the browser using HTML canvas and vanilla JavaScript. Arrow-key controls, score, and game over restart." },
  { id: "react-spa-todo", stack: "node", expect: { minFiles: 3, wantFrontend: true },
    prompt: "Build a React + Vite todo app: add a todo, list todos, toggle done, and delete a todo, with state persisted to localStorage. Include package.json, vite config, index.html and the React source." },
  { id: "vue-spa", stack: "node", expect: { minFiles: 3, wantFrontend: true },
    prompt: "Build a Vue 3 + Vite notes app where the user can add and delete notes, persisted in localStorage. Include package.json, vite config and the Vue source files." },
  { id: "svelte-spa", stack: "node", expect: { minFiles: 3, wantFrontend: true },
    prompt: "Build a Svelte + Vite expense tracker: add expenses with amount and category, show a running total, and delete entries. Include package.json and the Svelte source." },
  { id: "next-app", stack: "node", expect: { minFiles: 3, wantFrontend: true },
    prompt: "Build a Next.js (App Router) blog landing page with a home page listing posts and a dynamic /posts/[slug] page reading from a local posts array. Include package.json and the app directory." },
  { id: "dashboard-spa", stack: "node", expect: { minFiles: 4, wantFrontend: true },
    prompt: "Build a React + Vite analytics dashboard with a sidebar, KPI cards, and a simple bar chart drawn from a local dataset. Multiple components. Include package.json and vite config." },
  { id: "kanban-spa", stack: "node", expect: { minFiles: 4, wantFrontend: true },
    prompt: "Build a React + Vite Kanban board with three columns (Todo, Doing, Done), drag a card between columns, add and delete cards, persisted to localStorage. Multiple components." },
  { id: "fullstack-express", stack: "node", expect: { minFiles: 4, wantBackend: true, wantFrontend: true },
    prompt: "Build a notes app: an Express backend exposing GET and POST /api/notes, and a React (Vite) frontend that fetches and creates notes by calling that API. Wire them so both run." },
  { id: "ecommerce-fullstack", stack: "node", expect: { minFiles: 5, wantBackend: true, wantFrontend: true },
    prompt: "Build a small store: an Express backend with GET /api/products and a POST /api/cart endpoint, and a React (Vite) frontend showing products and an add-to-cart cart. Include package.json files for both." },
  { id: "django-api", stack: "python", expect: { minFiles: 5, wantBackend: true },
    prompt: "Build a Django REST API for a task manager: a Task model (title, done), and list/create/delete endpoints under /api/tasks. Include manage.py, settings, urls, models, views, serializers, and requirements.txt so it runs." },
  { id: "fastapi", stack: "python", expect: { minFiles: 2, wantBackend: true },
    prompt: "Build a FastAPI service for an in-memory item catalog with GET /items, POST /items and DELETE /items/{id}. Include main.py and requirements.txt so it runs with uvicorn." },
  { id: "flask", stack: "python", expect: { minFiles: 2, wantBackend: true },
    prompt: "Build a Flask REST API for a todo list with GET/POST /api/todos and DELETE /api/todos/<id>, storing todos in memory. Include app.py and requirements.txt." },
  { id: "dotnet-api", stack: "dotnet", expect: { minFiles: 3, wantBackend: true },
    prompt: "Build an ASP.NET Core minimal Web API for a bookstore: GET /books and POST /books with an in-memory list. Include the .csproj, Program.cs and a Book model so it builds and runs." },
  { id: "go-api", stack: "go", expect: { minFiles: 2, wantBackend: true },
    prompt: "Build a Go HTTP JSON API using net/http for a URL shortener: POST /shorten returns a short code, GET /{code} redirects. Include go.mod and main.go." },
  { id: "rails-api", stack: "ruby", expect: { minFiles: 5, wantBackend: true },
    prompt: "Build a Rails API-only app for a task tracker with a Task resource (title, completed) and index/create/destroy actions under /tasks. Include Gemfile, config, routes, model, controller and migration." },
  { id: "spring-api", stack: "java", expect: { minFiles: 4, wantBackend: true },
    prompt: "Build a Spring Boot REST API for a contact book: a Contact entity (name, email) and GET/POST/DELETE /api/contacts using an in-memory list. Include pom.xml, the application class, controller and model." },
  { id: "chat-fullstack", stack: "node", expect: { minFiles: 4, wantBackend: true, wantFrontend: true },
    prompt: "Build a simple chat app: an Express backend with GET /api/messages and POST /api/messages (in-memory), and a React (Vite) frontend that lists messages and sends new ones by polling the API." },
  { id: "crm-fullstack", stack: "node", expect: { minFiles: 5, wantBackend: true, wantFrontend: true },
    prompt: "Build a mini CRM: an Express backend with CRUD /api/customers (in-memory) and a React (Vite) frontend to list, add, edit and delete customers via that API. Include package.json for both halves." },
];

// ---------------------------------------------------------------------------
// Minimal markdown fence extractor (dependency-free; mirrors the server's intent
// without pulling the @/-aliased helper). Captures ```lang path\n…``` and
// ```path\n…``` fences. Used in addition to createFile tool parts.
// ---------------------------------------------------------------------------
const FILE_RE = /\.(html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|json5?|py|java|go|rs|c|cc|cpp|cxx|h|hpp|cs|php|rb|sql|ya?ml|toml|md|markdown|vue|svelte|sh|xml|env|csproj|gradle|mod|gemfile)$/i;
function extractMarkdownFiles(text: string): File[] {
  const out: File[] = [];
  const seen = new Set<string>();
  const fence = new RegExp("```([^\\n]*)\\n([\\s\\S]*?)```", "g");
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const info = m[1].trim();
    const code = m[2];
    // Find a filename token on the info line.
    let path: string | null = null;
    for (const tok of info.split(/\s+/).map((t) => t.replace(/^\/+/, "")).filter(Boolean)) {
      if ((FILE_RE.test(tok) || /^(dockerfile|makefile|gemfile)$/i.test(tok)) && !/\s/.test(tok)) { path = tok; break; }
    }
    if (!path) continue; // only count fences that name a file
    const content = code.replace(/\n$/, "");
    if (!content.trim() || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, content });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drive one generation: POST the prompt, parse the UI-message SSE stream, return
// the produced files + the server's completeness verdict + any fatal error.
// ---------------------------------------------------------------------------
interface GenResult {
  files: File[];
  verdict: { ok?: boolean; gaps?: string[] } | null;
  fatalError: string | null;
  elapsedMs: number;
  parts: number;
}

async function generate(p: Prompt): Promise<GenResult> {
  const started = Date.now();
  const body = {
    // Match what the UI sends; omit modelId/provider so the route uses its anchor.
    messages: [{ id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text: p.prompt }] }],
    agentType: "orchestrator",
    enableTools: true,
    enhancePrompt: true,
    refineOutput: true,
    // AGENT_LOOP=1 routes this request through the new agentic edit loop (the
    // re-architecture path) so one dev server can serve both legacy and new runs.
    ...(process.env.AGENT_LOOP === "1" ? { agentLoop: true } : {}),
    // Pin a specific funded model (EVAL_MODEL_ID/EVAL_PROVIDER) so the A/B measures
    // ARCHITECTURE, not model supply (free-tier quotas / empty premium accounts).
    ...(process.env.EVAL_MODEL_ID ? { modelId: process.env.EVAL_MODEL_ID, provider: process.env.EVAL_PROVIDER || "gateway" } : {}),
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEN_TIMEOUT_MS);
  const text: string[] = [];
  const tools = new Map<string, { name?: string; input?: unknown; output?: unknown }>();
  let verdict: GenResult["verdict"] = null;
  let fatalError: string | null = null;
  let parts = 0;

  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`;
      try { detail += ` ${(await res.json())?.error ?? ""}`; } catch { /* not json */ }
      return { files: [], verdict: null, fatalError: detail, elapsedMs: Date.now() - started, parts: 0 };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      // SSE frames are separated by blank lines; data payloads are `data: <json>`.
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let part: Record<string, unknown>;
        try { part = JSON.parse(payload); } catch { continue; }
        parts++;
        const type = String(part.type ?? "");
        if (type === "text-delta") {
          text.push(String((part as Record<string, unknown>).delta ?? (part as Record<string, unknown>).text ?? ""));
        } else if (type === "error") {
          fatalError = String((part as Record<string, unknown>).errorText ?? (part as Record<string, unknown>).error ?? "stream error");
        } else if (type === "data-verification") {
          verdict = (part as { data?: GenResult["verdict"] }).data ?? null;
        } else if (part.toolCallId) {
          // Tool parts (typed `tool-*` or `dynamic-tool`) — accumulate by id.
          const id = String(part.toolCallId);
          const cur = tools.get(id) ?? {};
          if (part.toolName) cur.name = String(part.toolName);
          if ("input" in part) cur.input = part.input;
          if ("args" in part) cur.input = part.args;
          if ("output" in part) cur.output = part.output;
          if ("result" in part) cur.output = part.result;
          tools.set(id, cur);
        }
      }
    }
  } catch (err) {
    fatalError = (err as Error)?.name === "AbortError" ? `timeout after ${GEN_TIMEOUT_MS}ms` : String((err as Error)?.message ?? err);
  } finally {
    clearTimeout(timer);
  }

  // Merge: markdown fences first, then createFile tool output (tool wins) — the
  // exact precedence the server uses in gatherArtifacts.
  const byPath = new Map<string, File>();
  for (const f of extractMarkdownFiles(text.join(""))) byPath.set(f.path, f);
  for (const { name, input, output } of tools.values()) {
    if (name !== "createFile") continue;
    const d = (output ?? input) as { path?: string; content?: string } | undefined;
    if (d?.path && typeof d.content === "string" && d.content !== "") byPath.set(d.path, { path: d.path, content: d.content });
  }
  return { files: [...byPath.values()], verdict, fatalError, elapsedMs: Date.now() - started, parts };
}

// ---------------------------------------------------------------------------
// Score one build (deterministic, structural).
// ---------------------------------------------------------------------------
interface Score {
  id: string;
  stack: string;
  pass: boolean;
  files: number;
  minFiles: number;
  reasons: string[];
  truncated: string[];
  gaps: string[];
  deployErrs: string[];
  detectedStack?: string;
  detectedFramework?: string;
  verdictOk: boolean | null;
  elapsedMs: number;
  fatalError: string | null;
}

function score(p: Prompt, g: GenResult): Score {
  const reasons: string[] = [];
  if (g.fatalError) reasons.push(`stream error: ${g.fatalError}`);
  if (g.files.length === 0) reasons.push("no files produced");

  const minOk = g.files.length >= p.expect.minFiles;
  if (!minOk) reasons.push(`only ${g.files.length}/${p.expect.minFiles} expected files`);

  const truncated = findIncompleteFiles(g.files);
  const gaps = findAppGaps(g.files, p.prompt); // truncation + broken refs + missing halves

  let deployErrs: string[] = [];
  let detectedStack: string | undefined;
  let detectedFramework: string | undefined;
  if (g.files.length) {
    try {
      const plan = detectStackPlan(g.files);
      detectedStack = plan.stack;
      detectedFramework = plan.framework;
      deployErrs = checkDockerfileInvariants(plan);
    } catch (e) {
      deployErrs = [`stack detection threw: ${String((e as Error)?.message ?? e)}`];
    }
  }
  if (gaps.length) reasons.push(`${gaps.length} completeness gap(s)`);
  if (deployErrs.length) reasons.push(`${deployErrs.length} deploy invariant failure(s)`);

  const pass = !g.fatalError && g.files.length > 0 && minOk && gaps.length === 0 && deployErrs.length === 0;
  return {
    id: p.id, stack: p.stack, pass, files: g.files.length, minFiles: p.expect.minFiles,
    reasons, truncated, gaps, deployErrs, detectedStack, detectedFramework,
    verdictOk: g.verdict?.ok ?? null, elapsedMs: g.elapsedMs, fatalError: g.fatalError,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function pool<T, R>(items: T[], n: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function main() {
  const selected = ONLY.length ? PROMPTS.filter((p) => ONLY.includes(p.id)) : PROMPTS;
  if (!selected.length) { console.error("No prompts match ONLY=", ONLY.join(",")); process.exit(2); }

  // Quick reachability check so a stopped dev server fails fast & clearly.
  try {
    const ping = await fetch(BASE, { method: "GET" });
    if (!ping.ok && ping.status >= 500) throw new Error(`status ${ping.status}`);
  } catch (e) {
    console.error(`\n✗ Cannot reach dev server at ${BASE} — start it with \`npm run dev\` (or set BASE).\n  ${String((e as Error)?.message ?? e)}\n`);
    process.exit(2);
  }

  // Expand by ROUNDS so LLM nondeterminism is averaged into the baseline.
  const runs: Prompt[] = [];
  for (let r = 0; r < ROUNDS; r++) for (const p of selected) runs.push(p);

  const pathMode = process.env.AGENT_LOOP === "1" ? "NEW agentic edit loop" : "LEGACY one-shot";
  console.log(`\n▶ Eval harness [${pathMode}] — ${selected.length} prompts × ${ROUNDS} round(s) = ${runs.length} builds  (concurrency=${CONCURRENCY})`);
  console.log(`  BASE=${BASE}  timeout=${GEN_TIMEOUT_MS / 1000}s/build\n`);

  let done = 0;
  const scores = await pool(runs, CONCURRENCY, async (p) => {
    const g = await generate(p);
    const s = score(p, g);
    done++;
    const tag = s.pass ? "✓ PASS" : "✗ FAIL";
    const why = s.pass ? "" : `  — ${s.reasons.join("; ")}`;
    console.log(`  [${String(done).padStart(2)}/${runs.length}] ${tag}  ${s.id.padEnd(22)} files=${s.files} stack=${s.detectedStack ?? "?"} ${(s.elapsedMs / 1000).toFixed(0)}s${why}`);
    return s;
  });

  // Aggregate.
  const passed = scores.filter((s) => s.pass).length;
  const rate = (passed / scores.length) * 100;
  const byStack = new Map<string, { pass: number; total: number }>();
  for (const s of scores) {
    const b = byStack.get(s.stack) ?? { pass: 0, total: 0 };
    b.total++; if (s.pass) b.pass++;
    byStack.set(s.stack, b);
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  OVERALL SUCCESS RATE:  ${passed}/${scores.length}  =  ${rate.toFixed(1)}%`);
  console.log(`${"=".repeat(64)}`);
  console.log("  By stack:");
  for (const [stack, b] of [...byStack.entries()].sort()) {
    console.log(`    ${stack.padEnd(10)} ${b.pass}/${b.total}  (${((b.pass / b.total) * 100).toFixed(0)}%)`);
  }
  // Top failure reasons.
  const reasonCounts = new Map<string, number>();
  for (const s of scores) if (!s.pass) for (const r of s.reasons) {
    const key = r.replace(/\d+/g, "N").replace(/:.*$/, "").trim();
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  if (reasonCounts.size) {
    console.log("  Top failure reasons:");
    for (const [r, c] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(3)}×  ${r}`);
    }
  }

  const report = {
    ts: new Date().toISOString(), base: BASE, rounds: ROUNDS,
    total: scores.length, passed, rate: Number(rate.toFixed(1)),
    byStack: Object.fromEntries([...byStack.entries()].map(([k, v]) => [k, v])),
    scores,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n  Full report → ${OUT}\n`);

  // Non-zero exit if everything failed (likely a config/server problem, not the model).
  process.exit(passed === 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
