/**
 * Per-model hyperparameter tuning harness.
 *
 * ONE algorithm, applied per model: for each model in MODELS, run a small eval
 * SUITE under each candidate CONFIG, score every run with the SAME deterministic
 * metrics the generation pipeline already uses (component gaps, truncation,
 * structural flags) plus practical signals (wall-clock time, output size to punish
 * runaway verbosity, file count), then write the best-scoring config per model to
 * `src/lib/ai/hyperparams-tuned.json` — which `samplingFor()` loads at runtime.
 *
 * REALITY CHECK: this finds each model's OWN best config; it does not make a weak
 * model equal to a frontier one. It reliably improves speed/cleanliness/completeness
 * within a model's ceiling.
 *
 * Run (needs API credit on the gateways you tune):
 *   npx tsx scripts/tune-hyperparams.mts                 # tune the default free tier
 *   npx tsx scripts/tune-hyperparams.mts --dry-run       # validate scoring, no API
 *   MODELS=kilocode:kilo-auto/free npx tsx scripts/tune-hyperparams.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { streamText, stepCountIs } from "ai";
import { resolveModel } from "../src/lib/ai/providers.ts";
import { ALL_TOOLS } from "../src/lib/ai/tools.ts";
import { AGENT_CONFIGS } from "../src/lib/ai/agents.ts";
import {
  extractArtifacts,
  detectComponentGaps,
  detectTruncatedArtifacts,
  detectArtifactFlags,
  type Artifact,
} from "../src/lib/ai/prompt-pipeline.ts";
import type { SamplingParams } from "../src/lib/ai/hyperparams.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(__dir, "../src/lib/ai/hyperparams-tuned.json");
const DRY = process.argv.includes("--dry-run");

// Load .env.local so the gateway keys are available (tsx doesn't auto-load it).
try {
  for (const line of readFileSync(join(__dir, "../.env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env.local — rely on the ambient env */ }

// Models to tune: "provider:id". Free tier by default (where tuning helps most).
const MODELS = (process.env.MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [
  "kilocode:kilo-auto/free",
  "huggingface:Qwen/Qwen3.6-27B",
  "aimlapi:gpt-3.5-turbo",
]).map((k) => { const i = k.indexOf(":"); return { provider: k.slice(0, i), id: k.slice(i + 1) }; });

// Candidate sampling configs. Tuned for code: low temperature; the penalty variants
// target the free tier's runaway re-emission. (Anthropic ignores penalties — they're
// simply dropped there, so the same grid is safe across providers.)
const CONFIGS: SamplingParams[] = [
  { temperature: 0.1 },
  { temperature: 0.2 },
  { temperature: 0.2, topP: 0.9, frequencyPenalty: 0.3, presencePenalty: 0.1 },
  { temperature: 0.3, topP: 0.9, frequencyPenalty: 0.5, presencePenalty: 0.2 },
];

// Small eval suite spanning app types. Keep it lean — every (model × config × task)
// is a real generation. `requestText` drives the component gate; `minFiles` is a
// rough completeness floor for the task.
const SUITE = [
  { name: "static-todo", minFiles: 3, prompt: "Build a todo list app (add, toggle, delete) with plain HTML, CSS, and vanilla JS." },
  { name: "fullstack-notes", minFiles: 6, prompt: "Build a small full-stack Notes app: an Express backend with REST CRUD endpoints and a React (Vite) frontend that lists, adds, and deletes notes via the API." },
];

const MAX_TOKENS = Number(process.env.TUNE_MAX_TOKENS) || 4000;
const builderTools = Object.fromEntries(
  Object.entries(ALL_TOOLS).filter(([k]) => AGENT_CONFIGS.appBuilder.tools.includes(k)),
);

/** Higher is better. Rewards complete, non-truncated, fast, non-runaway builds. */
function score(artifacts: Artifact[], requestText: string, minFiles: number, seconds: number, bytes: number): number {
  let s = 100;
  s -= 25 * detectComponentGaps(artifacts, requestText).length;
  s -= 15 * detectTruncatedArtifacts(artifacts).length;
  s -= 8 * detectArtifactFlags(artifacts).length;
  s += artifacts.length >= minFiles ? 10 : -10;
  if (seconds > 120) s -= (seconds - 120) / 10;            // slow penalty
  if (bytes > 400_000) s -= (bytes - 400_000) / 100_000;   // runaway-verbosity penalty
  return Math.round(s * 10) / 10;
}

async function runOne(model: ReturnType<typeof resolveModel>, cfg: SamplingParams, prompt: string) {
  const t0 = Date.now();
  const result = streamText({
    model,
    system: AGENT_CONFIGS.appBuilder.systemPrompt,
    prompt,
    tools: builderTools,
    stopWhen: stepCountIs(1000),
    maxOutputTokens: MAX_TOKENS,
    ...cfg,
  });
  const text = await result.text;
  const artifacts = extractArtifacts(await result.steps);
  return { artifacts, seconds: (Date.now() - t0) / 1000, bytes: text.length + JSON.stringify(artifacts).length };
}

async function main() {
  if (DRY) {
    // Validate the scoring + imports without spending tokens.
    const complete: Artifact[] = [
      { path: "frontend/index.html", content: "<!doctype html><script type=\"module\" src=\"/src/main.jsx\"></script>" },
      { path: "frontend/src/main.jsx", content: "import App from './App'" },
      { path: "frontend/src/App.jsx", content: "export default function App(){return <div/>}" },
      { path: "backend/index.js", content: "const express=require('express'); express().listen(3001)" },
      { path: "backend/package.json", content: "{\"dependencies\":{\"express\":\"^4\"}}" },
      { path: "backend/routes.js", content: "app.get('/api/notes'); app.post('/api/notes'); app.delete('/api/notes')" },
    ];
    console.log("[dry-run] complete fullstack score:", score(complete, SUITE[1].prompt, 6, 40, 30_000));
    console.log("[dry-run] frontend-only score:", score(complete.slice(0, 3), SUITE[1].prompt, 6, 40, 20_000));
    console.log("[dry-run] runaway (slow+huge) score:", score(complete, SUITE[1].prompt, 6, 600, 2_500_000));
    console.log("[dry-run] grid:", CONFIGS.length, "configs ×", SUITE.length, "tasks ×", MODELS.length, "models");
    return;
  }

  const registry: Record<string, SamplingParams> = JSON.parse(readFileSync(REGISTRY, "utf8") || "{}");
  for (const m of MODELS) {
    const key = `${m.provider}:${m.id}`;
    const model = resolveModel(m.id, m.provider);
    let best: { cfg: SamplingParams; avg: number } | null = null;
    console.log(`\n=== tuning ${key} ===`);
    for (const cfg of CONFIGS) {
      let total = 0;
      for (const task of SUITE) {
        try {
          const r = await runOne(model, cfg, task.prompt);
          const sc = score(r.artifacts, task.prompt, task.minFiles, r.seconds, r.bytes);
          total += sc;
          console.log(`  ${JSON.stringify(cfg).padEnd(72)} ${task.name.padEnd(16)} score=${sc} files=${r.artifacts.length} ${r.seconds.toFixed(0)}s`);
        } catch (e) {
          console.log(`  ${JSON.stringify(cfg)} ${task.name} ERROR: ${(e as Error).message.slice(0, 80)}`);
          total -= 50;
        }
      }
      const avg = total / SUITE.length;
      if (!best || avg > best.avg) best = { cfg, avg };
    }
    if (best) {
      registry[key] = best.cfg;
      console.log(`  -> best for ${key}: ${JSON.stringify(best.cfg)} (avg ${best.avg.toFixed(1)})`);
    }
  }
  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
  console.log(`\nwrote ${REGISTRY}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
