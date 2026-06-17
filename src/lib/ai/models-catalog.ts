import { KILOCODE_BASE_URL, MODEL_OPTIONS, type ModelOption } from "./providers";

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

async function fetchKiloCode(): Promise<ModelOption[]> {
  const key = process.env.KILOCODE_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(`${KILOCODE_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = (data.data as Array<Record<string, unknown>>) || [];
    return list.map((m) => {
      const arch = (m.architecture as { input_modalities?: string[]; output_modalities?: string[] }) || {};
      const params = (m.supported_parameters as string[]) || [];
      return {
        id: m.id as string,
        name: (m.name as string) || (m.id as string),
        provider: "kilocode" as const,
        contextWindow: (m.context_length as number) || 8192,
        supportsVision: (arch.input_modalities || []).includes("image"),
        // Real tool-calling support per the model's advertised parameters.
        supportsTools: params.includes("tools"),
        description: ((m.description as string) || "via Kilo Code").slice(0, 100),
      };
    });
  } catch {
    return [];
  }
}

async function fetchAIML(): Promise<ModelOption[]> {
  const key = process.env.AIMLAPI_API_KEY;
  if (!key) return [];
  // AIML has moved its model-listing endpoint before, so try the documented
  // path and the OpenAI-standard one. Whichever responds wins; both shapes
  // (AIML's `{data:[{id,type}]}` and OpenAI's `{data:[{id}]}`) are handled.
  const endpoints = ["https://api.aimlapi.com/models", "https://api.aimlapi.com/v1/models"];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: timeout(15000),
      });
      if (!res.ok) {
        // Surface the real status so an invalid key / moved endpoint is
        // diagnosable in logs instead of models silently vanishing.
        console.warn(`[models] AIML ${url} → ${res.status}`);
        continue;
      }
      const data = await res.json();
      const list = (data.data as Array<Record<string, unknown>>) || [];
      const seen = new Set<string>();
      const out: ModelOption[] = [];
      for (const m of list) {
        // AIML tags chat models with `type`; the OpenAI-standard list has no
        // `type` — accept those too rather than dropping everything.
        if ("type" in m && m.type !== "openai/chat-completions" && m.type !== "anthropic/messages") continue;
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
      if (out.length) return out;
    } catch (e) {
      console.warn(`[models] AIML ${url} fetch failed:`, e instanceof Error ? e.message : e);
    }
  }
  return [];
}

/**
 * models.dev — the canonical, community-maintained directory of EVERY provider +
 * model (the same catalog opencode uses). One fetch yields the full directory with
 * rich metadata (context, tool-calling, modalities). Routed via the Vercel AI
 * Gateway (`creator/model` slugs), so a single AI_GATEWAY_API_KEY unlocks them all.
 */
async function fetchModelsDev(): Promise<ModelOption[]> {
  try {
    const res = await fetch("https://models.dev/api.json", { signal: timeout(15000) });
    if (!res.ok) return [];
    const data = (await res.json()) as Record<string, {
      id?: string;
      name?: string;
      models?: Record<string, {
        id?: string;
        name?: string;
        tool_call?: boolean;
        limit?: { context?: number };
        modalities?: { input?: string[]; output?: string[] };
      }>;
    }>;
    // models.dev's top-level keys are AGGREGATORS (requesty, nano-gpt, openrouter,
    // vercel, …) that each re-offer the same models, and the model ids are already
    // canonical `creator/model` slugs (e.g. "xai/grok-4", "google/gemini-2.5-flash").
    // Dedupe to the UNIQUE creator/model set — the real directory, and the exact
    // slug form both routers accept. (Skip bare/3-part ids no router can resolve.)
    //
    // Routing: models in Requesty's own catalog route via the user's REQUESTY key
    // (provider "requesty"); every other model routes via the Vercel AI Gateway
    // (provider "gateway"). So each model is tagged with a router that can serve it.
    const requestySet = new Set(
      Object.values(data["requesty"]?.models || {}).map((m) => (m.id || "").trim()).filter(Boolean),
    );
    const out: ModelOption[] = [];
    const seen = new Set<string>();
    for (const provider of Object.values(data)) {
      for (const m of Object.values(provider?.models || {})) {
        const slug = (m.id || "").trim();
        if (!slug || (slug.match(/\//g) || []).length !== 1) continue; // want exactly creator/model
        if (seen.has(slug)) continue;
        const outputs = m.modalities?.output;
        if (outputs && !outputs.includes("text")) continue; // text-generating only
        seen.add(slug);
        const viaRequesty = requestySet.has(slug);
        out.push({
          id: slug,
          name: m.name || slug,
          provider: viaRequesty ? "requesty" : "gateway",
          contextWindow: m.limit?.context || 8192,
          supportsVision: (m.modalities?.input || []).includes("image"),
          supportsTools: m.tool_call !== false,
          description: `${slug.split("/")[0]} · via ${viaRequesty ? "Requesty" : "AI Gateway"}`,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Requesty — the user's funded OpenAI-compatible router. Pulls its FULL live
 * catalogue (~530 models incl. azure/vertex/bedrock-hosted frontier models) so
 * every Requesty model is selectable in chat. Routed via the "requesty" provider.
 */
async function fetchRequesty(): Promise<ModelOption[]> {
  const key = process.env.REQUESTY_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://router.requesty.ai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[models] Requesty /v1/models → ${res.status}`);
      return [];
    }
    const data = await res.json();
    const list = (data.data as Array<Record<string, unknown>>) || [];
    const out: ModelOption[] = [];
    const seen = new Set<string>();
    for (const m of list) {
      const id = m.id as string;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const params = (m.supported_parameters as string[]) || [];
      out.push({
        id,
        name: (m.name as string) || id,
        provider: "requesty",
        contextWindow: (m.context_window as number) || (m.context_length as number) || (m.max_tokens as number) || 8192,
        supportsVision: Boolean(m.supports_vision) || ((m.input_modalities as string[]) || []).includes("image"),
        // Default tools on (users can toggle); honour an explicit advertised list.
        supportsTools: m.supports_tools !== false && (params.length ? params.includes("tools") : true),
        description: `${id.includes("/") ? id.split("/")[0] : "requesty"} · via Requesty`,
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

/**
 * Full catalogue, cached. The curated MODEL_OPTIONS lead ALWAYS (so "Auto",
 * Gemini free-tier, and the Claude/Gemini direct picks never get buried under the
 * dynamic lists), followed by the complete models.dev directory and the
 * gateway catalogues (Kilo Code + OpenRouter + AIML + Hugging Face top), deduped.
 */
export async function getModelCatalog(): Promise<ModelOption[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.models;
  const [requesty, modelsDev, kilo, or, aiml, hf] = await Promise.all([
    fetchRequesty(),
    fetchModelsDev(),
    fetchKiloCode(),
    fetchOpenRouter(),
    fetchAIML(),
    fetchHuggingFaceTop(),
  ]);
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  // Curated picks lead; then the full live Requesty catalogue; then the models.dev
  // directory + gateway catalogues. Deduped by provider:id.
  for (const m of [...MODEL_OPTIONS, ...requesty, ...modelsDev, ...kilo, ...or, ...aiml, ...hf]) {
    const k = `${m.provider}:${m.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    models.push(m);
  }
  // Cache only when at least one dynamic source responded (else retry next call).
  if (requesty.length || modelsDev.length || kilo.length || or.length || aiml.length || hf.length) cache = { at: Date.now(), models };
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
