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
  sidebarOpen: boolean;

  setActiveChatId: (id: string | null) => void;
  setSelectedModel: (model: ModelOption) => void;
  setAgentType: (type: string) => void;
  setEnableTools: (enabled: boolean) => void;
  setTemperature: (temp: number) => void;
  toggleSidebar: () => void;
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
      sidebarOpen: true,

      setActiveChatId: (id) => set({ activeChatId: id }),
      setSelectedModel: (model) => set({ selectedModel: model }),
      setAgentType: (type) => set({ agentType: type }),
      setEnableTools: (enabled) => set({ enableTools: enabled }),
      setTemperature: (temp) => set({ temperature: temp }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
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
      // Persist only UI preferences; chats/messages live in the database.
      partialize: (s) => ({
        selectedModel: s.selectedModel,
        agentType: s.agentType,
        enableTools: s.enableTools,
        temperature: s.temperature,
        sidebarOpen: s.sidebarOpen,
      }),
    }
  )
);
