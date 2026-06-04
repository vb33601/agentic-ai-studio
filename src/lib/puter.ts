/**
 * Client-side helper around Puter.js for free, keyless AI image generation.
 * Loaded via the <Script> tag in the root layout. Results are cached (memory +
 * localStorage keyed by prompt+model) so an image persists across reloads and
 * isn't regenerated on every render.
 */

interface PuterAI {
  txt2img: (prompt: string, opts?: { model?: string; quality?: string } | string) => Promise<HTMLImageElement | string>;
}
declare global {
  interface Window {
    puter?: { ai?: PuterAI };
  }
}

const memCache = new Map<string, string>();

function cacheKey(prompt: string, model?: string) {
  return `puter-img:${model || "default"}:${prompt}`;
}

/** Wait for the Puter script to finish loading (it's injected afterInteractive). */
function waitForPuter(timeoutMs = 12000): Promise<PuterAI | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (typeof window !== "undefined" && window.puter?.ai?.txt2img) return resolve(window.puter.ai);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function toDataUrl(src: string): Promise<string> {
  if (!src.startsWith("blob:")) return src;
  const res = await fetch(src);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * Generate an image with Puter. Returns a stable data/URL string, or throws if
 * Puter is unavailable or generation fails (caller can then use a fallback).
 */
export async function puterGenerateImage(prompt: string, model?: string): Promise<string> {
  const key = cacheKey(prompt, model);
  if (memCache.has(key)) return memCache.get(key)!;
  try {
    const ls = localStorage.getItem(key);
    if (ls) {
      memCache.set(key, ls);
      return ls;
    }
  } catch {
    /* ignore */
  }

  const ai = await waitForPuter();
  if (!ai) throw new Error("Puter.js not available");

  // Race the generation against a timeout so a stalled call falls back.
  const result = await Promise.race([
    ai.txt2img(prompt, model ? { model } : undefined),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Puter timed out")), 22000)),
  ]);
  const rawSrc = typeof result === "string" ? result : result?.src || "";
  if (!rawSrc) throw new Error("Puter returned no image");
  const src = await toDataUrl(rawSrc);

  memCache.set(key, src);
  try {
    localStorage.setItem(key, src);
  } catch {
    /* localStorage quota — keep the in-memory copy only */
  }
  return src;
}
