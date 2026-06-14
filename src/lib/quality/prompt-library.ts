/**
 * The high-quality prompt directory.
 *
 * A curated library of reusable, battle-tested instruction blocks — by app INTENT
 * (auth app, dashboard, CRUD, chat, landing page, e-commerce, …) and by always-on
 * QUALITY dimensions (UI/UX, security, performance, accessibility). The prompt
 * enhancer is **library-first**: a matched entry turns a vague user prompt into a
 * detailed, unambiguous spec instantly and for free, and the web is only consulted
 * when nothing here matches (see prompt-enhancer.ts).
 *
 * Each entry is a stable id + a matcher + the directive text. Entries are additive;
 * adding intents/dimensions never touches callers. Keep directives concrete and
 * imperative — they are appended verbatim to the model's instructions.
 */

export type LibraryCategory = "app-intent" | "ui-ux" | "security" | "performance" | "accessibility";

export interface LibraryEntry {
  id: string;
  category: LibraryCategory;
  title: string;
  /** Matches the user's prompt (intent entries). Quality entries are always on. */
  match?: RegExp;
  /** The high-quality instruction block, appended to the model prompt verbatim. */
  directives: string;
}

/** Intent templates: matched against the user's prompt; the best matches are applied. */
const INTENTS: LibraryEntry[] = [
  {
    id: "intent-auth",
    category: "app-intent",
    title: "Authentication / accounts",
    match: /\b(auth|login|log ?in|sign ?up|sign ?in|register|account|password|jwt|oauth|session)\b/i,
    directives:
      "Auth: implement sign-up, sign-in, sign-out and a protected area. Hash passwords (bcrypt/argon2), never store plaintext. Issue a signed token/session; gate protected routes server-side, not just in the UI. Validate email format and password strength. Return generic auth errors (don't reveal which field was wrong). Include a complete, working flow end-to-end (form → API → persistence → authenticated state).",
  },
  {
    id: "intent-dashboard",
    category: "app-intent",
    title: "Dashboard / analytics",
    match: /\b(dashboard|analytics|metrics|chart|graph|kpi|report|admin panel)\b/i,
    directives:
      "Dashboard: a responsive layout with a sidebar/nav, summary cards, and charts fed by real data from the API. Every widget has loading, empty, and error states. Numbers are formatted (locale, units). Charts are responsive and accessible (labels, not color alone).",
  },
  {
    id: "intent-crud",
    category: "app-intent",
    title: "CRUD / data management",
    match: /\b(crud|manage|todo|task|note|inventory|catalog|list of|database|records?)\b/i,
    directives:
      "CRUD: full create / read / update / delete wired to a persistent store. List views paginate and show empty/loading/error states. Forms validate input on both client and server. Optimistic UI or clear pending states. Confirm destructive actions.",
  },
  {
    id: "intent-chat",
    category: "app-intent",
    title: "Chat / messaging UI",
    match: /\b(chat|messaging|conversation|messenger|assistant ui|chatbot)\b/i,
    directives:
      "Chat UI: a scrollable message list (auto-scroll to latest), a composer with send-on-enter, streaming/typing indicators, and clear sent/pending/failed states. Preserve history. Handle long messages, links, and empty state gracefully.",
  },
  {
    id: "intent-ecommerce",
    category: "app-intent",
    title: "E-commerce / storefront",
    match: /\b(shop|store|ecommerce|e-commerce|cart|checkout|product|catalog|payment)\b/i,
    directives:
      "Storefront: product grid with detail pages, a cart with quantity controls and totals, and a checkout flow. Prices/currency formatted. Server validates cart and totals (never trust client prices). Empty-cart and out-of-stock states handled.",
  },
  {
    id: "intent-landing",
    category: "app-intent",
    title: "Landing / marketing page",
    match: /\b(landing|marketing|homepage|portfolio|brochure|hero section)\b/i,
    directives:
      "Landing page: a strong hero with a clear value proposition and CTA, supporting sections (features, social proof, FAQ, footer), responsive across breakpoints, fast-loading, and accessible. Cohesive type scale and spacing; no lorem-ipsum left in the final output.",
  },
  {
    id: "intent-blog",
    category: "app-intent",
    title: "Blog / content / CMS",
    match: /\b(blog|cms|article|post|content|news|publication)\b/i,
    directives:
      "Content app: list + detail for posts, readable typography (measure, line-height), metadata (author/date), and empty/loading states. If authored content is dynamic, persist it; otherwise seed realistic sample content (no placeholders in the shipped UI).",
  },
];

/** Always-on quality dimensions, applied to every app regardless of intent. */
const QUALITY: LibraryEntry[] = [
  {
    id: "quality-ui-ux",
    category: "ui-ux",
    title: "UI/UX baseline",
    directives:
      "UI/UX: a consistent design system (spacing scale, type scale, a small color palette, rounded/elevation tokens). Responsive from mobile to desktop. Every data view has explicit loading, empty, and error states. Interactive elements have hover/focus/disabled states. No raw unstyled HTML; no leftover placeholder/lorem text in the shipped UI.",
  },
  {
    id: "quality-accessibility",
    category: "accessibility",
    title: "Accessibility",
    directives:
      "Accessibility: semantic HTML, labelled form controls, alt text, keyboard-navigable interactive elements, visible focus, and sufficient color contrast. Don't convey meaning by color alone.",
  },
  {
    id: "quality-security",
    category: "security",
    title: "Backend security",
    directives:
      "Security: validate and sanitize ALL input server-side. Use parameterized queries / an ORM (never string-concatenated SQL). Enforce authn/authz on every protected endpoint (server-side). Keep secrets in env vars, never in code or the client. Set CORS deliberately. Hash passwords; sign tokens; set secure cookie flags. Don't leak stack traces or secrets in responses.",
  },
  {
    id: "quality-performance",
    category: "performance",
    title: "Performance & efficiency",
    directives:
      "Performance: paginate list endpoints; avoid N+1 queries (eager-load/join); index columns used in filters/joins. Cache expensive reads where safe. Keep the client bundle lean and lazy-load heavy routes. Stream or paginate large responses.",
  },
];

export const PROMPT_LIBRARY: LibraryEntry[] = [...INTENTS, ...QUALITY];

export interface LibraryMatch {
  /** Intent entries whose matcher fired (most specific first). */
  intents: LibraryEntry[];
  /** Always-on quality entries. */
  quality: LibraryEntry[];
  /** True when at least one INTENT matched (→ no web search needed). */
  matchedIntent: boolean;
}

/** Match a user prompt against the library. Quality dimensions are always returned. */
export function matchLibrary(prompt: string): LibraryMatch {
  const intents = INTENTS.filter((e) => e.match!.test(prompt));
  return { intents, quality: QUALITY, matchedIntent: intents.length > 0 };
}

/** Compose the matched directives into a single instruction block. */
export function composeDirectives(m: LibraryMatch, extra: string[] = []): string {
  const blocks = [
    ...m.intents.map((e) => `• ${e.title}: ${e.directives}`),
    ...m.quality.map((e) => `• ${e.title}: ${e.directives}`),
    ...extra.map((e) => `• ${e}`),
  ];
  return blocks.length ? `High-quality build directives:\n${blocks.join("\n")}` : "";
}

/** A short, stable key for the prompt's intent — used to cache web research. */
export function intentKey(prompt: string): string {
  const m = matchLibrary(prompt);
  if (m.matchedIntent) return m.intents.map((e) => e.id).sort().join("+");
  // No known intent: key on the salient nouns so similar novel prompts share a cache slot.
  const words = prompt.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const stop = new Set(["with", "that", "this", "make", "build", "create", "want", "need", "using", "have", "from", "into", "your", "should", "would", "could", "about", "like", "some", "also", "then", "they", "them", "very"]);
  return words.filter((w) => !stop.has(w)).slice(0, 5).sort().join("+") || "generic";
}
