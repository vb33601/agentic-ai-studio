/**
 * Multi-provider image generation with graceful fallback.
 *
 * Tries each provider in order and returns the first that yields a usable
 * image. Real text-to-image providers (some gated behind optional API keys)
 * come first; keyless photo sources act as always-available fallbacks so the
 * user never ends up with a broken image.
 */

export interface ImageResult {
  url: string;
  provider: string;
}

const URL_TIMEOUT = 12000;
const GEN_TIMEOUT = 60000;

/** Confirm a URL actually returns an image; return the (post-redirect) URL. */
async function verifyImageUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(URL_TIMEOUT),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const ct = res.headers.get("content-type") || "";
    const good = res.ok && ct.startsWith("image/");
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return good ? res.url || url : null;
  } catch {
    return null;
  }
}

async function responseToDataUrl(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/png";
  return `data:${ct};base64,${buf.toString("base64")}`;
}

/** Reduce a prompt to a few keywords for keyword-based photo sources. */
function keywords(prompt: string): string {
  const kw = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5)
    .join(",");
  return kw || "abstract";
}

interface Provider {
  name: string;
  run: (prompt: string, width: number, height: number) => Promise<string | null>;
}

const PROVIDERS: Provider[] = [
  // 1. Pollinations FLUX (keyless AI) — best when not rate-limited.
  {
    name: "pollinations-flux",
    run: (p, w, h) =>
      verifyImageUrl(`https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=${w}&height=${h}&nologo=true&model=flux`),
  },
  // 2. OpenAI DALL·E 3 (needs OPENAI_API_KEY).
  {
    name: "openai-dalle3",
    run: async (p) => {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      try {
        const r = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "dall-e-3", prompt: p, n: 1, size: "1024x1024" }),
          signal: AbortSignal.timeout(GEN_TIMEOUT),
        });
        if (!r.ok) return null;
        const d = await r.json();
        return d?.data?.[0]?.url ?? null;
      } catch {
        return null;
      }
    },
  },
  // 3. Hugging Face FLUX.1-schnell (needs HUGGINGFACE_API_KEY).
  {
    name: "huggingface-flux",
    run: async (p) => {
      const key = process.env.HUGGINGFACE_API_KEY;
      if (!key) return null;
      try {
        const r = await fetch("https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: p }),
          signal: AbortSignal.timeout(GEN_TIMEOUT),
        });
        if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) return null;
        return await responseToDataUrl(r);
      } catch {
        return null;
      }
    },
  },
  // 4. Stability AI SD3/Core (needs STABILITY_API_KEY).
  {
    name: "stability-core",
    run: async (p) => {
      const key = process.env.STABILITY_API_KEY;
      if (!key) return null;
      try {
        const form = new FormData();
        form.append("prompt", p);
        form.append("output_format", "png");
        const r = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, Accept: "image/*" },
          body: form,
          signal: AbortSignal.timeout(GEN_TIMEOUT),
        });
        if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) return null;
        return await responseToDataUrl(r);
      } catch {
        return null;
      }
    },
  },
  // 5. Pollinations default model (keyless AI).
  {
    name: "pollinations",
    run: (p, w, h) =>
      verifyImageUrl(`https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=${w}&height=${h}&nologo=true`),
  },
  // 6. Lexica (keyless) — Stable Diffusion gallery search.
  {
    name: "lexica",
    run: async (p) => {
      try {
        const r = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(p)}`, {
          signal: AbortSignal.timeout(URL_TIMEOUT),
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!r.ok) return null;
        const d = await r.json();
        const src = d?.images?.[0]?.src ?? d?.images?.[0]?.srcSmall;
        return src ? verifyImageUrl(src) : null;
      } catch {
        return null;
      }
    },
  },
  // 7. LoremFlickr (keyless) — real photos matching the keywords.
  {
    name: "loremflickr",
    run: (p, w, h) => verifyImageUrl(`https://loremflickr.com/${w}/${h}/${encodeURIComponent(keywords(p))}`),
  },
  // 8. Unsplash source (keyless) — curated photos.
  {
    name: "unsplash",
    run: (p, w, h) => verifyImageUrl(`https://source.unsplash.com/${w}x${h}/?${encodeURIComponent(keywords(p))}`),
  },
  // 9. Picsum (keyless) — deterministic placeholder; final guarantee.
  {
    name: "picsum",
    run: (p, w, h) =>
      verifyImageUrl(`https://picsum.photos/seed/${encodeURIComponent(p).slice(0, 24) || "seed"}/${w}/${h}`),
  },
];

export async function generateImageWithFallback(
  prompt: string,
  width = 1024,
  height = 1024
): Promise<ImageResult> {
  for (const provider of PROVIDERS) {
    try {
      const url = await provider.run(prompt, width, height);
      if (url) return { url, provider: provider.name };
    } catch {
      /* try the next provider */
    }
  }
  throw new Error("All image providers failed");
}
