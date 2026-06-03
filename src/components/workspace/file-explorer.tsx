"use client";

import { File, Folder, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceStore } from "@/store/workspace";

const LANG_COLORS: Record<string, string> = {
  typescript: "text-blue-400",
  javascript: "text-yellow-400",
  python: "text-green-400",
  css: "text-pink-400",
  html: "text-orange-400",
  json: "text-amber-400",
  markdown: "text-gray-400",
  sql: "text-cyan-400",
};

function groupFilesByDirectory(files: { id: string; name: string; path: string; language: string; isDirty: boolean }[]) {
  const groups: Record<string, typeof files> = {};
  files.forEach((f) => {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  });
  return groups;
}

export function FileExplorer() {
  const { files, activeFileId, setActiveFileId, removeFile } = useWorkspaceStore();

  const downloadAll = () => {
    files.forEach((file) => {
      const blob = new Blob([file.content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8 text-center">
        <Folder className="h-12 w-12 mb-3 opacity-40" />
        <p className="text-sm font-medium">No files generated yet</p>
        <p className="text-xs mt-1">Chat with the AI to generate project files</p>
      </div>
    );
  }

  const groups = groupFilesByDirectory(files);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <span className="text-sm font-medium">Files ({files.length})</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={downloadAll} title="Download all">
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2">
          {Object.entries(groups).map(([dir, dirFiles]) => (
            <div key={dir} className="mb-2">
              {dir !== "." && (
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                  <Folder className="h-3.5 w-3.5" />
                  <span className="font-mono">{dir}/</span>
                </div>
              )}
              {dirFiles.map((file) => (
                <div
                  key={file.id}
                  onClick={() => setActiveFileId(file.id)}
                  className={`group flex items-center justify-between px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                    file.id === activeFileId ? "bg-primary/10 text-primary" : "hover:bg-muted"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <File className={`h-3.5 w-3.5 shrink-0 ${LANG_COLORS[file.language] || "text-muted-foreground"}`} />
                    <span className="text-xs font-mono truncate">{file.name}</span>
                    {file.isDirty && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0"
                    onClick={(e) => { e.stopPropagation(); removeFile(file.id); }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
