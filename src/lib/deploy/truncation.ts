/**
 * Truncated-source detection + repair.
 *
 * The class of failure this targets: an LLM emits a source file whose output got
 * cut off, so the file ends mid-construct — `function` with nothing after it, an
 * unclosed `{`, a dangling `const x =`. The build then dies with an opaque parse
 * error (the real one this was written for:
 *   /vercel/path1/src/pages/Settings.jsx:42:8: ERROR: Expected identifier but found end of file
 *      40 |  }))
 *      41 |
 *      42 |  function
 * ). NONE of the existing build-resilience passes catch it: `stub-missing-imports`
 * only adds files that are *absent*, `strip-broken-files` only drops files that are
 * actually markup/XML, and the runtime-hardening rules are behaviour transforms on
 * code that already parses. A file that exists but is syntactically incomplete sails
 * straight through to the bundler and fails the deploy.
 *
 * This is a genuinely cross-cutting defect — codegen truncation can hit any
 * language — so detection is universal (`detectTruncatedSources`), while *repair*
 * is done only where it's provably safe: the JS/TS family, on the Vercel frontend
 * path. The repair philosophy mirrors harden.ts: best-effort, degrade-don't-crash.
 * We salvage the largest syntactically-complete prefix of the file and, if that
 * dropped a `default`/named export the rest of the app imports, re-emit a minimal
 * valid stub for it so importers still resolve and the build goes green. A page may
 * render empty; the deploy no longer fails.
 *
 * Safety is the whole game here: a false positive would replace a VALID file with a
 * stub and break working functionality. So every trigger is a hard truncation
 * signal (unbalanced delimiters at EOF, an unterminated string/comment, or a tail
 * token that simply cannot end a program), the scanner skips strings / template
 * literals / comments / regex so literal braces never miscount, and the
 * cross-stack regression harness asserts the pass is a no-op on a corpus of
 * known-good files for every stack (scripts/test-truncation.mts).
 */

export interface SrcFile {
  path: string;
  content: string;
}

const JS_FAMILY = /\.(jsx?|tsx?|mjs|cjs)$/;
/** Source extensions we can at least DETECT truncation in (brace-delimited langs). */
const BRACE_LANGS = /\.(jsx?|tsx?|mjs|cjs|java|cs|go|rs|cpp|cc|cxx|c|h|hpp|kt|kts|swift|scala|php|dart|ts)$/;

interface Analysis {
  /** An open bracket or an unterminated string/comment/template at EOF. */
  unbalanced: boolean;
  /** Last real token is one that cannot legally end a program (e.g. `function`, `=`). */
  danglingTail: boolean;
  /** Byte index just past the last top-level `}`/`;` — a safe place to cut. */
  safeCut: number;
  /** Net count of still-open `{ ( [` at EOF. */
  openDepth: number;
}

/** A `/` begins a regex (not division) when the preceding real token is one of these. */
function regexAllowedAfter(prev: string): boolean {
  return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev) || /[a-z]/.test(prev) === false;
}

/**
 * Single-pass scanner that tracks bracket depth while skipping over strings,
 * template literals (with `${}` re-entry), line/block comments and regex literals,
 * so braces inside those never affect the count. Returns the structural signals
 * used to decide truncation and where to safely cut.
 */
// Keywords that cannot be the last meaningful token of a complete program.
const DANGLING_KEYWORDS = new Set([
  "function", "const", "let", "var", "class", "return", "import", "export",
  "default", "async", "await", "new", "extends", "typeof", "instanceof", "case",
  "else", "do", "yield", "void", "delete", "of", "in", "from",
]);
// Trailing single-char operators/openers that demand a right-hand side. Excludes
// `<`/`>` (JSX), the closers `} ) ]`, and the terminators `; :` — all of which
// legally end a valid file. `=>` is handled separately (see prevSig) so JSX `>`
// stays safe.
const DANGLING_OP_CHARS = new Set([..."-=+*/%&|^~!?.,([{@"]);

function analyze(src: string): Analysis {
  const n = src.length;
  type Ctx = "code" | "sq" | "dq" | "tpl" | "line" | "block" | "regex";
  let ctx: Ctx = "code";
  const stack: string[] = [];          // open brackets, innermost last
  const tplExprAt: number[] = [];      // stack depth captured when each `${` opened
  let lastSig = "";                    // last significant code char
  let prevSig = "";                    // the one before that (to spot `=>`)
  let lastWord = "";                   // trailing identifier/keyword run
  let safeCut = 0;
  let i = 0;

  const sig = (ch: string) => { prevSig = lastSig; lastSig = ch; };
  const wordChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (ctx === "code") {
      if (c === "/" && c2 === "/") { ctx = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { ctx = "block"; i += 2; continue; }
      if (c === '"') { ctx = "dq"; sig('"'); lastWord = ""; i++; continue; }
      if (c === "'") { ctx = "sq"; sig("'"); lastWord = ""; i++; continue; }
      if (c === "`") { ctx = "tpl"; sig("`"); lastWord = ""; i++; continue; }
      if (c === "/" && regexAllowedAfter(lastSig)) { ctx = "regex"; lastWord = ""; i++; continue; }
      if (c === "(" || c === "[" || c === "{") { stack.push(c); sig(c); lastWord = ""; i++; continue; }
      if (c === ")" || c === "]" || c === "}") {
        if (c === "}" && tplExprAt.length && tplExprAt[tplExprAt.length - 1] === stack.length) {
          tplExprAt.pop(); stack.pop(); ctx = "tpl"; i++; continue; // close `${ }`, back to template
        }
        if (stack.length) stack.pop();
        sig(c); lastWord = ""; i++;
        if (stack.length === 0 && c === "}") safeCut = i; // closed a top-level block
        continue;
      }
      if (c === ";" && stack.length === 0) { sig(";"); lastWord = ""; i++; safeCut = i; continue; }
      if (!/\s/.test(c)) { sig(c); lastWord = wordChar(c) ? lastWord + c : ""; }
      i++;
      continue;
    }

    if (ctx === "line") { if (c === "\n") ctx = "code"; i++; continue; }
    if (ctx === "block") { if (c === "*" && c2 === "/") { ctx = "code"; i += 2; continue; } i++; continue; }
    if (ctx === "sq") { if (c === "\\") { i += 2; continue; } if (c === "'") ctx = "code"; i++; continue; }
    if (ctx === "dq") { if (c === "\\") { i += 2; continue; } if (c === '"') ctx = "code"; i++; continue; }
    if (ctx === "regex") { if (c === "\\") { i += 2; continue; } if (c === "\n" || c === "/") { ctx = "code"; sig("/"); } i++; continue; }
    // template literal text (only `\`, backtick and `${` are meaningful here)
    if (c === "\\") { i += 2; continue; }
    if (c === "`") { ctx = "code"; sig("`"); i++; continue; }
    if (c === "$" && c2 === "{") { stack.push("{"); tplExprAt.push(stack.length); ctx = "code"; i += 2; continue; }
    i++;
  }

  const danglingTail =
    DANGLING_KEYWORDS.has(lastWord) ||
    (lastSig === ">" ? prevSig === "=" /* `=>` */ : DANGLING_OP_CHARS.has(lastSig));

  return {
    unbalanced: stack.length > 0 || ctx !== "code",
    danglingTail,
    safeCut,
    openDepth: stack.length,
  };
}

/** Heuristic: does this file define/return JSX or import React? */
function looksLikeComponent(path: string, src: string): boolean {
  if (/\.(jsx|tsx)$/.test(path)) return true;
  if (/\bfrom\s+['"]react['"]/.test(src) || /\brequire\(\s*['"]react['"]\s*\)/.test(src)) return true;
  if (/<[A-Z][\w.]*[\s/>]/.test(src) || /<\/?[a-z][\w-]*[\s/>]/.test(src)) return true;
  return false;
}

interface Exports {
  hasDefault: boolean;
  defaultName: string | null;
  /** name -> declaration kind, so the stub is the right shape (callable vs value). */
  named: Map<string, "fn" | "value">;
}

/** Best-effort extraction of a (possibly broken) module's export surface. */
function extractExports(src: string): Exports {
  const named = new Map<string, "fn" | "value">();
  const hasDefault = /\bexport\s+default\b/.test(src);
  const dm =
    src.match(/\bexport\s+default\s+(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/) ||
    src.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/) ||
    src.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m);
  const defaultName = dm ? dm[1] : null;

  const declRe = /\bexport\s+(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) {
    named.set(m[2], /function|class/.test(m[1]) ? "fn" : "value");
  }
  // `export { a, b as c }` — re-exported names (treat as values; downstream import
  // reconciliation covers the call-shape ones).
  const listRe = /\bexport\s*\{([^}]*)\}/g;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") named.set(name, "value");
    }
  }
  return { hasDefault, defaultName, named };
}

/** Leading run of complete-looking `import` lines, preserved verbatim into the stub. */
function leadingImports(src: string): string {
  const lines = src.split("\n");
  const keep: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || t.startsWith("//")) { keep.push(line); continue; }
    if (/^import\b/.test(t) && /['"];?\s*$/.test(t)) { keep.push(line); continue; }
    break;
  }
  return keep.join("\n").replace(/\s+$/, "");
}

function defaultStub(isComponent: boolean, name: string | null): string {
  const fn = name && /^[A-Za-z_$][\w$]*$/.test(name) ? name : "RecoveredModule";
  return isComponent
    ? `export default function ${fn}() {\n  // Auto-recovered: original source was truncated by the generator.\n  return null;\n}`
    : `const ${fn} = {};\nexport default ${fn};`;
}

function namedStub(name: string, kind: "fn" | "value", isComponent: boolean): string {
  if (kind === "fn") return isComponent ? `export function ${name}() { return null; }` : `export function ${name}() {}`;
  return `export const ${name} = undefined;`;
}

/**
 * Repair a single truncated JS/TS file. Returns the repaired content, or null when
 * the file is NOT truncated (caller leaves it untouched). Idempotent: a file this
 * already produced is balanced and non-dangling, so it re-analyzes as healthy.
 */
export function repairTruncatedJs(path: string, content: string): string | null {
  if (!JS_FAMILY.test(path)) return null;
  const a = analyze(content);
  if (!a.unbalanced && !a.danglingTail) return null; // healthy — do not touch

  const isComponent = looksLikeComponent(path, content);
  const exp = extractExports(content);

  // Salvage the largest complete prefix (drops only the truncated tail).
  let base = content.slice(0, a.safeCut).replace(/\s+$/, "");
  if (base && analyze(base).unbalanced) base = ""; // prefix itself wasn't clean — discard
  if (!base) base = leadingImports(content);

  const baseExports = extractExports(base);
  const additions: string[] = [];

  if (exp.hasDefault && !baseExports.hasDefault) {
    additions.push(defaultStub(isComponent, exp.defaultName));
  }
  for (const [name, kind] of exp.named) {
    if (!baseExports.named.has(name)) additions.push(namedStub(name, kind, isComponent));
  }
  // Nothing salvageable and nothing exported → an empty but valid module.
  if (!base && additions.length === 0) additions.push("export {};");

  const banner = "// [deploy-engine] repaired truncated source (generator output was cut off).";
  return [banner, base, ...additions].filter(Boolean).join("\n\n") + "\n";
}

export interface TruncationResult {
  files: SrcFile[];
  /** Paths that were repaired (for the deploy log + learning signal). */
  repaired: string[];
}

/** Repair every truncated JS/TS file in the set (the Vercel-path transform). */
export function repairTruncatedSource(files: SrcFile[]): TruncationResult {
  const repaired: string[] = [];
  const out = files.map((f) => {
    const fixed = repairTruncatedJs(f.path, f.content);
    if (fixed === null || fixed === f.content) return f;
    repaired.push(f.path);
    return { ...f, content: fixed };
  });
  return { files: out, repaired };
}

/**
 * Universal (read-only) detector: which source files look truncated, in ANY
 * brace-delimited language. Used on the backend/container path to surface the
 * defect as a loud deploy note and feed the learning signal — we DON'T auto-stub
 * backend code (a half-written controller/entity can't be safely synthesized).
 */
export function detectTruncatedSources(files: SrcFile[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (!BRACE_LANGS.test(f.path)) continue;
    const a = analyze(f.content);
    if (a.unbalanced || a.danglingTail) hits.push(f.path);
  }
  return hits;
}
