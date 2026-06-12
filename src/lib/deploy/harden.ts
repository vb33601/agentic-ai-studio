import type { SourceFile } from "@/lib/ai/deps";

/**
 * Runtime-hardening engine.
 *
 * The existing deploy pipeline (`prepareForDeploy`, `render-prepare`,
 * `universal-prepare`, the Dockerfile engine) makes generated apps *build* across
 * many technologies. This engine targets the next layer: RUNTIME crashes — the
 * errors that survive a green build and only blow up once the app is live (e.g.
 * "Cannot destructure property 'token' of res.data as it is undefined", or a
 * ".map of undefined" when an API call returns nothing). Those can't be caught at
 * build time, so we neutralize the common crash CLASSES with static source
 * transforms before the app ships.
 *
 * Design principles (every rule must satisfy them — that's what makes the engine
 * safe to run on ALL generated code, in any stack):
 *  - **Behavior-preserving:** a rule may only change behavior in the precise case
 *    that would otherwise throw. `x ?? {}` is a no-op unless `x` is null/undefined
 *    (it does NOT trigger on 0/""/false), so valid responses are never altered.
 *  - **Idempotent:** re-running the engine is a fixed point — an already-hardened
 *    expression no longer matches its rule.
 *  - **Conservative:** when a construct is ambiguous (nested destructure, a
 *    ternary RHS, a call result), the rule SKIPS it rather than risk a wrong
 *    rewrite. Missing a crash is acceptable; corrupting valid code is not.
 *
 * This is best-effort defense-in-depth, not a guarantee of zero errors. It pairs
 * with the build-time repairs upstream and the AI auto-fix / post-deploy health
 * gate downstream — anything static rules can't safely fix is left for those.
 *
 * The registry is technology-tagged and additive: new rules (more frameworks,
 * backend languages) slot in without touching callers. See [[feedback-envlocal-quoted-values]].
 */

export interface HardenRule {
  id: string;
  description: string;
  /** Which files this rule may touch (by path). */
  test: (path: string) => boolean;
  /** Transform a file's content. Must be a fixed point when re-applied. */
  apply: (content: string) => string;
}

/** JS/TS family, including single-file component formats that embed a script. */
const JS_FAMILY = /\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/;

/**
 * An RHS we're willing to guard: a plain member-access / index / call chain off a
 * single identifier, optionally `await`ed — e.g. `res.data`, `r.body.user`,
 * `store.state["x"]`, `await api.get(url)`. Deliberately excludes anything with a
 * `{`, `?`, `|`, `&` or comma (object/array literals, ternaries, already-guarded
 * or compound expressions) so we never wrap an expression where `?? {}` would
 * change precedence or meaning.
 */
const GUARDABLE_RHS =
  /^(await\s+)?[A-Za-z_$][\w$]*(?:\?\.[A-Za-z_$][\w$]*|\.[A-Za-z_$][\w$]*|\[[^\]\n]*\]|\([^()\n]*\))*$/;

/** True when the RHS actually reaches into something (a `.`/`[]`/`await`) — i.e.
 *  it can plausibly be null/undefined. Bare `foo()` or `bar` are left alone. */
function isRiskyRhs(rhs: string): boolean {
  if (!GUARDABLE_RHS.test(rhs)) return false;
  return /^await\s/.test(rhs) || /[.[]/.test(rhs);
}

// `const|let|var { … } = <rhs>` / `const|let|var [ … ] = <rhs>`, single line.
// `[^{}]*` (object) and `[^[\]]*` (array) forbid NESTED destructuring patterns,
// which we intentionally skip. The RHS runs to the statement end (`;`/newline).
const OBJ_DESTRUCTURE = /\b(const|let|var)\s+(\{[^{}]*\})\s*=\s*([^;\n]+?)\s*(?=;|\n|$)/g;
const ARR_DESTRUCTURE = /\b(const|let|var)\s+(\[[^[\]]*\])\s*=\s*([^;\n]+?)\s*(?=;|\n|$)/g;

/**
 * Guard destructuring whose right-hand side can be null/undefined. The flagship
 * crash class: `const { token } = res.data` throws when `res.data` is undefined
 * (an empty/failed API response). `res.data ?? {}` makes the field read as
 * `undefined` instead of crashing the whole render. Arrays get `?? []`.
 */
function guardDestructure(content: string): string {
  let out = content.replace(OBJ_DESTRUCTURE, (full, kw, pat, rhs) =>
    isRiskyRhs(rhs.trim()) ? `${kw} ${pat} = (${rhs.trim()}) ?? {}` : full,
  );
  out = out.replace(ARR_DESTRUCTURE, (full, kw, pat, rhs) =>
    isRiskyRhs(rhs.trim()) ? `${kw} ${pat} = (${rhs.trim()}) ?? []` : full,
  );
  return out;
}

// A member chain off an identifier (`a.b`, `state.items`, `r.data.users`) — at
// least one `.` — immediately followed by an array-iteration method. Requiring a
// member chain (not a bare identifier or a call) keeps us off `[1,2].map`,
// `Object.keys(x).map`, lodash `_.map`, etc., and targets the API-data shape that
// actually arrives undefined.
const ARRAY_ITER =
  /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\.(map|filter|forEach|reduce|reduceRight|some|every|find|findIndex|flatMap|sort)\(/g;

/**
 * Guard array iteration over a member chain that can be undefined:
 * `data.users.map(…)` → `(data.users ?? []).map(…)`. No-op for real arrays;
 * turns "Cannot read properties of undefined (reading 'map')" into an empty list.
 */
function guardArrayIteration(content: string): string {
  return content.replace(ARRAY_ITER, (_full, chain, method) => `(${chain} ?? []).${method}(`);
}

// A success-path `return [await] <ident>.json()` inside a fetch wrapper (the api
// client). Anchored to end-of-statement so it doesn't match `…json().catch()` or
// `…json().then()`.
const JSON_RETURN = /\breturn\s+(?:await\s+)?([A-Za-z_$][\w$]*)\.json\(\)\s*(?=;|\n|$)/g;

const ENSURE_DATA_HELPER = `function __ensureData(__b) {
  // A fetch client returns the parsed body, but generated consumers very often
  // read it axios-style as \`response.data.x\`. Expose the body ALSO as a
  // non-enumerable \`.data\` (so spreads/JSON.stringify ignore it) when it isn't
  // already there — making both \`res.x\` and \`res.data.x\` resolve. Skips arrays
  // and bodies that already carry a \`data\` field.
  if (__b && typeof __b === "object" && !Array.isArray(__b) && !("data" in __b)) {
    try { Object.defineProperty(__b, "data", { value: { ...__b }, enumerable: false, configurable: true }); } catch (__e) {}
  }
  return __b;
}
`;

/**
 * Reconcile the #1 generated full-stack bug: a fetch-based API client that does
 * `return response.json()` (returns the raw body), consumed by code that reads it
 * axios-style — `const { token } = response.data` / `response.data.user`. `.data`
 * is then always undefined, so login silently stores nothing and the app never
 * authenticates (or, before the destructure guard, hard-crashed). We make the
 * client's return value ALSO readable as `.data` via a non-enumerable self-copy,
 * so BOTH conventions work without touching any consumer. Only fires in files
 * that look like an api client (contain `fetch(`), and is idempotent.
 */
function apiResponseDataCompat(content: string): string {
  if (!/\bfetch\s*\(/.test(content)) return content;
  if (content.includes("__ensureData")) return content;
  if (!JSON_RETURN.test(content)) return content;
  JSON_RETURN.lastIndex = 0;
  // `.then(__ensureData)` (not `await`) so it works whether or not the wrapper is
  // declared `async` — it just returns a promise resolving to the (augmented) body.
  const out = content.replace(JSON_RETURN, (_m, id: string) => `return ${id}.json().then(__ensureData)`);
  if (out === content) return content;
  // Inject the helper just after the file's import block (or at the very top).
  const importRe = /^\s*import\b[^\n]*$/gm;
  let end = 0;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(out))) end = m.index + m[0].length;
  return end > 0 ? `${out.slice(0, end)}\n\n${ENSURE_DATA_HELPER}${out.slice(end)}` : `${ENSURE_DATA_HELPER}\n${out}`;
}

export const HARDEN_RULES: HardenRule[] = [
  {
    id: "api-response-data-compat",
    description: "Make a fetch API client's parsed body also readable as `.data` so axios-style `response.data.x` consumers work (the silent-login bug).",
    test: (p) => /\.(jsx?|tsx?|mjs|cjs)$/.test(p),
    apply: apiResponseDataCompat,
  },
  {
    id: "safe-destructure",
    description: "Default object/array destructuring of a nullable RHS to {} / [] so a failed API response can't crash the render.",
    test: (p) => JS_FAMILY.test(p),
    apply: guardDestructure,
  },
  {
    id: "safe-array-iteration",
    description: "Default `obj.list.map(...)` (and filter/forEach/…) over a nullable member chain to an empty array.",
    test: (p) => JS_FAMILY.test(p),
    apply: guardArrayIteration,
  },
];

export interface HardenResult {
  files: SourceFile[];
  /** Rule ids that changed at least one file (for surfacing in the deploy log). */
  applied: string[];
}

/**
 * Run every applicable hardening rule over the file set. Pure; returns the new
 * files plus which rules actually fired.
 */
export function hardenFiles(files: SourceFile[], rules: HardenRule[] = HARDEN_RULES): HardenResult {
  const applied = new Set<string>();
  const out = files.map((f) => {
    let content = f.content;
    for (const rule of rules) {
      if (!rule.test(f.path)) continue;
      const next = rule.apply(content);
      if (next !== content) {
        applied.add(rule.id);
        content = next;
      }
    }
    return content === f.content ? f : { ...f, content };
  });
  return { files: out, applied: [...applied] };
}
