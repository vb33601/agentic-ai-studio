/**
 * Web-search-grounded auto-fix for REAL build/deploy errors.
 *
 * The deterministic transforms in `deploy/prepare.ts` + `deploy/*-prepare.ts`
 * handle the common, known failure classes cheaply on every deploy. This module
 * is the ESCALATION layer for the long tail across the 100+ stacks a generated
 * app might use: given an actual build error (from the WebContainer preview or a
 * Vercel/Render build log), it
 *   1. detects the technologies involved (from deps + file signatures),
 *   2. searches the web for the exact error + those technologies, going DEEPER
 *      (more queries, then reading the top pages in full) until it has a
 *      confident, corroborated fix rather than a guess,
 *   3. asks the model to apply that documented fix as a minimal set of file
 *      edits, grounded in the findings (with the sources cited back).
 *
 * It is provider-agnostic (routes through [[providers]] / OpenRouter) and pure
 * server code, so both the deploy route and the preview can call it. Returns the
 * patched files plus a report of what it searched and changed.
 */

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getModel } from "./providers";
import { searchWeb, fetchPageText, type WebResult } from "./web-search";
import type { SourceFile } from "./deps";

export interface AutoFixSource {
  title: string;
  url: string;
}

export interface AutoFixReport {
  rootCause: string;
  explanation: string;
  technologies: string[];
  queries: string[];
  sources: AutoFixSource[];
  editedPaths: string[];
  confident: boolean;
  depthReached: number;
  /** Set when the loop produced no findings or the model returned no edits. */
  note?: string;
}

export interface AutoFixResult {
  files: SourceFile[];
  report: AutoFixReport;
  changed: boolean;
}

// --- 1. Technology detection -------------------------------------------------

// A generated app can use anything; rather than enumerate 100+ stacks, we read
// the project's OWN dependency names (the best possible search terms) and add a
// few framework labels inferred from signature files. This map only PROMOTES the
// most search-worthy frameworks to the front of the query — unknown libraries
// still flow through as raw dependency names.
const PROMOTE = new Set([
  "next", "react", "react-dom", "vue", "svelte", "@sveltejs/kit", "nuxt", "astro",
  "@angular/core", "solid-js", "preact", "vite", "react-scripts", "remix",
  "express", "fastify", "@nestjs/core", "koa", "hapi", "prisma", "@prisma/client",
  "drizzle-orm", "mongoose", "typeorm", "sequelize", "tailwindcss", "typescript",
  "graphql", "@apollo/client", "trpc", "@trpc/server", "redux", "zustand",
]);

const SIGNATURE_TECH: Array<[RegExp, string]> = [
  [/(^|\/)prisma\/schema\.prisma$/, "prisma"],
  [/(^|\/)tailwind\.config\./, "tailwindcss"],
  [/(^|\/)next\.config\./, "next"],
  [/(^|\/)vite\.config\./, "vite"],
  [/(^|\/)svelte\.config\./, "svelte"],
  [/(^|\/)nuxt\.config\./, "nuxt"],
  [/(^|\/)astro\.config\./, "astro"],
  [/(^|\/)angular\.json$/, "angular"],
  [/(^|\/)requirements\.txt$/, "python"],
  [/(^|\/)pyproject\.toml$/, "python"],
  [/(^|\/)go\.mod$/, "go"],
  [/(^|\/)Cargo\.toml$/, "rust"],
  [/(^|\/)Gemfile$/, "ruby"],
  [/(^|\/)pom\.xml$/, "java"],
  [/(^|\/)Dockerfile$/, "docker"],
];

/** Ordered, de-duplicated technology labels for the search queries. */
export function detectTechnologies(files: SourceFile[]): string[] {
  const promoted = new Set<string>();
  const rest = new Set<string>();

  for (const f of files) {
    if (f.path === "package.json" || f.path.endsWith("/package.json")) {
      try {
        const pkg = JSON.parse(f.content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
        for (const name of Object.keys(deps)) (PROMOTE.has(name) ? promoted : rest).add(name);
      } catch {
        /* ignore malformed package.json */
      }
    }
    for (const [re, label] of SIGNATURE_TECH) if (re.test(f.path)) promoted.add(label);
  }
  return [...promoted, ...rest].slice(0, 12);
}

// --- 2. Error signature ------------------------------------------------------

// Lines that look like the ACTUAL cause, in rough priority order. Kept broad so
// it works across stacks (JS/TS bundlers, Prisma, npm, Python, Go, Docker, …).
const ERROR_SIGNALS = [
  /could not resolve|is not exported by|failed to resolve import|module not found|cannot find module/i,
  /error\s+ts\d+|type error|invalid js syntax|unexpected token|syntaxerror/i,
  /ERESOLVE|ETARGET|npm error|peer dep|unable to resolve dependency/i,
  /prisma|P\d{4}\b|relation .* without|db push/i,
  /error:|failed to compile|build failed|exited with (?:code )?[1-9]/i,
  /traceback|modulenotfounderror|importerror|panic:|cannot find package/i,
];

export interface ErrorSignature {
  message: string;
  context: string[];
}

/** Extract the most salient error line(s) from a build log. */
export function buildErrorSignature(log: string): ErrorSignature {
  const lines = log
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { message: "build failed", context: [] };

  let idx = -1;
  for (const signal of ERROR_SIGNALS) {
    idx = lines.findIndex((l) => signal.test(l));
    if (idx !== -1) break;
  }
  if (idx === -1) idx = lines.length - 1; // fall back to the last line
  const message = lines[idx].replace(/^\s*(?:x|✗|error|Error)[:\s]+/, "").trim().slice(0, 200);
  // A little surrounding context helps both the search and the model.
  const context = lines.slice(Math.max(0, idx - 2), idx + 4);
  return { message, context };
}

// --- 3. Files worth showing the model (bounded tokens) -----------------------

const CONFIG_FILE =
  /(^|\/)(package\.json|vite\.config\.[jt]s|next\.config\.[a-z]+|tsconfig\.json|tailwind\.config\.[a-z]+|postcss\.config\.[a-z]+|svelte\.config\.[a-z]+|astro\.config\.[a-z]+|prisma\/schema\.prisma|Dockerfile|requirements\.txt|go\.mod)$/;

const FILE_PATH_IN_LOG = /(?:^|[\s"'(])((?:[\w.-]+\/)*[\w.-]+\.(?:[jt]sx?|mjs|cjs|css|prisma|json|py|go|rb|java))/g;

const SOURCE_EXT = /\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/;

/**
 * Files worth showing the model: those named in the error, all manifests/configs,
 * AND — crucially — SIBLING files that import the same module or use the same
 * symbol the error is about. A build aborts on the FIRST offending file, so the
 * log names only one; but the underlying mismatch (e.g. a wrong import name) is
 * usually shared by every file that imports that module. Including the siblings
 * lets the model fix them all in one pass instead of one redeploy per file.
 */
function relevantFiles(files: SourceFile[], sig: ErrorSignature, maxFiles = 20): SourceFile[] {
  const haystack = [sig.message, ...sig.context].join("\n");
  const named = new Set<string>();
  let m: RegExpExecArray | null;
  FILE_PATH_IN_LOG.lastIndex = 0;
  while ((m = FILE_PATH_IN_LOG.exec(haystack))) named.add(m[1]);

  // Module basenames the error mentions (services/api.js -> "api") and the
  // identifiers it quotes ("serviceRequestApi") — used to pull in the siblings.
  const moduleBases = new Set<string>();
  for (const n of named) moduleBases.add((n.split("/").pop() || n).replace(/\.\w+$/, ""));
  const symbols = new Set<string>();
  for (const q of haystack.match(/["'`]([A-Za-z_$][\w$]*)["'`]/g) || []) {
    const s = q.replace(/["'`]/g, "");
    if (s.length > 3) symbols.add(s);
  }

  const importsMentionedModule = (content: string): boolean => {
    const re = /(?:\bfrom|\bimport|\brequire\(|\bimport\()\s*['"]([^'"]+)['"]/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(content))) {
      const base = (mm[1].split("/").pop() || "").replace(/\.\w+$/, "");
      if (base && moduleBases.has(base)) return true;
    }
    return false;
  };

  const score = (f: SourceFile): number => {
    const base = f.path.split("/").pop() || f.path;
    if ([...named].some((n) => f.path === n || f.path.endsWith("/" + n) || n.endsWith("/" + base) || n === base)) return 3;
    if (CONFIG_FILE.test(f.path)) return 2;
    if (SOURCE_EXT.test(f.path)) {
      if (importsMentionedModule(f.content)) return 2;
      if ([...symbols].some((s) => f.content.includes(s))) return 1;
    }
    return 0;
  };
  return files
    .map((f) => [f, score(f)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFiles)
    .map(([f]) => ({ path: f.path, content: f.content.slice(0, 6000) }));
}

// --- 4. Escalating known-issue search ---------------------------------------

const FIX_INDICATORS = /\b(fix|fixed|resolve[d]?|solution|solved|workaround|downgrade|upgrade|add|install|missing|replace|pin)\b/i;

interface SearchFindings {
  queries: string[];
  results: WebResult[];
  pages: Array<{ url: string; text: string }>;
  answers: string[];
  sources: AutoFixSource[];
  found: boolean;
  depthReached: number;
}

/**
 * Search for the error, going deeper each level until a corroborated fix is
 * found or the depth budget is exhausted:
 *   depth 1 — the exact error message,
 *   depth 2 — error + the project's technologies, framed as a deploy/build issue,
 *   depth 3 — fetch and read the top result pages in full (the accepted answer).
 */
async function escalatingSearch(sig: ErrorSignature, technologies: string[], maxDepth: number): Promise<SearchFindings> {
  const queries: string[] = [];
  const results: WebResult[] = [];
  const answers: string[] = [];
  const seen = new Set<string>();
  const techHint = technologies.slice(0, 3).join(" ");
  let found = false;
  let depthReached = 0;

  const run = async (q: string) => {
    queries.push(q);
    const r = await searchWeb(q, 6);
    if (r.answer) answers.push(r.answer);
    for (const item of r.results) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
    }
  };

  for (let depth = 1; depth <= Math.max(1, maxDepth); depth++) {
    depthReached = depth;
    if (depth === 1) {
      await run(sig.message);
    } else if (depth === 2) {
      await run(`${sig.message} ${techHint} build error`);
      await run(`${sig.message} ${technologies[0] ?? ""} deployment fix`);
    } else {
      break; // depth 3 handled below via page fetches
    }
    // Enough signal to stop early: an answer box, or several results that talk
    // about fixing this specific error.
    const corroborated = results.filter((r) => FIX_INDICATORS.test(r.snippet)).length;
    if (answers.length > 0 && corroborated >= 1) { found = true; break; }
    if (corroborated >= 3) { found = true; break; }
  }

  // Depth 3: read the most promising pages in full so the fix comes from the
  // actual accepted answer / issue resolution, not just a snippet.
  const pages: Array<{ url: string; text: string }> = [];
  if (maxDepth >= 3 && !found) {
    depthReached = Math.max(depthReached, 3);
    const top = results.filter((r) => FIX_INDICATORS.test(r.snippet)).slice(0, 3);
    const picks = (top.length ? top : results.slice(0, 3));
    for (const r of picks) {
      const text = await fetchPageText(r.url, 4000);
      if (text) pages.push({ url: r.url, text });
    }
    if (pages.length) found = true;
  }

  const sources: AutoFixSource[] = [];
  const sourceSeen = new Set<string>();
  for (const r of results) {
    if (sourceSeen.has(r.url)) continue;
    sourceSeen.add(r.url);
    sources.push({ title: r.title, url: r.url });
    if (sources.length >= 6) break;
  }
  return { queries, results, pages, answers, sources, found, depthReached };
}

// --- 5. Grounded fix proposal ------------------------------------------------

// Targeted SEARCH/REPLACE edits rather than whole-file rewrites: the output
// stays tiny no matter how big the files are (so it never truncates on a small
// model output window), only the matched region changes (so the rest of the file
// can't be corrupted), and the same fix maps cleanly across many files.
const FixSchema = z.object({
  rootCause: z.string().describe("One sentence: the underlying cause of the build error."),
  explanation: z.string().describe("How the fix works and which finding/source it is based on."),
  confident: z.boolean().describe("True only if the findings clearly document this exact fix."),
  edits: z
    .array(
      z.object({
        path: z.string().describe("Project-relative file path to edit (or create)."),
        find: z
          .string()
          .describe("EXACT existing text to replace, copied verbatim incl. whitespace, with enough surrounding context to be unique in the file. Empty string ONLY when creating a brand-new file."),
        replace: z.string().describe("The replacement text (the full new file content when `find` is empty)."),
      }),
    )
    .describe("Minimal set of search/replace edits that make the build pass. Empty if no reliable fix is known."),
});

type FixEdit = z.infer<typeof FixSchema>["edits"][number];

const DEFAULT_FIX_MODEL = "anthropic/claude-sonnet-4.5";

/**
 * Apply the search/replace edits to the file set. An edit with an empty `find`
 * creates/overwrites a file with `replace`; otherwise the FIRST exact occurrence
 * of `find` is replaced. Edits whose anchor no longer matches, or that would
 * produce invalid JSON, are skipped — better to leave a file untouched than
 * corrupt it. Returns the new files and the paths actually changed.
 */
function applyEdits(files: SourceFile[], edits: FixEdit[]): { files: SourceFile[]; appliedPaths: string[] } {
  const byPath = new Map(files.map((f) => [f.path, { ...f }]));
  const applied = new Set<string>();
  for (const e of edits) {
    if (!e.find) {
      // Create or overwrite a whole file (e.g. a config the project was missing).
      if (!e.replace.trim()) continue;
      if (/\.json$/.test(e.path)) {
        try {
          JSON.parse(e.replace);
        } catch {
          continue;
        }
      }
      byPath.set(e.path, { path: e.path, content: e.replace });
      applied.add(e.path);
      continue;
    }
    const target = byPath.get(e.path);
    if (!target || !target.content.includes(e.find)) continue; // stale/ambiguous anchor → skip
    // Function replacer so `$&`/`$1` in the replacement are treated literally.
    const next = target.content.replace(e.find, () => e.replace);
    if (/\.json$/.test(e.path)) {
      try {
        JSON.parse(next);
      } catch {
        continue;
      }
    }
    target.content = next;
    applied.add(e.path);
  }
  return { files: [...byPath.values()], appliedPaths: [...applied] };
}

function findingsBlock(f: SearchFindings): string {
  const parts: string[] = [];
  if (f.answers.length) parts.push("ANSWER SUMMARIES:\n" + f.answers.map((a) => `- ${a}`).join("\n"));
  if (f.results.length)
    parts.push(
      "TOP RESULTS:\n" +
        f.results.slice(0, 8).map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`).join("\n"),
    );
  if (f.pages.length)
    parts.push("PAGE EXTRACTS (accepted answers / issue resolutions):\n" + f.pages.map((p) => `# ${p.url}\n${p.text}`).join("\n\n"));
  return parts.join("\n\n") || "(no web findings — rely on standard knowledge for this stack)";
}

/**
 * Run the full loop: detect tech → search (escalating to `1 + attempt` depth,
 * capped at maxDepth) → propose grounded edits → apply them. Never throws; on any
 * failure returns the input files unchanged with an explanatory report.
 */
export async function autoFixBuildError(input: {
  files: SourceFile[];
  errorLog: string;
  /** Increments each retry so successive attempts search deeper. */
  attempt?: number;
  maxDepth?: number;
  modelId?: string;
  apiKey?: string;
  /** Inject a specific model (any provider) instead of the OpenRouter default. */
  model?: LanguageModel;
}): Promise<AutoFixResult> {
  const { files, errorLog, attempt = 0, maxDepth = 3, modelId = DEFAULT_FIX_MODEL, apiKey, model } = input;
  const technologies = detectTechnologies(files);
  const sig = buildErrorSignature(errorLog);
  const depth = Math.min(maxDepth, 1 + attempt);

  const baseReport: AutoFixReport = {
    rootCause: "",
    explanation: "",
    technologies,
    queries: [],
    sources: [],
    editedPaths: [],
    confident: false,
    depthReached: 0,
  };

  let findings: SearchFindings | null = null;
  try {
    findings = await escalatingSearch(sig, technologies, depth);
    const context = relevantFiles(files, sig);

    const { object } = await generateObject({
      model: model ?? getModel(modelId, undefined, apiKey),
      schema: FixSchema,
      temperature: 0,
      // Whole-file edits for a handful of files — cap output so we never reserve
      // a model's full 64k budget (slow, and rejected on low-credit accounts).
      maxOutputTokens: 16000,
      system:
        "You are a senior build & deployment engineer. A generated app failed to build/deploy. " +
        "Using the REAL-WORLD SEARCH FINDINGS (known issues and their accepted fixes) plus the project files, " +
        "produce the MINIMAL set of SEARCH/REPLACE edits that make the build pass and the app production-ready. " +
        "Each edit has `path`, `find` (EXACT text from that file, copied verbatim with enough surrounding context to be " +
        "unique), and `replace`. To create a new file, use an empty `find` and put the whole file in `replace`. " +
        "Strongly prefer the documented fix from the findings over guessing. Keep edits surgical and idiomatic to the " +
        "stack; never rewrite whole files or touch unrelated code. A build aborts on the FIRST offending file, so the " +
        "error names only one — but the SAME root cause (e.g. a wrong import/export name) usually affects EVERY provided " +
        "file that shares it, so emit a separate edit for EACH such file in one pass. Keep any JSON (e.g. package.json) " +
        "valid. If the findings do not support a reliable fix, set confident=false and return your best-effort minimal " +
        "edits (or none if you truly cannot tell).",
      prompt:
        `TECHNOLOGIES: ${technologies.join(", ") || "unknown"}\n\n` +
        `BUILD ERROR:\n${[sig.message, ...sig.context].join("\n")}\n\n` +
        `SEARCH FINDINGS (depth ${findings.depthReached}, queries: ${findings.queries.map((q) => `"${q}"`).join(" | ")}):\n${findingsBlock(findings)}\n\n` +
        `RELEVANT PROJECT FILES:\n${context.map((f) => `===== ${f.path} =====\n${f.content}`).join("\n\n")}`,
    });

    const proposed = object.edits ?? [];
    const { files: out, appliedPaths } = applyEdits(files, proposed);
    const skipped = proposed.length - appliedPaths.length;

    if (appliedPaths.length === 0) {
      return {
        files,
        changed: false,
        report: {
          ...baseReport,
          rootCause: object.rootCause,
          explanation: object.explanation,
          confident: false,
          queries: findings.queries,
          sources: findings.sources,
          depthReached: findings.depthReached,
          note:
            proposed.length === 0
              ? "No reliable fix could be derived from the findings."
              : "Proposed edits did not match the current files (stale anchors) and were skipped.",
        },
      };
    }

    return {
      files: out,
      changed: true,
      report: {
        ...baseReport,
        rootCause: object.rootCause,
        explanation: object.explanation,
        confident: object.confident && findings.found,
        queries: findings.queries,
        sources: findings.sources,
        editedPaths: appliedPaths,
        depthReached: findings.depthReached,
        note: skipped > 0 ? `${skipped} proposed edit(s) didn't match and were skipped.` : undefined,
      },
    };
  } catch (e) {
    // Preserve any research already done so the failure is observable.
    return {
      files,
      changed: false,
      report: {
        ...baseReport,
        queries: findings?.queries ?? [],
        sources: findings?.sources ?? [],
        depthReached: findings?.depthReached ?? 0,
        note: `auto-fix failed: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
}
