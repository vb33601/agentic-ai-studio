"use client";

import dynamic from "next/dynamic";
import { FileText, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/store/workspace";
import { Badge } from "@/components/ui/badge";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export function CodeEditor() {
  const { files, activeFileId, setActiveFileId, updateFile } = useWorkspaceStore();
  const activeFile = files.find((f) => f.id === activeFileId);

  // Editor is controlled directly from the store; no local mirror state needed.
  const handleChange = (val: string | undefined) => {
    if (activeFileId) {
      updateFile(activeFileId, { content: val ?? "", isDirty: true });
    }
  };

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <FileText className="h-12 w-12 mb-3 opacity-40" />
        <p className="text-sm">No files yet</p>
        <p className="text-xs mt-1">Ask the AI to generate code — files will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/30 overflow-x-auto">
        {files.map((file) => (
          <button
            key={file.id}
            onClick={() => setActiveFileId(file.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-sm whitespace-nowrap transition-colors ${
              file.id === activeFileId
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
            }`}
          >
            <span>{file.name}</span>
            {file.isDirty && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
          </button>
        ))}
      </div>

      {activeFile && (
        <>
          <div className="flex items-center justify-between px-4 py-1 border-b bg-muted/20 text-xs text-muted-foreground">
            <span className="font-mono">{activeFile.path}</span>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] py-0">{activeFile.language}</Badge>
              {activeFile.isDirty && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => updateFile(activeFile.id, { isDirty: false })}
                >
                  <Save className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
          {activeFile.language === "image" ? (
            <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto bg-zinc-900 p-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={activeFile.content} alt={activeFile.name} className="max-w-full max-h-full object-contain rounded-lg border" />
            </div>
          ) : (
          <div className="flex-1 min-h-0">
            <MonacoEditor
              height="100%"
              path={activeFile.path}
              language={activeFile.language}
              value={activeFile.content}
              onChange={handleChange}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: "on",
                wordWrap: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace",
              }}
            />
          </div>
          )}
        </>
      )}
    </div>
  );
}
