import { create } from "zustand";
import { persist } from "zustand/middleware";
import { MODEL_OPTIONS, ModelOption } from "@/lib/ai/providers";

export interface ChatSession {
  id: string;
  title: string;
  model: string;
  provider: string;
  createdAt: string | Date;
  messages: number;
}

interface ChatStore {
  // Session list is a cache hydrated from the DB (see Sidebar).
  sessions: ChatSession[];
  activeChatId: string | null;
  selectedModel: ModelOption;
  agentType: string;
  enableTools: boolean;
  temperature: number;
  enhancePrompt: boolean;
  refineOutput: boolean;
  sidebarOpen: boolean;

  setActiveChatId: (id: string | null) => void;
  setSelectedModel: (model: ModelOption) => void;
  setAgentType: (type: string) => void;
  setEnableTools: (enabled: boolean) => void;
  setTemperature: (temp: number) => void;
  setEnhancePrompt: (enabled: boolean) => void;
  setRefineOutput: (enabled: boolean) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSessions: (sessions: ChatSession[]) => void;
  addSession: (session: ChatSession) => void;
  removeSession: (id: string) => void;
  updateSession: (id: string, updates: Partial<ChatSession>) => void;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      sessions: [],
      activeChatId: null,
      selectedModel: MODEL_OPTIONS[0],
      agentType: "orchestrator",
      enableTools: true,
      temperature: 0.7,
      enhancePrompt: true,
      refineOutput: true,
      sidebarOpen: true,

      setActiveChatId: (id) => set({ activeChatId: id }),
      setSelectedModel: (model) => set({ selectedModel: model }),
      setAgentType: (type) => set({ agentType: type }),
      setEnableTools: (enabled) => set({ enableTools: enabled }),
      setTemperature: (temp) => set({ temperature: temp }),
      setEnhancePrompt: (enabled) => set({ enhancePrompt: enabled }),
      setRefineOutput: (enabled) => set({ refineOutput: enabled }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSessions: (sessions) => set({ sessions }),
      addSession: (session) => set((s) => ({ sessions: [session, ...s.sessions] })),
      removeSession: (id) =>
        set((s) => ({
          sessions: s.sessions.filter((c) => c.id !== id),
          activeChatId: s.activeChatId === id ? null : s.activeChatId,
        })),
      updateSession: (id, updates) =>
        set((s) => ({
          sessions: s.sessions.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        })),
    }),
    {
      name: "chat-store",
      // Persist UI preferences + the open chat id (chats/messages live in the
      // database and are re-fetched on load).
      partialize: (s) => ({
        selectedModel: s.selectedModel,
        agentType: s.agentType,
        enableTools: s.enableTools,
        temperature: s.temperature,
        enhancePrompt: s.enhancePrompt,
        refineOutput: s.refineOutput,
        sidebarOpen: s.sidebarOpen,
        activeChatId: s.activeChatId,
      }),
    }
  )
);
