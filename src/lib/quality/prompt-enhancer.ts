import { matchLibrary, composeDirectives, intentKey } from "./prompt-library";
import { searchWeb } from "@/lib/ai/web-search";

/**
 * Web-grounded prompt enhancer (library-first, cached search-on-miss).
 *
 * Turns a vague user prompt into a detailed, high-quality instruction block:
 *   1. match the curated prompt library (prompt-library.ts) — instant + free,
 *   2. only when NO known intent matches, research the web (searchWeb) and distill
 *      the results into a few extra directives,
 *   3. cache the research by intent so repeat/similar prompts are instant.
 *
 * FAIL-OPEN: web search is wrapped in try/catch and behind an injectable interface,
 * so with no search key (or a network error) the enhancer still returns the
 * library directives. It never throws and never blocks on the network longer than
 * the caller allows. The returned block is appended to the model's instructions by
 * the caller (chat preprocess / pre-deploy modify step) — this module does not call
 * the LLM itself.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
export type SearchFn = (query: string, maxResults: number) => Promise<SearchResult[]>;

/** Distilled web research, cached by intent key (process-lifetime, fail-open). */
const researchCache = new Map<string, string[]>();

const defaultSearch: SearchFn = async (query, maxResults) => {
  const { results } = await searchWeb(query, maxResults);
  return results;
};

export interface EnhanceOptions {
  /** Allow a web lookup on an intent miss (default true). */
  useSearch?: boolean;
  /** Injectable search (defaults to searchWeb) — for tests/offline. */
  search?: SearchFn;
  maxResults?: number;
  /** Hard cap on the web lookup; on timeout we fall back to library-only (default 6000ms). */
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("enhance-search-timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface EnhanceResult {
  /** The directive block to append to the model prompt (may be ""). */
  enhanced: string;
  /** A known app intent matched the library (no search needed). */
  matchedIntent: boolean;
  /** A web lookup was performed this call. */
  usedSearch: boolean;
  /** Research came from the cache (no network this call). */
  fromCache: boolean;
  /** Source URLs, when research was used. */
  sources: string[];
}

/** Extract a few actionable "best-practice" directives from search snippets. */
function distill(results: SearchResult[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const ACTIONABLE = /\b(should|must|use|implement|avoid|ensure|always|never|include|require|support|validate|handle|optimi[sz]e|secure|cache|paginate)\b/i;
  for (const r of results) {
    const text = `${r.title}. ${r.snippet ?? ""}`;
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim().replace(/\s+/g, " ");
      if (s.length < 25 || s.length > 200 || !ACTIONABLE.test(s)) continue;
      const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

/**
 * Enhance a user prompt with high-quality build directives. Library-first; web
 * research only on an intent miss, cached by intent.
 */
export async function enhancePrompt(raw: string, opts: EnhanceOptions = {}): Promise<EnhanceResult> {
  const prompt = (raw || "").trim();
  const m = matchLibrary(prompt);

  // Library-first: a known intent (or search disabled / empty prompt) → no network.
  if (m.matchedIntent || opts.useSearch === false || !prompt) {
    return { enhanced: composeDirectives(m), matchedIntent: m.matchedIntent, usedSearch: false, fromCache: false, sources: [] };
  }

  // Intent miss → use cached research if we have it.
  const key = intentKey(prompt);
  const cached = researchCache.get(key);
  if (cached) {
    return { enhanced: composeDirectives(m, cached), matchedIntent: false, usedSearch: false, fromCache: true, sources: [] };
  }

  // Otherwise research the web (fail-open) and cache the distilled directives.
  const search = opts.search ?? defaultSearch;
  let extras: string[] = [];
  let sources: string[] = [];
  try {
    const results = await withTimeout(search(`required features and best practices to build: ${prompt}`, opts.maxResults ?? 5), opts.timeoutMs ?? 6000);
    extras = distill(results);
    sources = results.map((r) => r.url).filter(Boolean).slice(0, 5);
    if (extras.length) researchCache.set(key, extras);
  } catch {
    /* fail-open: library-only */
  }
  return { enhanced: composeDirectives(m, extras), matchedIntent: false, usedSearch: true, fromCache: false, sources };
}

/**
 * Warm the research cache for a prompt's intent WITHOUT blocking the caller — the
 * "research in the background, apply next turn" path. Returns immediately.
 */
export function prefetchResearch(raw: string, opts: EnhanceOptions = {}): void {
  const prompt = (raw || "").trim();
  if (!prompt || matchLibrary(prompt).matchedIntent) return;
  if (researchCache.has(intentKey(prompt))) return;
  void enhancePrompt(prompt, opts).catch(() => {});
}

/** Test/maintenance helper. */
export function _clearResearchCache(): void {
  researchCache.clear();
}
