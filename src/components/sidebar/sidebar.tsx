"use client";

import { useState, useEffect } from "react";
import { Plus, MessageSquare, Trash2, Search, Settings, Sparkles, Globe, Cpu, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useChatStore } from "@/store/chat";
import { useWorkspaceStore } from "@/store/workspace";
import { cn } from "@/lib/utils";
import { apiListChats, apiCreateChat, apiDeleteChat } from "@/lib/api/chats";
import { SettingsDialog } from "@/components/settings/settings-dialog";

export function Sidebar() {
  const { sessions, activeChatId, setActiveChatId, setSessions, addSession, removeSession, selectedModel } =
    useChatStore();
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

  // Selecting a chat should also bring the chat view forward.
  const openChat = (id: string) => {
    setActiveChatId(id);
    setActiveTab("chat");
  };
  const [search, setSearch] = useState("");
  const [activeSection, setActiveSection] = useState<"chats" | "projects">("chats");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Hydrate the session list from the database on mount.
  useEffect(() => {
    apiListChats()
      .then((chats) =>
        setSessions(
          chats.map((c) => ({
            id: c.id,
            title: c.title,
            model: c.model,
            provider: c.provider,
            createdAt: c.createdAt,
            messages: c._count?.messages ?? 0,
          }))
        )
      )
      .catch(() => {});
  }, [setSessions]);

  const newChat = async () => {
    try {
      const chat = await apiCreateChat({ title: "New Chat", model: selectedModel.id, provider: "openrouter" });
      addSession({
        id: chat.id,
        title: chat.title,
        model: selectedModel.name,
        provider: chat.provider,
        createdAt: chat.createdAt,
        messages: 0,
      });
      openChat(chat.id);
    } catch {
      // ignore — DB unreachable; a chat will be created on first send instead
    }
  };

  const handleDelete = (id: string) => {
    removeSession(id);
    apiDeleteChat(id).catch(() => {});
  };

  const filtered = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    <div className="w-64 flex flex-col h-full border-r bg-muted/20 shrink-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <div className="flex items-center gap-2 flex-1">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sm">AI Platform</span>
        </div>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={newChat}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats..."
            className="pl-8 h-7 text-xs"
          />
        </div>
      </div>

      <div className="flex gap-1 px-3 pb-2">
        {(["chats", "projects"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setActiveSection(s)}
            className={cn(
              "flex-1 text-xs py-1.5 rounded-md capitalize transition-colors",
              activeSection === s ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-0.5">
          {filtered.length === 0 ? (
            <div className="text-center py-8 text-xs text-muted-foreground">
              {search ? "No chats found" : "No chats yet. Start a new one!"}
            </div>
          ) : (
            filtered.map((session) => (
              <div
                key={session.id}
                onClick={() => openChat(session.id)}
                className={cn(
                  "group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors",
                  session.id === activeChatId
                    ? "bg-background shadow-sm"
                    : "hover:bg-background/60"
                )}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{session.title}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{session.model}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => { e.stopPropagation(); handleDelete(session.id); }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <div className="border-t p-3 space-y-1">
        <QuickAccessButton icon={Globe} label="Web Search" badge="Tavily" />
        <QuickAccessButton icon={Cpu} label="Code Runner" badge="Node.js" />
        <QuickAccessButton icon={Zap} label="Image Gen" badge="Pollinations" />
        <div className="pt-1 border-t mt-2">
          <QuickAccessButton icon={Settings} label="Settings" onClick={() => setSettingsOpen(true)} />
        </div>
      </div>
    </div>
    </>
  );
}

function QuickAccessButton({
  icon: Icon,
  label,
  badge,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      {badge && (
        <Badge variant="outline" className="text-[10px] py-0 ml-auto">{badge}</Badge>
      )}
    </button>
  );
}
