"use client";

import { MessageSquare, Code, Eye, FolderOpen, Rocket, PanelLeftClose, PanelLeft } from "lucide-react";
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
  const { sidebarOpen, toggleSidebar } = useChatStore();

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {sidebarOpen && <Sidebar />}

      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-1 px-3 py-2 border-b bg-background/95 backdrop-blur-sm">
          <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={toggleSidebar}>
            {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          </Button>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                activeTab === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-hidden">
          {activeTab === "chat" && <ChatWindow />}
          {activeTab === "code" && <CodeEditor />}
          {activeTab === "files" && <FileExplorer />}
          {activeTab === "preview" && <PreviewPanel />}
          {activeTab === "deploy" && <DeployPanel />}
        </div>
      </div>
    </div>
  );
}
