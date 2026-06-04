/**
 * Client-side image generation provider chain (no API keys required).
 *
 * Runs in the browser so requests use the user's own IP (which has fresh
 * rate-limit quota, unlike the server). Providers are tried in order; the first
 * that returns an image wins. Results are returned as data URLs so they persist
 * across reloads and download as real bytes.
 *
 * Order: no-login real-AI first (Pollinations), then Puter (real AI, one-time
 * login), then keyword/search image sources as graceful fallbacks.
 */

interface PuterAuth {
  isSignedIn?: () => boolean | Promise<boolean>;
  signIn?: () => Promise<unknown>;
}
interface PuterAI {
  txt2img: (prompt: string, opts?: { model?: string } | string) => Promise<HTMLImageElement | string>;
}
declare global {
  interface Window {
    puter?: { ai?: PuterAI; auth?: PuterAuth };
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function urlToDataUrl(url: string, timeoutMs = 30000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.startsWith("image/")) throw new Error(`not an image (${res.status})`);
  return blobToDataUrl(await res.blob());
}

function keywords(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5)
      .join(",") || "abstract"
  );
}

async function waitForPuter(timeoutMs = 10000): Promise<{ ai: PuterAI; auth?: PuterAuth } | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof window !== "undefined" && window.puter?.ai?.txt2img) {
      return { ai: window.puter.ai, auth: window.puter.auth };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Puter.js is loaded ONLY on demand (when the user explicitly opts in) so its
// consent/login modal never blocks the app on load or during normal use.
let puterScriptPromise: Promise<void> | null = null;
function loadPuterScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.puter?.ai?.txt2img) return Promise.resolve();
  if (!puterScriptPromise) {
    puterScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://js.puter.com/v2/";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load Puter.js"));
      document.head.appendChild(s);
    });
  }
  return puterScriptPromise;
}

/**
 * Generate via Puter — invoked ONLY from an explicit user action (a button),
 * because it may show Puter's consent/login modal. Returns a data/image URL.
 */
export async function generateWithPuter(prompt: string): Promise<string> {
  await loadPuterScript();
  const puter = await waitForPuter();
  if (!puter) throw new Error("Puter unavailable");
  // Do NOT call signIn() ourselves — txt2img handles auth, and an explicit
  // signIn while already authenticated triggers an "already logged in" prompt
  // that blocks generation. Just generate.
  const result = await Promise.race([
    puter.ai.txt2img(prompt),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Puter timed out")), 90000)),
  ]);
  const src = typeof result === "string" ? result : result?.src;
  if (!src) throw new Error("Puter returned no image");
  if (src.startsWith("data:")) return src;
  // Convert remote/blob URLs to a data URL so it persists; if that's blocked,
  // fall back to using the URL directly.
  try {
    return await urlToDataUrl(src);
  } catch {
    return src;
  }
}

export interface ImageProvider {
  name: string;
  label: string;
  /** Real AI generation (vs. an approximate photo fallback). */
  real: boolean;
  run: (prompt: string, seed: number) => Promise<string>;
}

export const IMAGE_PROVIDERS: ImageProvider[] = [
  {
    name: "pollinations",
    label: "AI generated",
    real: true,
    run: (prompt, seed) =>
      urlToDataUrl(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`),
  },
  {
    name: "lexica",
    label: "AI generated",
    real: true,
    run: async (prompt) => {
      const res = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(prompt)}`, {
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      const src = data?.images?.[0]?.src ?? data?.images?.[0]?.srcSmall;
      if (!src) throw new Error("No Lexica result");
      return urlToDataUrl(src);
    },
  },
  {
    name: "loremflickr",
    label: "Approximate photo",
    real: false,
    run: (prompt, seed) => urlToDataUrl(`https://loremflickr.com/1024/1024/${encodeURIComponent(keywords(prompt))}?lock=${seed}`),
  },
  {
    name: "picsum",
    label: "Placeholder",
    real: false,
    run: (_prompt, seed) => urlToDataUrl(`https://picsum.photos/seed/${seed}/1024/1024`),
  },
];

export interface GeneratedImageResult {
  url: string;
  provider: string;
  real: boolean;
}

// De-duplicate concurrent calls for the same prompt/seed (the component can
// re-render several times during streaming) so providers aren't hammered.
const inFlight = new Map<string, Promise<GeneratedImageResult>>();

/** Try each provider in order; return the first image produced. */
export function generateImageClient(prompt: string, seed: number): Promise<GeneratedImageResult> {
  const key = `${prompt}::${seed}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const job = (async (): Promise<GeneratedImageResult> => {
    for (const provider of IMAGE_PROVIDERS) {
      try {
        const url = await provider.run(prompt, seed);
        if (url) return { url, provider: provider.name, real: provider.real };
      } catch {
        /* try the next provider */
      }
    }
    throw new Error("All image providers failed");
  })();

  inFlight.set(key, job);
  // Keep the result briefly so near-simultaneous renders share it, then clear.
  job.finally(() => setTimeout(() => inFlight.delete(key), 3000));
  return job;
}
