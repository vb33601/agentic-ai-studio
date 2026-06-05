import type { ModelOption } from "./providers";

/**
 * Dynamic model catalogue aggregated across gateways (server-side):
 *   - OpenRouter  (~300 models, one key)
 *   - AIML API    (~600 models, one key)
 *   - Hugging Face router (100k+ models — searched on demand, not pre-listed)
 *
 * Each gateway is OpenAI-compatible, so one key per gateway unlocks its whole
 * catalogue. Models are tagged with `provider` so the chat route knows which
 * gateway to call.
 */

let cache: { at: number; models: ModelOption[] } | null = null;
const TTL = 10 * 60 * 1000;

function timeout(ms: number) {
  return AbortSignal.timeout(ms);
}

async function fetchOpenRouter(): Promise<ModelOption[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data as Array<Record<string, unknown>>)
      .filter((m) => {
        const mod = (m.architecture as { output_modalities?: string[] })?.output_modalities;
        return !mod || mod.includes("text");
      })
      .map((m) => {
        const arch = (m.architecture as { input_modalities?: string[] }) || {};
        return {
          id: m.id as string,
          name: (m.name as string) || (m.id as string),
          provider: "openrouter" as const,
          contextWindow: (m.context_length as number) || 8192,
          supportsVision: (arch.input_modalities || []).includes("image"),
          // Tools enabled for every model so users can toggle tools on any of
          // them; models that don't support tool-calling fall back to the
          // markdown-code path in the chat route.
          supportsTools: true,
          description: ((m.description as string) || "").slice(0, 100),
        };
      });
  } catch {
    return [];
  }
}

async function fetchAIML(): Promise<ModelOption[]> {
  const key = process.env.AIMLAPI_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://api.aimlapi.com/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = (data.data as Array<Record<string, unknown>>) || [];
    const seen = new Set<string>();
    const out: ModelOption[] = [];
    for (const m of list) {
      if (m.type !== "openai/chat-completions" && m.type !== "anthropic/messages") continue;
      const id = m.id as string;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: id,
        provider: "aimlapi",
        contextWindow: (m.context_length as number) || 8192,
        supportsVision: false,
        supportsTools: true,
        description: "via AIML API",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Top trending Hugging Face text-generation models (the long tail is searched). */
async function fetchHuggingFaceTop(): Promise<ModelOption[]> {
  try {
    const res = await fetch(
      "https://huggingface.co/api/models?filter=text-generation&sort=trendingScore&limit=600",
      { signal: timeout(15000) }
    );
    if (!res.ok) return [];
    const list = (await res.json()) as Array<{ id: string }>;
    return list.map((m) => ({
      id: m.id,
      name: m.id,
      provider: "huggingface" as const,
      contextWindow: 8192,
      supportsVision: false,
      supportsTools: true,
      description: "via Hugging Face router",
    }));
  } catch {
    return [];
  }
}

/** Full catalogue (OpenRouter + AIML + Hugging Face top), cached. */
export async function getModelCatalog(): Promise<ModelOption[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.models;
  const [or, aiml, hf] = await Promise.all([fetchOpenRouter(), fetchAIML(), fetchHuggingFaceTop()]);
  const models = [...or, ...aiml, ...hf];
  if (models.length > 0) cache = { at: Date.now(), models };
  return models;
}

/** On-demand Hugging Face Hub search (the 100k+ long tail). */
export async function searchHuggingFace(query: string): Promise<ModelOption[]> {
  try {
    const res = await fetch(
      `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=text-generation&sort=trendingScore&limit=40`,
      { signal: timeout(12000) }
    );
    if (!res.ok) return [];
    const list = (await res.json()) as Array<{ id: string; pipeline_tag?: string }>;
    return list.map((m) => ({
      id: m.id,
      name: m.id,
      provider: "huggingface" as const,
      contextWindow: 8192,
      supportsVision: false,
      supportsTools: true,
      description: "via Hugging Face router",
    }));
  } catch {
    return [];
  }
}
