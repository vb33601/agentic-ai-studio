"use client";

import { useEffect, useState } from "react";
import { Loader2, ImageOff, RefreshCw } from "lucide-react";
import { nanoid } from "nanoid";
import { useWorkspaceStore } from "@/store/workspace";

// Stable seed per prompt so reloads reuse the same image; bumps on regenerate.
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1_000_000;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function readCache(prompt: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(`aip-img:${prompt}`);
  } catch {
    return null;
  }
}

/**
 * AI image via the same-origin /api/image proxy (no CORS, keys stay server-side,
 * multi-provider fallback). Result is converted to a data URL so it persists
 * across reloads, shows in Files, and downloads as real bytes.
 */
export function GeneratedImage({ prompt }: { prompt: string }) {
  const [src, setSrc] = useState<string | null>(() => readCache(prompt));
  const [status, setStatus] = useState<"loading" | "ready" | "error">(() => (readCache(prompt) ? "ready" : "loading"));
  const addFile = useWorkspaceStore((s) => s.addFile);
  const [attempt, setAttempt] = useState(0);

  const regenerate = () => {
    setStatus("loading");
    setAttempt((a) => a + 1);
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

    // Cache hit (not regenerating): src already set via the initializer.
    if (attempt === 0 && readCache(prompt)) {
      save(readCache(prompt)!);
      return;
    }

    (async () => {
      try {
        const seed = hashSeed(prompt) + attempt;
        const res = await fetch(`/api/image?prompt=${encodeURIComponent(prompt)}&seed=${seed}`, {
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const dataUrl = await blobToDataUrl(await res.blob());
        if (cancelled) return;
        setSrc(dataUrl);
        setStatus("ready");
        save(dataUrl);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [prompt, attempt, addFile]);

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
      <button onClick={regenerate} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1 w-fit">
        <RefreshCw className="h-2.5 w-2.5" /> Regenerate
      </button>
    </div>
  );
}
