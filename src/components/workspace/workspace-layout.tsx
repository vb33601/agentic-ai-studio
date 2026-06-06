"use client";

import { useEffect } from "react";
import { MessageSquare, Code, Eye, FolderOpen, Rocket, PanelLeftClose, PanelLeft, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChatWindow } from "@/components/chat/chat-window";
import { CodeEditor } from "@/components/editor/code-editor";
import { FileExplorer } from "./file-explorer";
import { PreviewPanel } from "./preview-panel";
import { DeployPanel } from "./deploy-panel";
import { useWorkspaceStore, WorkspaceTab } from "@/store/workspace";
import { Sidebar } from "@/components/sidebar/sidebar";
import { useChatStore } from "@/store/chat";

const TABS: { id: WorkspaceTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "code", label: "Code", icon: Code },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "preview", label: "Preview", icon: Eye },
  { id: "deploy", label: "Deploy", icon: Rocket },
];

export function WorkspaceLayout() {
  const { activeTab, setActiveTab } = useWorkspaceStore();
  const { sidebarOpen, toggleSidebar, setSidebarOpen } = useChatStore();

  // Start with the sidebar collapsed on small screens (it's an overlay there).
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) setSidebarOpen(false);
  }, [setSidebarOpen]);

  return (
    <div className="flex h-dvh bg-background overflow-hidden">
      {/* Sidebar: a top sheet (stacked menu) that drops down on mobile/tablet,
          an in-flow left column on desktop. */}
      <div
        className={cn(
          "fixed inset-x-0 top-0 z-50 transition-transform duration-200 md:static md:inset-auto md:z-auto md:translate-y-0 md:transition-none",
          sidebarOpen ? "translate-y-0" : "-translate-y-full md:hidden"
        )}
      >
        <Sidebar />
      </div>
      {/* Tap-out backdrop (small screens only). */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-1 px-2 sm:px-3 py-2 border-b bg-background/95 backdrop-blur-sm overflow-x-auto no-scrollbar">
          <Button variant="ghost" size="icon" className="h-8 w-8 mr-1 shrink-0" onClick={toggleSidebar} title="Menu">
            <Menu className="h-4 w-4 md:hidden" />
            <span className="hidden md:inline-flex">
              {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
            </span>
          </Button>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
              className={cn(
                "flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0",
                activeTab === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <tab.icon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-hidden min-h-0">
          {/* ChatWindow stays mounted (just hidden) so streaming and autosave
              are never interrupted by switching tabs — e.g. the auto-jump to
              the Files tab after a generation must not unmount the chat. */}
          <div className={cn("h-full", activeTab !== "chat" && "hidden")}>
            <ChatWindow />
          </div>
          {activeTab === "code" && <CodeEditor />}
          {activeTab === "files" && <FileExplorer />}
          {activeTab === "preview" && <PreviewPanel />}
          {activeTab === "deploy" && <DeployPanel />}
        </div>
      </div>
    </div>
  );
}
