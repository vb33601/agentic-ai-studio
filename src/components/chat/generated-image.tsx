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

/**
 * AI image rendered DIRECTLY from the same-origin /api/image proxy.
 *
 * No fetch / data URL / localStorage — the <img> loads the proxy URL straight,
 * which means: zero CORS, no quota issues, browser-cached, survives reload, and
 * downloads as real bytes (same-origin). The server proxy runs the multi-
 * provider chain (HuggingFace/Cloudflare/Together/Pollinations/…).
 */
export function GeneratedImage({ prompt }: { prompt: string }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const addFile = useWorkspaceStore((s) => s.addFile);

  const seed = hashSeed(prompt) + attempt;
  const url = `/api/image?prompt=${encodeURIComponent(prompt)}&seed=${seed}`;

  const regenerate = () => {
    setLoaded(false);
    setError(false);
    setAttempt((a) => a + 1);
  };

  // Save into the workspace once the image has actually loaded.
  useEffect(() => {
    if (!loaded) return;
    const slug = (prompt || "image").replace(/[^a-z0-9]+/gi, "-").slice(0, 32).replace(/^-|-$/g, "") || "image";
    addFile({ id: nanoid(), name: `${slug}.png`, path: `images/${slug}.png`, content: url, language: "image", isDirty: false });
  }, [loaded, url, prompt, addFile]);

  if (error) {
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
      {!loaded && (
        <div className="flex items-center gap-2 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Generating image… (can take up to a minute)
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={url}
        src={url}
        alt={prompt}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        className={loaded ? "rounded-2xl w-full object-contain border bg-muted" : "hidden"}
      />
      {loaded && (
        <button onClick={regenerate} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1 w-fit">
          <RefreshCw className="h-2.5 w-2.5" /> Regenerate
        </button>
      )}
    </div>
  );
}
