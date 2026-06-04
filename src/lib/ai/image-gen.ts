/**
 * Server-side image generation with a multi-provider fallback chain.
 *
 * This runs ON THE SERVER (called from /api/image), which means:
 *   - No CORS: the browser only talks to our same-origin /api/image.
 *   - API keys stay on the server, never exposed to the client.
 *   - Provider IP limits hit the server, not the user — so key-based providers
 *     (which aren't IP-limited) are preferred for reliability.
 *
 * Order: real-AI providers that use a key (reliable) first, then keyless real
 * AI (Pollinations, best-effort), then keyword-photo fallbacks so the user
 * always gets an image. Results are returned as raw bytes.
 */

export interface ImageBytes {
  buffer: Buffer;
  contentType: string;
  provider: string;
}

const GEN_TIMEOUT = 120_000;
const URL_TIMEOUT = 25_000;

async function fetchBytes(url: string, timeout = URL_TIMEOUT, init?: RequestInit): Promise<ImageBytes | null> {
  try {
    const res = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "Mozilla/5.0", ...(init?.headers || {}) } });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.startsWith("image/")) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: ct, provider: "" };
  } catch {
    return null;
  }
}

function keywords(prompt: string): string {
  return (
    prompt.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 5).join(",") || "abstract"
  );
}

interface Provider {
  name: string;
  run: (prompt: string, width: number, height: number, seed: number) => Promise<ImageBytes | null>;
}

/** Hugging Face Inference for an open image model (FLUX/SDXL). */
async function huggingFace(model: string, prompt: string): Promise<ImageBytes | null> {
  const key = process.env.HUGGINGFACE_API_KEY;
  if (!key) return null;
  return fetchBytes(`https://api-inference.huggingface.co/models/${model}`, GEN_TIMEOUT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: prompt }),
  });
}

const PROVIDERS: Provider[] = [
  // 1-2. Hugging Face — open models (FLUX.1-schnell, SDXL). Free token, no IP
  //      limit; the most reliable real-AI path. Get a token (no card) at
  //      https://huggingface.co/settings/tokens and set HUGGINGFACE_API_KEY.
  {
    name: "huggingface-flux",
    run: async (prompt) => {
      const r = await huggingFace(process.env.HUGGINGFACE_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell", prompt);
      return r && { ...r, provider: "huggingface:flux" };
    },
  },
  {
    name: "huggingface-sdxl",
    run: async (prompt) => {
      const r = await huggingFace("stabilityai/stable-diffusion-xl-base-1.0", prompt);
      return r && { ...r, provider: "huggingface:sdxl" };
    },
  },
  // 3. Cloudflare Workers AI (open FLUX schnell). Free tier. Needs account id + token.
  {
    name: "cloudflare",
    run: async (prompt) => {
      const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
      const key = process.env.CLOUDFLARE_API_TOKEN;
      if (!acct || !key) return null;
      const model = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
      const r = await fetchBytes(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, GEN_TIMEOUT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      return r && { ...r, provider: "cloudflare" };
    },
  },
  // 4. Together AI (real AI; has a free FLUX schnell model). Needs a key.
  {
    name: "together",
    run: async (prompt) => {
      const key = process.env.TOGETHER_API_KEY;
      if (!key) return null;
      try {
        const res = await fetch("https://api.together.xyz/v1/images/generations", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: process.env.TOGETHER_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell-Free", prompt, width: 1024, height: 1024, n: 1 }),
          signal: AbortSignal.timeout(GEN_TIMEOUT),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const item = data?.data?.[0];
        if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), contentType: "image/png", provider: "together" };
        if (item?.url) {
          const r = await fetchBytes(item.url, GEN_TIMEOUT);
          return r && { ...r, provider: "together" };
        }
        return null;
      } catch {
        return null;
      }
    },
  },
  // 5-6. Pollinations — the only keyless open-source AI (Flux/Turbo). Best
  //      effort: rate-limited per IP, so it may 402 and fall through.
  {
    name: "pollinations-flux",
    run: async (prompt, w, h, seed) => {
      const r = await fetchBytes(
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${seed}&model=flux&referrer=ai-platform`,
        45_000
      );
      return r && { ...r, provider: "pollinations:flux" };
    },
  },
  {
    name: "pollinations-turbo",
    run: async (prompt, w, h, seed) => {
      const r = await fetchBytes(
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${seed}&model=turbo&referrer=ai-platform`,
        45_000
      );
      return r && { ...r, provider: "pollinations:turbo" };
    },
  },
  // 7. LoremFlickr (keyless; keyword-relevant photo — reliable server-side).
  {
    name: "loremflickr",
    run: async (prompt, w, h, seed) => {
      const r = await fetchBytes(`https://loremflickr.com/${w}/${h}/${encodeURIComponent(keywords(prompt))}?lock=${seed}`);
      return r && { ...r, provider: "loremflickr" };
    },
  },
  // 8. Picsum (keyless; deterministic placeholder — final guarantee).
  {
    name: "picsum",
    run: async (_prompt, w, h, seed) => {
      const r = await fetchBytes(`https://picsum.photos/seed/${seed}/${w}/${h}`);
      return r && { ...r, provider: "picsum" };
    },
  },
];

// Small in-memory cache so reloads/identical prompts don't re-bill providers.
const cache = new Map<string, ImageBytes>();
const CACHE_MAX = 40;

export async function generateImage(prompt: string, width = 1024, height = 1024, seed = 0): Promise<ImageBytes | null> {
  const key = `${seed}:${width}x${height}:${prompt}`;
  const cached = cache.get(key);
  if (cached) return cached;

  for (const provider of PROVIDERS) {
    try {
      const result = await provider.run(prompt, width, height, seed);
      if (result) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(key, result);
        return result;
      }
    } catch {
      /* next provider */
    }
  }
  return null;
}
