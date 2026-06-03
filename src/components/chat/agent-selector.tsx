"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useChatStore } from "@/store/chat";

const AGENTS = [
  { id: "orchestrator", label: "Orchestrator", emoji: "🧠" },
  { id: "coding", label: "Coding", emoji: "💻" },
  { id: "appBuilder", label: "App Builder", emoji: "🏗️" },
  { id: "research", label: "Research", emoji: "🔍" },
  { id: "gameDev", label: "Game Dev", emoji: "🎮" },
  { id: "uiux", label: "UI/UX", emoji: "🎨" },
  { id: "fileAnalysis", label: "File Analysis", emoji: "📄" },
];

export function AgentSelector() {
  const { agentType, setAgentType } = useChatStore();

  return (
    <Select value={agentType} onValueChange={setAgentType}>
      <SelectTrigger className="w-40 h-8 text-xs border-none bg-muted/50">
        <SelectValue>
          {AGENTS.find((a) => a.id === agentType)?.emoji}{" "}
          {AGENTS.find((a) => a.id === agentType)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {AGENTS.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <span className="mr-2">{agent.emoji}</span>
            {agent.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
