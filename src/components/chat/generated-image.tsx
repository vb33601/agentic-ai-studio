"use client";

import { useEffect, useState } from "react";
import { Loader2, ImageOff, RefreshCw, Sparkles } from "lucide-react";
import { nanoid } from "nanoid";
import { useWorkspaceStore } from "@/store/workspace";
import { generateImageClient, generateWithPuter } from "@/lib/image-providers";

// Stable seed per prompt so reloads reuse the same image; bumps on regenerate.
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1_000_000;
}

/**
 * AI image with NO API keys: tries a client-side provider chain
 * (Pollinations → Puter → Lexica → LoremFlickr → Picsum). The resolved image
 * is cached (localStorage by prompt), saved into the workspace, and downloads
 * as real bytes (it's a data URL).
 */
type Status = "loading" | "ready" | "fallback" | "error";

function readCache(prompt: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(`aip-img:${prompt}`);
  } catch {
    return null;
  }
}

// Once the user clicks "Puter AI", remember it and use Puter automatically for
// subsequent images (they're logged in, so no modal reappears).
const PUTER_PREF = "aip-use-puter";
function prefersPuter(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(PUTER_PREF) === "1";
  } catch {
    return false;
  }
}

export function GeneratedImage({ prompt, fallbackUrl }: { prompt: string; fallbackUrl?: string }) {
  // Initialize from cache so a previously generated image shows instantly with
  // no effect setState (and no regeneration / repeated logins on reload).
  const [src, setSrc] = useState<string | null>(() => readCache(prompt));
  const [status, setStatus] = useState<Status>(() => (readCache(prompt) ? "ready" : "loading"));
  const addFile = useWorkspaceStore((s) => s.addFile);
  const [attempt, setAttempt] = useState(0);

  const regenerate = () => {
    setStatus("loading");
    setAttempt((a) => a + 1);
  };

  const saveImage = (url: string) => {
    const slug = (prompt || "image").replace(/[^a-z0-9]+/gi, "-").slice(0, 32).replace(/^-|-$/g, "") || "image";
    addFile({ id: nanoid(), name: `${slug}.png`, path: `images/${slug}.png`, content: url, language: "image", isDirty: false });
    try {
      localStorage.setItem(`aip-img:${prompt}`, url);
    } catch {
      /* quota */
    }
  };

  // Opt-in: generate via Puter (may show its login/consent modal). Only runs on
  // an explicit click. Remembers the choice so future images use Puter too.
  const tryPuter = async () => {
    try {
      localStorage.setItem(PUTER_PREF, "1");
    } catch {
      /* ignore */
    }
    setStatus("loading");
    try {
      const url = await generateWithPuter(prompt);
      setSrc(url);
      setStatus("ready");
      saveImage(url);
    } catch {
      setStatus(src ? "fallback" : "error");
    }
  };

  useEffect(() => {
    let cancelled = false;

    const save = (url: string) => {
      const slug = (prompt || "image").replace(/[^a-z0-9]+/gi, "-").slice(0, 32).replace(/^-|-$/g, "") || "image";
      addFile({ id: nanoid(), name: `${slug}.png`, path: `images/${slug}.png`, content: url, language: "image", isDirty: false });
      try {
        localStorage.setItem(`aip-img:${prompt}`, url);
      } catch {
        /* quota */
      }
    };

    // Cache hit (not regenerating): src is already set via the initializer.
    const cached = attempt === 0 ? readCache(prompt) : null;
    if (cached) {
      save(cached);
      return;
    }

    (async () => {
      // If the user opted into Puter, use it first (real AI, no modal once
      // logged in). Falls through to the keyless chain if it fails.
      if (prefersPuter()) {
        try {
          const url = await generateWithPuter(prompt);
          if (cancelled) return;
          setSrc(url);
          setStatus("ready");
          save(url);
          return;
        } catch {
          /* fall through */
        }
      }

      try {
        const { url, real } = await generateImageClient(prompt, hashSeed(prompt) + attempt);
        if (cancelled) return;
        setSrc(url);
        setStatus(real ? "ready" : "fallback");
        save(url);
      } catch {
        if (cancelled) return;
        if (fallbackUrl) {
          setSrc(fallbackUrl);
          setStatus("fallback");
          save(fallbackUrl);
        } else {
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [prompt, fallbackUrl, attempt, addFile]);

  if (status === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground max-w-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Generating image… (can take up to a minute)
      </div>
    );
  }

  if (status === "error" || !src) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground max-w-sm">
        <div className="flex items-center gap-2">
          <ImageOff className="h-4 w-4" /> Couldn&apos;t generate an image.
        </div>
        <button onClick={regenerate} className="flex items-center gap-1 text-primary hover:underline w-fit">
          <RefreshCw className="h-3 w-3" /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 max-w-sm">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={prompt} className="rounded-2xl w-full object-contain border bg-muted" />
      <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
        <span>{status === "fallback" ? "Approximate (AI generators busy)" : "AI generated"}</span>
        <div className="flex items-center gap-2">
          <button onClick={tryPuter} className="flex items-center gap-1 hover:text-foreground" title="Generate with Puter AI (may ask you to sign in)">
            <Sparkles className="h-2.5 w-2.5" /> Puter AI
          </button>
          <button onClick={regenerate} className="flex items-center gap-1 hover:text-foreground">
            <RefreshCw className="h-2.5 w-2.5" /> Regenerate
          </button>
        </div>
      </div>
    </div>
  );
}
