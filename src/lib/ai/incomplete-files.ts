/**
 * Lightweight, dependency-free detection of files a generation left CUT OFF
 * mid-content — safe to run in the browser (no `ai`/zod imports). Used by the
 * client to auto-detect when a streaming generation stopped mid-file (e.g. the
 * upstream free model dropped the stream while writing ClaimsList.jsx) and resume.
 *
 * High-precision signals only, so we don't re-request files that are actually fine:
 *  - JSON that no longer parses,
 *  - an odd number of ``` fences,
 *  - a brace-language file that is unbalanced AND ends mid-token (not on a closing
 *    char), or
 *  - an `import { … }` opened but never closed / never reaching `from` (the exact
 *    "Expected `from` but found EOF" build failure).
 */
// Kept in sync with prompt-pipeline.ts. Class 1: brace-balanced languages.
const BRACE_LANG = /\.(jsx?|tsx?|mjs|cjs|cs|java|go|rs|c|cc|cpp|cxx|cu|cuh|h|hh|hpp|hxx|m|mm|php|kt|kts|swift|scala|sc|dart|groovy|gvy|gradle|d|zig|vala|sol|proto|tf|hcl|ino|pde|css|scss|less|pcss|json|json5|jsonc)$/i;
// Class 2: non-brace / statement-based languages — "ends mid-statement".
const STATEMENT_LANG = /\.(py|pyw|rb|rake|lua|ex|exs|erl|pl|pm|r|jl|sh|bash|zsh|fish|ps1|hs|ml|mli|clj|cljs|cljc|edn|rkt|scm|lisp|el|coffee|elm|nim|cr|fs|fsx|sql|vb|tcl|awk)$/i;

function looksTruncatedIndent(content: string): boolean {
  const c = content || "";
  const opens = (c.match(/[([]/g) || []).length;
  const closes = (c.match(/[)\]]/g) || []).length;
  if (opens - closes >= 1) return true;
  const lines = c.replace(/\r/g, "").split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t && !t.startsWith("#") && !t.startsWith("//") && !t.startsWith("--")) { last = t; break; }
  }
  return /[,\\([{:]$/.test(last);
}

export interface SimpleFile {
  path: string;
  content: string;
}

/** Normalize a relative reference against a base directory (handles ./ and ../). */
function joinRel(dir: string, rel: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Browser-safe port of the server's `detectMissingLocalRefs` (prompt-pipeline.ts):
 * a file imports/requires a LOCAL sibling that no generated file provides. This is
 * the highest-precision signal that "a whole file was skipped" — a dangling local
 * reference can't be a false positive (the importer literally needs that file). We
 * cover the same JS/TS import resolution as `detectArtifactFlags` plus Python,
 * C/C++, Ruby and Rust relative refs. External libraries are never checked.
 */
export function findBrokenLocalRefs(files: SimpleFile[]): string[] {
  const paths = new Set(files.map((f) => f.path));
  const has = (p: string) => paths.has(p);
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const out: string[] = [];
  const seen = new Set<string>();
  const flag = (importer: string, ref: string, target: string) => {
    const key = importer + "|" + ref;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(`\`${ref}\` is referenced by \`${importer}\` but \`${target}\` was never created — create that file (or fix the reference).`);
  };

  // JS/TS — resolve relative import/require/export-from with the usual extension
  // candidates (matches detectArtifactFlags' resolution table).
  const jsSuffixes = ["", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".mjs", ".cjs", "/index.js", "/index.jsx", "/index.ts", "/index.tsx"];
  for (const f of files) {
    const c = f.content || "";
    const dir = dirOf(f.path);

    if (/\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/i.test(f.path)) {
      const re = /(?:from\s*|import\s*|require\(\s*)['"](\.[^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(c))) {
        const target = joinRel(dir, m[1]);
        if (jsSuffixes.some((s) => has(target + s)) || seen.has(target)) continue;
        flag(f.path, m[1], target);
      }
    }

    if (/\.py$/i.test(f.path)) {
      for (const m of c.matchAll(/^[ \t]*from\s+(\.+)([\w.]*)\s+import\b/gm)) {
        let base = dir;
        for (let i = 1; i < m[1].length; i++) base = dirOf(base);
        const mod = m[2].replace(/\./g, "/");
        const cands = mod ? [`${joinRel(base, mod)}.py`, `${joinRel(base, mod)}/__init__.py`] : [`${base}/__init__.py`];
        if (!cands.some(has)) flag(f.path, m[0].trim(), cands[0]);
      }
    }

    if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(f.path)) {
      for (const m of c.matchAll(/^[ \t]*#\s*include\s+"([^"]+)"/gm)) {
        const target = joinRel(dir, m[1]);
        if (!has(target) && ![...paths].some((p) => p.endsWith("/" + m[1]) || p === m[1])) flag(f.path, `#include "${m[1]}"`, target);
      }
    }

    if (/\.rb$/i.test(f.path)) {
      for (const m of c.matchAll(/\brequire_relative\s+['"]([^'"]+)['"]/g)) {
        const rel = m[1].endsWith(".rb") ? m[1] : `${m[1]}.rb`;
        if (!has(joinRel(dir, rel))) flag(f.path, `require_relative '${m[1]}'`, joinRel(dir, rel));
      }
    }

    if (/\.rs$/i.test(f.path)) {
      for (const m of c.matchAll(/^[ \t]*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
        if (!has(joinRel(dir, `${m[1]}.rs`)) && !has(joinRel(dir, `${m[1]}/mod.rs`))) flag(f.path, `mod ${m[1]};`, joinRel(dir, `${m[1]}.rs`));
      }
    }
  }
  return out.slice(0, 8);
}

function looksTruncated(path: string, content: string): boolean {
  const c = content || "";
  if (!c.trim()) return false; // empty handled elsewhere
  if (((c.match(/```/g) || []).length) % 2 === 1) return true;
  if (/\.json$/i.test(path)) {
    try { JSON.parse(c); return false; } catch { return true; }
  }
  if (BRACE_LANG.test(path)) {
    const opens = (c.match(/[{[(]/g) || []).length;
    const closes = (c.match(/[}\])]/g) || []).length;
    const tail = c.trimEnd().slice(-1);
    // Unbalanced AND not ending on a real closing token => cut off mid-content.
    // NOTE: `>` is deliberately NOT a "complete" ending — a file truncated mid
    // arrow function ends in `=>`, and a genuinely complete JSX/HTML file ending
    // in `>` is already brace-balanced (so the imbalance check won't fire on it).
    if (opens - closes >= 1 && !/[}\]);]/.test(tail)) return true;
  }
  if (STATEMENT_LANG.test(path)) {
    return looksTruncatedIndent(c);
  }
  // A JS/TS import that opened a brace but never closed it before EOF.
  if (/\.(jsx?|tsx?|mjs|cjs)$/i.test(path)) {
    const m = c.match(/(?:^|\n)\s*import\s+[^;\n]*\{[^}]*$/);
    if (m && !/\bfrom\b/.test(m[0])) return true;
  }
  return false;
}

/** Paths of files that appear truncated/cut off. */
export function findIncompleteFiles(files: SimpleFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (looksTruncated(f.path, f.content)) out.add(f.path);
  }
  return [...out];
}

/**
 * Human-readable gaps that mean "this build isn't finished" — used by the client
 * auto-resume so it fires in ALL scenarios (any model, any stack), not just when a
 * file is mid-write.
 *
 * Three independent, stack-agnostic signals (any one keeps the resume loop going):
 *  1. TRUNCATED files — cut off mid-content.
 *  2. BROKEN local references — a file imports a sibling that was never created
 *     (the precise "a whole file got skipped" signal — high precision, no keywords).
 *  3. A half-built FULL-STACK app — the build clearly has one side (frontend OR
 *     backend) and STRUCTURAL evidence it should have the other (the present side
 *     calls an API that no server provides, or a server is CORS-wired to a frontend
 *     that doesn't exist). Inferred from the FILES, never from request keywords —
 *     a prompt like "insurance claims management system" names no stack yet still
 *     needs both halves.
 *
 * `requestText` is now advisory only (kept for signature compatibility): it can add
 * an explicit backend/frontend expectation but is never REQUIRED to raise a gap.
 */
export function findAppGaps(files: SimpleFile[], requestText = ""): string[] {
  const gaps: string[] = [];
  const truncated = findIncompleteFiles(files);
  if (truncated.length) gaps.push(`truncated/cut-off files (re-output complete): ${truncated.join(", ")}`);

  for (const ref of findBrokenLocalRefs(files)) gaps.push(ref);

  const req = (requestText || "").toLowerCase();
  const paths = files.map((f) => f.path.toLowerCase());
  const hasP = (re: RegExp) => paths.some((p) => re.test(p));
  const hasC = (re: RegExp) => files.some((f) => re.test(f.content || ""));

  const hasFrontend =
    hasP(/\/frontend\/|\/client\/|\.(jsx|tsx|vue|svelte)$/) ||
    (hasP(/(^|\/)index\.html$/) && hasC(/<script[^>]+type=["']module["']/i));
  const hasBackend =
    hasP(/\/backend\/|\/server\/|(^|\/)(program\.cs|manage\.py|main\.go|app\.py|server\.[jt]s)$|\.csproj$|(^|\/)pom\.xml$|application\.(properties|yml|yaml)$|(^|\/)requirements\.txt$/) ||
    hasP(/controller|(^|\/)routes?\//) ||
    hasC(/@(RestController|RequestMapping)|app\.(get|post|put|delete)\(|@app\.route|ApiController|express\(\)/);

  // STRUCTURAL "should have a backend" — the frontend actively talks to an API but
  // no server exists to answer it. Covers fetch('/api/…'), axios baseURL, and the
  // env vars our own deploy wiring reads (VITE_API_URL / REACT_APP_API_URL).
  const frontendCallsApi = hasC(
    /fetch\(\s*[`'"][^`'"]*\/api\//i,
  ) || hasC(/\b(?:axios|VITE_API_URL|VITE_BACKEND_URL|REACT_APP_API_URL|NEXT_PUBLIC_API_URL|API_BASE_URL|baseURL)\b/);
  // STRUCTURAL "should have a frontend" — a backend configured CORS / a frontend
  // URL for a client app that isn't in the file set.
  const backendExpectsFrontend = hasC(/\b(?:CORS_ORIGIN|FRONTEND_URL|cors\(|app\.use\(\s*cors|Access-Control-Allow-Origin)\b/i);

  // Request keywords are advisory — they can ADD an expectation, never gate one out.
  const reqWantsBackend = /\b(back-?end|api|server|endpoints?|rest|spring|django|\.net|asp\.?net|express|fastapi|flask|rails|laravel|nest|gin)\b/.test(req);
  const reqWantsFrontend = /\b(front-?end|react|vue|svelte|angular|\bui\b|client|web ?app|web ?page|\bpage\b|vite|next\.?js|tailwind)\b/.test(req);

  if (!hasBackend && (frontendCallsApi || (reqWantsBackend && hasFrontend)))
    gaps.push("the BACKEND/API is missing — the frontend calls an API but no server exists. Build the backend (entry that starts the server, the REST routes the frontend calls, wired to run).");
  if (!hasFrontend && (backendExpectsFrontend || (reqWantsFrontend && hasBackend)))
    gaps.push("the FRONTEND is missing — a backend exists but no UI does. Build the frontend (entry, root App, pages/components, and the API client that calls the backend).");
  return gaps;
}
