"use client";

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Check, Search } from "lucide-react";
import { ModelOption, ProviderKey } from "@/lib/ai/providers";
import { Badge } from "@/components/ui/badge";
import { useChatStore } from "@/store/chat";
import { cn } from "@/lib/utils";

const PROVIDER_COLORS: Partial<Record<ProviderKey, string>> = {
  openrouter: "bg-indigo-500",
  aimlapi: "bg-emerald-500",
  huggingface: "bg-yellow-500",
};

export function ModelSelector() {
  const { selectedModel, setSelectedModel } = useChatStore();
  const [models, setModels] = useState<ModelOption[]>([selectedModel]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hf, setHf] = useState<ModelOption[]>([]);
  const [searching, setSearching] = useState(false);

  // Load the full catalogue (OpenRouter + AIML) once.
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => Array.isArray(d.models) && d.models.length && setModels(d.models))
      .catch(() => {});
  }, []);

  // On-demand Hugging Face Hub search (the 100k+ long tail).
  useEffect(() => {
    if (query.trim().length < 3) {
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      fetch(`/api/models?hf=${encodeURIComponent(query.trim())}`)
        .then((r) => r.json())
        .then((d) => setHf(Array.isArray(d.models) ? d.models : []))
        .catch(() => setHf([]))
        .finally(() => setSearching(false));
    }, 450);
    return () => clearTimeout(t);
  }, [query]);

  const all = useMemo(() => {
    const seen = new Set<string>();
    const merged: ModelOption[] = [];
    for (const m of [...models, ...hf]) {
      const k = `${m.provider}:${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(m);
    }
    return merged;
  }, [models, hf]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-2 w-36 sm:w-52 h-8 px-2 rounded-md text-xs bg-muted/50 hover:bg-muted transition-colors">
          <span className={cn("w-2 h-2 rounded-full shrink-0", PROVIDER_COLORS[selectedModel.provider] || "bg-gray-500")} />
          <span className="truncate flex-1 text-left">{selectedModel.name}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border bg-popover shadow-xl overflow-hidden"
        >
          <Command shouldFilter className="flex flex-col max-h-96">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search any model…"
                className="h-9 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            {/* Explain what's possible */}
            <div className="px-3 py-2 border-b bg-muted/30 text-[10px] leading-relaxed text-muted-foreground">
              Pick <span className="font-medium text-foreground">any model</span> to switch — all support tools.
              Type <span className="font-medium text-foreground">3+ characters</span> to also search
              Hugging Face&apos;s <span className="font-medium text-foreground">100,000+</span> models live.
            </div>
            <Command.List className="overflow-y-auto p-1">
              <Command.Empty className="py-6 text-center text-xs text-muted-foreground">
                {searching ? "Searching Hugging Face…" : "No models found — type 3+ chars to search Hugging Face"}
              </Command.Empty>
              <div className="px-2 py-1 text-[10px] text-muted-foreground">
                {searching ? "Searching Hugging Face…" : `${all.length} models · OpenRouter · AIML · Hugging Face`}
              </div>
              {all.map((m) => (
                <Command.Item
                  key={`${m.provider}:${m.id}`}
                  value={`${m.id} ${m.name} ${m.provider}`}
                  onSelect={() => {
                    setSelectedModel(m);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer data-[selected=true]:bg-muted"
                >
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", PROVIDER_COLORS[m.provider] || "bg-gray-500")} />
                  <span className="truncate flex-1">{m.name}</span>
                  {m.supportsTools && <Badge variant="outline" className="text-[9px] py-0 px-1">tools</Badge>}
                  <Badge variant="secondary" className="text-[9px] py-0 px-1">{m.provider}</Badge>
                  {m.id === selectedModel.id && <Check className="h-3 w-3 text-primary" />}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
