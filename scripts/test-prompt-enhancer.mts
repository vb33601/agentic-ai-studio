/**
 * Prompt library + web-grounded enhancer (library-first, cached search-on-miss).
 *
 *   npx tsx scripts/test-prompt-enhancer.mts
 *
 * Search is injected (offline) so the test is deterministic and never hits the net.
 */
import { matchLibrary, composeDirectives, intentKey } from "../src/lib/quality/prompt-library";
import { enhancePrompt, _clearResearchCache, type SearchFn } from "../src/lib/quality/prompt-enhancer";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// --- Library matching ---
const m = matchLibrary("build a login and signup app with user accounts");
check("matches the auth intent", m.matchedIntent && m.intents.some((e) => e.id === "intent-auth"));
check("always includes quality dimensions", m.quality.some((e) => e.id === "quality-security") && m.quality.some((e) => e.id === "quality-ui-ux"));
check("composed directives include security + UI/UX", /Security:/.test(composeDirectives(m)) && /UI\/UX:/.test(composeDirectives(m)));
check("unknown intent → no intent match", !matchLibrary("a thing that does stuff").matchedIntent);

// --- Enhancer: library-first (no network on a known intent) ---
let searchCalls = 0;
const fakeSearch: SearchFn = async () => {
  searchCalls++;
  return [
    { title: "Best practices", url: "https://ex.com/a", snippet: "You should validate all inputs. Implement rate limiting to avoid abuse." },
    { title: "Guide", url: "https://ex.com/b", snippet: "Always paginate large lists. Use indexes on filtered columns." },
  ];
};

_clearResearchCache();
const r1 = await enhancePrompt("create a CRUD todo app", { search: fakeSearch });
check("known intent does NOT call search", r1.matchedIntent && !r1.usedSearch && searchCalls === 0);
check("known intent enhancement is non-empty", r1.enhanced.length > 0 && /CRUD/.test(r1.enhanced));

// --- Enhancer: intent miss → web research (injected), distilled + cached ---
_clearResearchCache();
searchCalls = 0;
const novel = "build a midi sequencer for modular synthesizers";
const r2 = await enhancePrompt(novel, { search: fakeSearch });
check("intent miss calls search once", r2.usedSearch && searchCalls === 1);
check("research is distilled into directives", /validate all inputs|paginate large lists/i.test(r2.enhanced));
check("sources are returned", r2.sources.length > 0 && r2.sources[0].startsWith("https://"));
check("quality dimensions still present on a miss", /Security:/.test(r2.enhanced));

const r3 = await enhancePrompt(novel, { search: fakeSearch });
check("second identical prompt hits the cache (no 2nd search)", r3.fromCache && !r3.usedSearch && searchCalls === 1);

// --- useSearch:false on a miss → library-only, no network ---
_clearResearchCache();
searchCalls = 0;
const r4 = await enhancePrompt("an esoteric thing", { search: fakeSearch, useSearch: false });
check("useSearch:false skips the network", !r4.usedSearch && searchCalls === 0 && /UI\/UX:/.test(r4.enhanced));

// --- Fail-open: a throwing search still returns library directives ---
_clearResearchCache();
const boom: SearchFn = async () => { throw new Error("network down"); };
const r5 = await enhancePrompt("some novel app idea", { search: boom });
check("search failure is fail-open (still returns quality directives)", r5.enhanced.length > 0 && /Security:/.test(r5.enhanced));

// --- intentKey is stable for the same intent ---
check("intentKey stable across auth phrasings", intentKey("a login page") === intentKey("user sign in and registration") );

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL PROMPT-ENHANCER TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
