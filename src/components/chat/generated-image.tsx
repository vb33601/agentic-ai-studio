"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, ImageOff } from "lucide-react";
import { nanoid } from "nanoid";
import { puterGenerateImage } from "@/lib/puter";
import { useWorkspaceStore } from "@/store/workspace";

/**
 * Renders an AI-generated image. Prefers Puter.js (free real AI generation);
 * falls back to the server-provided URL (keyless provider chain) if Puter is
 * unavailable. The resolved image is also saved into the workspace Files.
 */
export function GeneratedImage({ prompt, fallbackUrl }: { prompt: string; fallbackUrl?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const addFile = useWorkspaceStore((s) => s.addFile);
  const savedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const save = (url: string) => {
      if (savedRef.current) return;
      savedRef.current = true;
      const slug = (prompt || "image").replace(/[^a-z0-9]+/gi, "-").slice(0, 32).replace(/^-|-$/g, "") || "image";
      addFile({ id: nanoid(), name: `${slug}.png`, path: `images/${slug}.png`, content: url, language: "image", isDirty: false });
    };

    (async () => {
      try {
        const url = await puterGenerateImage(prompt);
        if (cancelled) return;
        setSrc(url);
        setStatus("ready");
        save(url);
      } catch {
        if (cancelled) return;
        if (fallbackUrl) {
          setSrc(fallbackUrl);
          setStatus("ready");
          save(fallbackUrl);
        } else {
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [prompt, fallbackUrl, addFile]);

  if (status === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground max-w-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Generating image…
      </div>
    );
  }

  if (status === "error" || !src) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground max-w-sm">
        <ImageOff className="h-4 w-4" />
        Couldn&apos;t generate an image. Try again.
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={prompt} className="rounded-2xl max-w-sm object-contain border bg-muted" />
  );
}
