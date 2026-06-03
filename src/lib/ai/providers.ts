import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export type ProviderKey =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "cohere"
  | "groq"
  | "openrouter"
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
  { id: "openai/o1-preview", name: "o1 Preview", provider: "openrouter", contextWindow: 128000, supportsVision: false, supportsTools: false, description: "Advanced reasoning model" },
  { id: "openai/o1-mini", name: "o1 Mini", provider: "openrouter", contextWindow: 128000, supportsVision: false, supportsTools: false, description: "Fast reasoning model" },
  // Anthropic via OpenRouter
  { id: "anthropic/claude-opus-4", name: "Claude Opus 4", provider: "openrouter", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Most capable Claude model" },
  { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "openrouter", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Balanced Claude model" },
  { id: "anthropic/claude-haiku-3-5", name: "Claude Haiku 3.5", provider: "openrouter", contextWindow: 200000, supportsVision: true, supportsTools: true, description: "Fast Claude model" },
  // Google via OpenRouter
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "openrouter", contextWindow: 1000000, supportsVision: true, supportsTools: true, description: "Google's most capable model" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "openrouter", contextWindow: 1000000, supportsVision: true, supportsTools: true, description: "Fast Gemini model" },
  // Meta via OpenRouter
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "openrouter", contextWindow: 128000, supportsVision: false, supportsTools: true, description: "Fast Llama model" },
  { id: "meta-llama/llama-3.1-405b-instruct", name: "Llama 3.1 405B", provider: "openrouter", contextWindow: 131072, supportsVision: false, supportsTools: true, description: "Largest Llama model" },
  // Mistral via OpenRouter
  { id: "mistralai/mistral-large", name: "Mistral Large", provider: "openrouter", contextWindow: 128000, supportsVision: false, supportsTools: true, description: "Mistral's flagship model" },
  { id: "mistralai/mixtral-8x7b-instruct", name: "Mixtral 8x7B", provider: "openrouter", contextWindow: 32768, supportsVision: false, supportsTools: true, description: "Efficient Mistral model" },
  // DeepSeek via OpenRouter
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1", provider: "openrouter", contextWindow: 65536, supportsVision: false, supportsTools: false, description: "DeepSeek reasoning model" },
];

function getOpenRouter(apiKey?: string) {
  return createOpenRouter({
    apiKey: apiKey || process.env.OPENROUTER_API_KEY,
  });
}

export function getModel(modelId: string, _providerKey?: ProviderKey, apiKey?: string) {
  return getOpenRouter(apiKey)(modelId);
}

export function resolveModel(modelId: string, apiKey?: string) {
  const option = MODEL_OPTIONS.find((m) => m.id === modelId);
  return getModel(option?.id ?? modelId, "openrouter", apiKey);
}
