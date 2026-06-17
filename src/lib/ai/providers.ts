import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGateway } from "@ai-sdk/gateway";

export type ProviderKey =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "cohere"
  | "groq"
  | "openrouter"
  | "kilocode"
  | "aimlapi"
  | "huggingface"
  | "together"
  | "fireworks"
  | "ollama"
  | "gateway"
  | "requesty";

// Kilo Code gateway: OpenAI-compatible, ~335 models behind one key. The host
// canonicalises kilocode.ai → kilo.ai, so use the final host to avoid a 308 hop.
export const KILOCODE_BASE_URL = "https://kilo.ai/api/openrouter";

export interface ModelOption {
  id: string;
  name: string;
  provider: ProviderKey;
  contextWindow: number;
  supportsVision: boolean;
  supportsTools: boolean;
  description: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  // DEFAULT: Auto — a free-first router that escalates to premium only for complex
  // builds (and only when those accounts have credit). Keeps generation running at
  // $0 by default so the app never dies on "out of credits"; the user can still pin
  // any specific model below. Handled specially in the chat route (see autoCandidates).
  { id: "auto", name: "Auto (free-first)", provider: "openrouter", contextWindow: 1000000, supportsVision: true, supportsTools: true, description: "Recommended — free models first, escalates to premium Claude/GPT for complex builds" },
  // Google Gemini (DIRECT — uses GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY).
  // Google's free tier is generous, so these are the primary zero-cost workhorses.
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (free tier)", provider: "google", contextWindow: 1048576, supportsVision: true, supportsTools: true, description: "Google-direct — fast, free-tier available, great default" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google", contextWindow: 1048576, supportsVision: true, supportsTools: true, description: "Google-direct — most capable Gemini" },
  // Anthropic (direct — uses ANTHROPIC_API_KEY, no gateway markup). Preferred for
  // code generation; the build anchor auto-promotes to these when the key is set.
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (direct)", provider: "anthropic", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Anthropic-direct — best balance for code generation" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8 (direct)", provider: "anthropic", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Anthropic-direct — most capable Claude" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (direct)", provider: "anthropic", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Anthropic-direct — fast, economical Claude" },
  // OpenAI via OpenRouter
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openrouter", contextWindow: 128000, supportsVision: true, supportsTools: true, description: "Most capable OpenAI model" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "openrouter", contextWindow: 128000, supportsVision: true, supportsTools: true, description: "Fast, affordable OpenAI model" },
  { id: "openai/gpt-4-turbo", name: "GPT-4 Turbo", provider: "openrouter", contextWindow: 128000, supportsVision: true, supportsTools: true, description: "GPT-4 Turbo with vision" },
  { id: "openai/o4-mini", name: "o4 Mini", provider: "openrouter", contextWindow: 200000, supportsVision: false, supportsTools: true, description: "Fast reasoning model" },
  // Anthropic via OpenRouter
  { id: "anthropic/claude-opus-4", name: "Claude Opus 4", provider: "openrouter", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Most capable Claude model" },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "openrouter", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Balanced Claude model" },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "openrouter", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Fast Claude model" },
  { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku", provider: "openrouter", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Fast, economical Claude model" },
  // Google via OpenRouter
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "openrouter", contextWindow: 1000000, supportsVision: true, supportsTools: true, description: "Google's most capable model" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "openrouter", contextWindow: 1000000, supportsVision: true, supportsTools: true, description: "Fast Gemini model" },
  // Meta via OpenRouter
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "openrouter", contextWindow: 128000, supportsVision: false, supportsTools: true, description: "Fast Llama model" },
  { id: "meta-llama/llama-3.1-70b-instruct", name: "Llama 3.1 70B", provider: "openrouter", contextWindow: 131072, supportsVision: false, supportsTools: true, description: "Capable Llama model" },
  // Mistral via OpenRouter
  { id: "mistralai/mistral-large", name: "Mistral Large", provider: "openrouter", contextWindow: 128000, supportsVision: false, supportsTools: true, description: "Mistral's flagship model" },
  { id: "mistralai/mixtral-8x22b-instruct", name: "Mixtral 8x22B", provider: "openrouter", contextWindow: 65536, supportsVision: false, supportsTools: true, description: "Efficient Mistral MoE model" },
  // DeepSeek via OpenRouter
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1", provider: "openrouter", contextWindow: 65536, supportsVision: false, supportsTools: true, description: "DeepSeek reasoning model" },
];

function getOpenRouter(apiKey?: string) {
  return createOpenRouter({
    apiKey: apiKey || process.env.OPENROUTER_API_KEY,
  });
}

export function getModel(modelId: string, _providerKey?: ProviderKey, apiKey?: string) {
  return getOpenRouter(apiKey)(modelId);
}

// Reliable, tool-capable, economical models OpenRouter falls back to when the
// chosen model errors (provider down, rate-limited, or rejects the request —
// e.g. "roles must alternate"). OpenRouter tries the list in order, so the
// user's pick is honoured first and these only kick in on failure.
const OPENROUTER_FALLBACKS = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "anthropic/claude-3.5-haiku",
];

export interface ModelCandidate {
  id: string;
  provider: string;
  /**
   * Per-call output-token ceiling for this candidate. Free / very-low-balance
   * gateways reserve credits against the FULL requested max_tokens up front and
   * reject a large request (OpenRouter 402 "can only afford N tokens"; similar
   * caps on free routers), so the big default cap makes the free tail unusable.
   * A smaller cap here lets these models actually run — smaller per file, but a
   * produced (if simpler) app beats a hard failure. Undefined = use the default.
   */
  maxOutputTokens?: number;
  /** True for the no-cost fallback tier — used to surface a degraded-mode banner
   *  ("running on free models — output may be incomplete") when a build lands here. */
  free?: boolean;
}

// Per-call cap for the free fallback tier (see ModelCandidate.maxOutputTokens).
const FREE_TIER_MAX_TOKENS = Number(process.env.FREE_TIER_MAX_TOKENS) || 4000;

/**
 * Whether a real Anthropic-direct API key is configured. A Claude.ai
 * subscription (Pro/Max) is NOT an API key — this must be an `sk-ant-…` key
 * from console.anthropic.com. When present, generation auto-promotes to
 * Anthropic-direct (cheapest, no gateway markup); when absent we route Claude
 * through the funded Kilo Code gateway instead. Dropping a key into
 * ANTHROPIC_API_KEY is the only change needed to flip the anchor.
 */
export function anthropicDirectAvailable(): boolean {
  // Kill-switch: when the Anthropic account is out of credits (402s) but the key
  // is still present, set DISABLE_ANTHROPIC_DIRECT=1 to flip every Claude path
  // (anchor, magic-prompt, plan, fallback chain) over to the funded Kilo route
  // without having to remove the key.
  const off = process.env.DISABLE_ANTHROPIC_DIRECT;
  if (off && off.trim() !== "" && off.trim() !== "0" && off.trim().toLowerCase() !== "false") return false;
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim().length > 0;
}

/** Whether a Google Generative AI (Gemini) key is configured. Gemini's free tier
 *  is the primary zero-cost workhorse, so the Auto router leads with it when set.
 *  Accepts either the AI SDK's standard var or the common GEMINI_API_KEY alias. */
export function googleDirectAvailable(): boolean {
  const k = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  return !!k && k.trim().length > 0;
}

/** Whether a router that can serve the broad models.dev directory is usable —
 *  the Vercel AI Gateway (key or OIDC) or Requesty. */
export function gatewayAvailable(): boolean {
  return !!(process.env.VERCEL_AI_GATEWAY_KEY || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.REQUESTY_API_KEY);
}

// The strong "Claude-quality" anchor every code generation should lead with.
// Anthropic-direct when keyed, else Claude Sonnet 4.6 via the funded Kilo Code
// gateway (verified tool-capable). `claude-sonnet-4-6` is the canonical
// Anthropic API id; `anthropic/claude-sonnet-4.6` is its Kilo route.
export const ANTHROPIC_DIRECT_ANCHOR: ModelCandidate = { id: "claude-sonnet-4-6", provider: "anthropic" };
export const KILO_CLAUDE_ANCHOR: ModelCandidate = { id: "anthropic/claude-sonnet-4.6", provider: "kilocode" };

// Two-tier anchoring to conserve premium-model credits:
//  - "heavy": Claude Sonnet 4.6 — complex / full-stack code generation.
//  - "light": Claude Haiku 4.5 — low-to-medium tasks (simple builds, chat,
//    enhancer/plan/judge). This is the modern replacement for the deprecated
//    "Claude Instant". Anthropic-direct ids when keyed, else the Kilo routes.
export type AnchorTier = "light" | "heavy";
const TIER_ANCHORS: Record<"anthropic" | "kilo", Record<AnchorTier, ModelCandidate>> = {
  anthropic: {
    heavy: ANTHROPIC_DIRECT_ANCHOR,
    light: { id: "claude-haiku-4-5-20251001", provider: "anthropic" },
  },
  kilo: {
    heavy: KILO_CLAUDE_ANCHOR,
    light: { id: "anthropic/claude-3.5-haiku", provider: "kilocode" },
  },
};

export function primaryAnchor(tier: AnchorTier = "heavy"): ModelCandidate {
  const set = anthropicDirectAvailable() ? TIER_ANCHORS.anthropic : TIER_ANCHORS.kilo;
  return { ...set[tier] };
}

// Cross-provider, cross-ACCOUNT fallback chain. Unlike a same-gateway list, these
// span different billing accounts, so a 402 / insufficient-balance on one account
// fails over to a DIFFERENT one instead of dying (the old single-key failure mode
// that truncated builds). Ordered strongest→cheapest and ending in FREE models so
// a generation never hard-fails on model supply.
const CROSS_PROVIDER_FALLBACKS: ModelCandidate[] = [
  KILO_CLAUDE_ANCHOR,                                       // funded Claude Sonnet 4.6 (Kilo)
  { id: "claude-sonnet-4-6", provider: "aimlapi" },         // Claude on a different account
  { id: "openai/gpt-4o-mini", provider: "openrouter" },     // funded OpenRouter (when topped up)
  // FREE last-resort tier — capped output so it runs at zero/negative balance.
  { id: "kilo-auto/free", provider: "kilocode", maxOutputTokens: FREE_TIER_MAX_TOKENS, free: true },
  { id: "gpt-3.5-turbo", provider: "aimlapi", maxOutputTokens: FREE_TIER_MAX_TOKENS, free: true },
  { id: "Qwen/Qwen3.6-27B", provider: "huggingface", maxOutputTokens: FREE_TIER_MAX_TOKENS, free: true },
];

// Gemini direct on the free tier — the leading zero-cost workhorse (full output
// cap; the free tier is generous, unlike the credit-reserving routers).
const GEMINI_FREE: ModelCandidate = { id: "gemini-2.5-flash", provider: "google", free: true };

// Best-effort free models on OpenRouter (the `:free` tier). IDs on the free tier
// rotate over time, so this is a chain (any that 404s is skipped by the candidate
// loop) and is overridable via OPENROUTER_FREE_MODELS (comma-separated).
const OPENROUTER_FREE: ModelCandidate[] = (
  process.env.OPENROUTER_FREE_MODELS
    ? process.env.OPENROUTER_FREE_MODELS.split(",").map((s) => s.trim()).filter(Boolean)
    : [
        "deepseek/deepseek-chat-v3-0324:free",
        "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemini-2.0-flash-exp:free",
      ]
).map((id) => ({ id, provider: "openrouter", maxOutputTokens: FREE_TIER_MAX_TOKENS, free: true }));

/** The always-available free fallback tier, strongest→weakest. */
function freeChain(): ModelCandidate[] {
  return [
    ...(googleDirectAvailable() ? [GEMINI_FREE] : []),
    ...OPENROUTER_FREE,
    { id: "kilo-auto/free", provider: "kilocode", maxOutputTokens: FREE_TIER_MAX_TOKENS, free: true },
    { id: "gpt-3.5-turbo", provider: "aimlapi", maxOutputTokens: FREE_TIER_MAX_TOKENS, free: true },
  ];
}

/** Premium anchors that actually have a route configured (key present). */
function premiumChain(tier: AnchorTier): ModelCandidate[] {
  const out: ModelCandidate[] = [];
  if (anthropicDirectAvailable()) out.push(primaryAnchor(tier));
  if (process.env.KILOCODE_API_KEY) out.push(tier === "heavy" ? KILO_CLAUDE_ANCHOR : { id: "anthropic/claude-3.5-haiku", provider: "kilocode" });
  // Requesty (user-funded router) as a reliable premium route — strong, cheap
  // Gemini that conserves Claude credits while keeping quality high.
  if (process.env.REQUESTY_API_KEY) out.push(tier === "heavy" ? { id: "google/gemini-2.5-pro", provider: "requesty" } : { id: "google/gemini-2.5-flash", provider: "requesty" });
  return out;
}

const dedupeCandidates = (chain: ModelCandidate[]): ModelCandidate[] => {
  const seen = new Set<string>();
  return chain.filter((c) => {
    const k = candidateKey(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * The Auto (free-first, escalate) router — the default. Simple builds run on free
 * models first; complex builds lead with premium Claude/GPT WHEN those accounts
 * are configured (with the free chain as the always-present safety net, so a
 * credit exhaustion can never hard-fail a build). `wantHeavy` comes from the
 * route's complexity score.
 */
export function autoCandidates(wantHeavy: boolean): ModelCandidate[] {
  const free = freeChain();
  const premium = premiumChain(wantHeavy ? "heavy" : "light");
  // Complex → premium first (best quality) then free fallback.
  // Simple  → free first ($0) then premium only if free supply is exhausted.
  return dedupeCandidates(wantHeavy ? [...premium, ...free] : [...free, ...premium]);
}

const candidateKey = (c: ModelCandidate) => `${c.provider}:${c.id}`;

/**
 * The ordered model chain to try for a request: the caller's pick first, then a
 * cross-provider/cross-account fallback chain that ends in free models. If the
 * chosen model fails before streaming (down, rate-limited, 402, rejects the
 * request), the route retries the next candidate — now on a DIFFERENT account,
 * so a single dead key can no longer truncate a build. When an Anthropic-direct
 * key is configured it is inserted right after the primary so Claude leads.
 */
export function modelCandidates(modelId: string, provider?: string): ModelCandidate[] {
  const p = provider || "openrouter";
  const primary: ModelCandidate = { id: modelId, provider: p };
  const chain: ModelCandidate[] = [primary];
  // Lead with Anthropic-direct when keyed and not already the primary.
  if (anthropicDirectAvailable() && p !== "anthropic") {
    chain.push(ANTHROPIC_DIRECT_ANCHOR);
  }
  chain.push(...CROSS_PROVIDER_FALLBACKS);
  // Dedupe by provider:id, keeping the first (highest-priority) occurrence.
  const seen = new Set<string>();
  return chain.filter((c) => {
    const k = candidateKey(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Resolve a model to an AI SDK LanguageModel, routing to the right gateway by
 * provider. OpenRouter, AIML API, and the Hugging Face router are all
 * OpenAI-compatible, so one key per gateway unlocks its whole catalogue.
 */
export function resolveModel(modelId: string, providerSource?: string) {
  switch (providerSource) {
    case "anthropic":
      // Anthropic-direct (native tool use). Only reached when ANTHROPIC_API_KEY
      // is set — primaryAnchor()/modelCandidates gate this provider on the key.
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
    case "google":
      // Google Gemini direct (free tier). Native tool calling + 1M context.
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
      })(modelId);
    case "requesty":
      // Requesty — OpenAI-compatible LLM router (router.requesty.ai). Serves a
      // curated set of frontier models (grok-4, gemini-3, gpt-5.x, claude, …) with
      // `creator/model` ids. Used as the user's primary gateway key.
      return createOpenAI({ baseURL: "https://router.requesty.ai/v1", apiKey: process.env.REQUESTY_API_KEY, name: "requesty" }).chat(modelId);
    case "gateway":
      // Vercel AI Gateway — one endpoint over the broad models.dev directory.
      // Model ids are `creator/model` slugs (e.g. "google/gemini-2.5-flash").
      return createGateway({ apiKey: process.env.VERCEL_AI_GATEWAY_KEY || process.env.AI_GATEWAY_API_KEY })(modelId);
    case "aimlapi":
      return createOpenAI({ baseURL: "https://api.aimlapi.com/v1", apiKey: process.env.AIMLAPI_API_KEY, name: "aimlapi" }).chat(modelId);
    case "huggingface":
      return createOpenAI({ baseURL: "https://router.huggingface.co/v1", apiKey: process.env.HUGGINGFACE_API_KEY, name: "huggingface" }).chat(modelId);
    case "kilocode":
      return createOpenAI({ baseURL: KILOCODE_BASE_URL, apiKey: process.env.KILOCODE_API_KEY, name: "kilocode" }).chat(modelId);
    case "openrouter":
    default: {
      // Pass an ordered fallback list so OpenRouter auto-retries another model
      // if the chosen one fails mid-request (kept first so it's preferred).
      const models = [modelId, ...OPENROUTER_FALLBACKS.filter((m) => m !== modelId)];
      return getOpenRouter()(modelId, { models });
    }
  }
}
