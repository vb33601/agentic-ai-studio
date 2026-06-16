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
 * file is mid-write. Combines truncated files with a whole MISSING COMPONENT check
 * (the request asked for a backend/frontend but none exists) so a cut that stopped
 * before a component was built still triggers a resume. Stack-agnostic.
 */
export function findAppGaps(files: SimpleFile[], requestText: string): string[] {
  const gaps: string[] = [];
  const truncated = findIncompleteFiles(files);
  if (truncated.length) gaps.push(`truncated/cut-off files (re-output complete): ${truncated.join(", ")}`);

  const req = (requestText || "").toLowerCase();
  const paths = files.map((f) => f.path.toLowerCase());
  const hasP = (re: RegExp) => paths.some((p) => re.test(p));
  const hasC = (re: RegExp) => files.some((f) => re.test(f.content || ""));

  const wantsBackend = /\b(back-?end|api|server|endpoints?|rest|spring|django|\.net|asp\.?net|express|fastapi|flask|rails|laravel|nest|gin)\b/.test(req);
  const wantsFrontend = /\b(front-?end|react|vue|svelte|angular|\bui\b|client|web ?app|web ?page|\bpage\b|vite|next\.?js|tailwind)\b/.test(req);

  const hasFrontend =
    hasP(/\/frontend\/|\/client\/|\.(jsx|tsx|vue|svelte)$/) ||
    (hasP(/(^|\/)index\.html$/) && hasC(/<script[^>]+type=["']module["']/i));
  const hasBackend =
    hasP(/\/backend\/|\/server\/|(^|\/)(program\.cs|manage\.py|main\.go|app\.py|server\.[jt]s)$|\.csproj$|(^|\/)pom\.xml$|application\.(properties|yml|yaml)$|(^|\/)requirements\.txt$/) ||
    hasP(/controller|(^|\/)routes?\//) ||
    hasC(/@(RestController|RequestMapping)|app\.(get|post|put|delete)\(|@app\.route|ApiController|express\(\)/);

  if (wantsBackend && !hasBackend) gaps.push("the requested BACKEND/API is missing — build it");
  if (wantsFrontend && !hasFrontend) gaps.push("the requested FRONTEND is missing — build it");
  return gaps;
}
