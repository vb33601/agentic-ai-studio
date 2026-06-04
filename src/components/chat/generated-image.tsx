"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, ImageOff, RefreshCw } from "lucide-react";
import { nanoid } from "nanoid";
import { puterGenerateImage } from "@/lib/puter";
import { useWorkspaceStore } from "@/store/workspace";

/**
 * Renders an AI-generated image. Prefers Puter.js (free real AI generation);
 * falls back to the server-provided URL (keyless provider chain) only if Puter
 * fails. The resolved image is saved into the workspace Files. A Regenerate
 * button forces a fresh Puter generation (bypassing the cache).
 */
export function GeneratedImage({ prompt, fallbackUrl }: { prompt: string; fallbackUrl?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "fallback">("loading");
  const addFile = useWorkspaceStore((s) => s.addFile);
  const [attempt, setAttempt] = useState(0);
  const savedRef = useRef(false);

  const save = useCallback(
    (url: string) => {
      savedRef.current = true;
      const slug = (prompt || "image").replace(/[^a-z0-9]+/gi, "-").slice(0, 32).replace(/^-|-$/g, "") || "image";
      addFile({ id: nanoid(), name: `${slug}.png`, path: `images/${slug}.png`, content: url, language: "image", isDirty: false });
    },
    [prompt, addFile]
  );

  const regenerate = () => {
    setStatus("loading");
    setAttempt((a) => a + 1);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await puterGenerateImage(prompt, undefined, attempt > 0);
        if (cancelled) return;
        setSrc(url);
        setStatus("ready");
        save(url);
      } catch {
        if (cancelled) return;
        if (fallbackUrl) {
          setSrc(fallbackUrl);
          setStatus("fallback");
          if (!savedRef.current) save(fallbackUrl);
        } else {
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prompt, fallbackUrl, attempt, save]);

  if (status === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground max-w-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Generating image… (real AI generation can take up to a minute)
      </div>
    );
  }

  if (status === "error" || !src) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground max-w-sm">
        <div className="flex items-center gap-2">
          <ImageOff className="h-4 w-4" />
          Couldn&apos;t generate an image.
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
        <span>{status === "fallback" ? "Approximate match (AI generator unavailable)" : "AI generated"}</span>
        <button onClick={regenerate} className="flex items-center gap-1 hover:text-foreground">
          <RefreshCw className="h-2.5 w-2.5" /> Regenerate
        </button>
      </div>
    </div>
  );
}
