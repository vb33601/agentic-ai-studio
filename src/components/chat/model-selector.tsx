"use client";

import { MODEL_OPTIONS, ModelOption, ProviderKey } from "@/lib/ai/providers";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useChatStore } from "@/store/chat";

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  mistral: "Mistral",
  cohere: "Cohere",
  groq: "Groq",
  openrouter: "OpenRouter",
  together: "Together AI",
  fireworks: "Fireworks",
  ollama: "Ollama",
};

const PROVIDER_COLORS: Record<ProviderKey, string> = {
  openai: "bg-green-500",
  anthropic: "bg-orange-500",
  google: "bg-blue-500",
  mistral: "bg-purple-500",
  cohere: "bg-pink-500",
  groq: "bg-red-500",
  openrouter: "bg-indigo-500",
  together: "bg-teal-500",
  fireworks: "bg-yellow-500",
  ollama: "bg-gray-500",
};

const groupedModels = MODEL_OPTIONS.reduce(
  (acc, model) => {
    if (!acc[model.provider]) acc[model.provider] = [];
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ModelOption[]>
);

export function ModelSelector() {
  const { selectedModel, setSelectedModel } = useChatStore();

  return (
    <Select
      value={selectedModel.id}
      onValueChange={(id) => {
        const model = MODEL_OPTIONS.find((m) => m.id === id);
        if (model) setSelectedModel(model);
      }}
    >
      <SelectTrigger className="w-48 h-8 text-xs border-none bg-muted/50">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${PROVIDER_COLORS[selectedModel.provider]}`} />
          <SelectValue>{selectedModel.name}</SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {Object.entries(groupedModels).map(([provider, models]) => (
          <SelectGroup key={provider}>
            <SelectLabel className="text-xs text-muted-foreground">
              {PROVIDER_LABELS[provider as ProviderKey]}
            </SelectLabel>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${PROVIDER_COLORS[model.provider]}`} />
                  <span>{model.name}</span>
                  {model.supportsTools && (
                    <Badge variant="outline" className="text-[10px] py-0 px-1 ml-1">Tools</Badge>
                  )}
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
