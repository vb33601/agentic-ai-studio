"use client";

import { X, Trash2 } from "lucide-react";
import { useChatStore } from "@/store/chat";
import { useWorkspaceStore } from "@/store/workspace";
import { MODEL_OPTIONS } from "@/lib/ai/providers";
import { Button } from "@/components/ui/button";

const AGENTS = [
  ["orchestrator", "Orchestrator"],
  ["coding", "Coding"],
  ["appBuilder", "App Builder"],
  ["research", "Research"],
  ["gameDev", "Game Dev"],
  ["uiux", "UI/UX"],
  ["fileAnalysis", "File Analysis"],
] as const;

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    selectedModel, setSelectedModel, agentType, setAgentType,
    enableTools, setEnableTools, temperature, setTemperature,
    enhancePrompt, setEnhancePrompt, refineOutput, setRefineOutput,
    sessions, setSessions, setActiveChatId,
  } = useChatStore();
  const setFiles = useWorkspaceStore((s) => s.setFiles);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold">Settings</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground rounded-md p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 text-sm">
          <div className="space-y-1.5">
            <label className="font-medium">Default model</label>
            <select
              value={selectedModel.id}
              onChange={(e) => {
                const m = MODEL_OPTIONS.find((x) => x.id === e.target.value);
                if (m) setSelectedModel(m);
              }}
              className="w-full h-9 rounded-md border bg-background px-2 text-sm"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="font-medium">Default agent</label>
            <select
              value={agentType}
              onChange={(e) => setAgentType(e.target.value)}
              className="w-full h-9 rounded-md border bg-background px-2 text-sm"
            >
              {AGENTS.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="font-medium">Temperature</label>
              <span className="text-xs text-muted-foreground font-mono">{temperature.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0} max={1} step={0.05} value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          <label className="flex items-center justify-between cursor-pointer">
            <span className="font-medium">Enable tools</span>
            <input type="checkbox" checked={enableTools} onChange={(e) => setEnableTools(e.target.checked)} className="h-4 w-4" />
          </label>

          <label className="flex items-center justify-between cursor-pointer">
            <span>
              <span className="font-medium">Enhance prompts</span>
              <span className="block text-xs text-muted-foreground">Rewrite vague/short prompts before sending</span>
            </span>
            <input type="checkbox" checked={enhancePrompt} onChange={(e) => setEnhancePrompt(e.target.checked)} className="h-4 w-4" />
          </label>

          <label className="flex items-center justify-between cursor-pointer">
            <span>
              <span className="font-medium">Refine answers</span>
              <span className="block text-xs text-muted-foreground">Verify &amp; polish low-quality output</span>
            </span>
            <input type="checkbox" checked={refineOutput} onChange={(e) => setRefineOutput(e.target.checked)} className="h-4 w-4" />
          </label>

          <div className="pt-4 border-t space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Danger zone</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 gap-1.5 text-xs" onClick={() => setFiles([])}>
                <Trash2 className="h-3 w-3" /> Clear workspace
              </Button>
              <Button
                variant="outline" size="sm" className="flex-1 gap-1.5 text-xs"
                onClick={() => { if (confirm(`Delete all ${sessions.length} chats from this view?`)) { setSessions([]); setActiveChatId(null); } }}
              >
                <Trash2 className="h-3 w-3" /> Clear chat list
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
