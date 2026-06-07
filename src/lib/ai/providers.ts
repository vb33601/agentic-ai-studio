import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";

export type ProviderKey =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "cohere"
  | "groq"
  | "openrouter"
  | "aimlapi"
  | "huggingface"
  | "together"
  | "fireworks"
  | "ollama";

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
// user's pick is honoured first and these only kick in on failure. Note: an
// account-wide credit 402 is NOT recoverable by fallback (every model bills the
// same account) — that's surfaced to the user with a top-up link instead.
const OPENROUTER_FALLBACKS = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "anthropic/claude-3.5-haiku",
];

export interface ModelCandidate {
  id: string;
  provider: string;
}

/**
 * The ordered model chain to try for a request: the user's pick first, then
 * reliable, tool-capable fallbacks. Works for ANY primary provider — if the
 * chosen model/provider fails before streaming (down, rate-limited, rejects the
 * request), the route retries the next candidate. OpenRouter additionally does
 * its own in-request fallback via the `models` list (see resolveModel).
 */
export function modelCandidates(modelId: string, provider?: string): ModelCandidate[] {
  const primary: ModelCandidate = { id: modelId, provider: provider || "openrouter" };
  const fallbacks: ModelCandidate[] = OPENROUTER_FALLBACKS.map((id) => ({ id, provider: "openrouter" }));
  return [primary, ...fallbacks.filter((c) => c.id !== modelId)];
}

/**
 * Resolve a model to an AI SDK LanguageModel, routing to the right gateway by
 * provider. OpenRouter, AIML API, and the Hugging Face router are all
 * OpenAI-compatible, so one key per gateway unlocks its whole catalogue.
 */
export function resolveModel(modelId: string, providerSource?: string) {
  switch (providerSource) {
    case "aimlapi":
      return createOpenAI({ baseURL: "https://api.aimlapi.com/v1", apiKey: process.env.AIMLAPI_API_KEY, name: "aimlapi" }).chat(modelId);
    case "huggingface":
      return createOpenAI({ baseURL: "https://router.huggingface.co/v1", apiKey: process.env.HUGGINGFACE_API_KEY, name: "huggingface" }).chat(modelId);
    case "openrouter":
    default: {
      // Pass an ordered fallback list so OpenRouter auto-retries another model
      // if the chosen one fails mid-request (kept first so it's preferred).
      const models = [modelId, ...OPENROUTER_FALLBACKS.filter((m) => m !== modelId)];
      return getOpenRouter()(modelId, { models });
    }
  }
}
