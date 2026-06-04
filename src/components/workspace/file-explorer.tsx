"use client";

import { File, Folder, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceStore, WorkspaceFile } from "@/store/workspace";

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later so the download isn't cancelled mid-flight.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function isImageFile(file: WorkspaceFile): boolean {
  return file.language === "image" || /^(https?:|data:image)/.test(file.content);
}

// Image files store a URL/data-URL as content — fetch the real bytes so the
// downloaded file is an actual viewable image, not a text file of the URL.
async function imageBlob(file: WorkspaceFile): Promise<Blob> {
  const res = await fetch(file.content);
  return res.blob();
}

function withImageExt(name: string, mime: string): string {
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) return name;
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return `${name.replace(/\.[^.]*$/, "")}.${ext}`;
}

async function downloadOne(file: WorkspaceFile) {
  if (isImageFile(file)) {
    try {
      const blob = await imageBlob(file);
      triggerDownload(blob, withImageExt(file.name, blob.type));
      return;
    } catch {
      /* fall back to text download */
    }
  }
  triggerDownload(new Blob([file.content], { type: "text/plain;charset=utf-8" }), file.name);
}

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

function groupFilesByDirectory(files: WorkspaceFile[]) {
  const groups: Record<string, WorkspaceFile[]> = {};
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

  // Bundle every file into one .zip (looping individual downloads triggers
  // browser pop-up blocking and only the first/last file actually downloads).
  const downloadAll = async () => {
    if (files.length === 0) return;
    if (files.length === 1) return downloadOne(files[0]);
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    await Promise.all(
      files.map(async (f) => {
        if (isImageFile(f)) {
          try {
            zip.file(f.path, await imageBlob(f)); // real image bytes
            return;
          } catch {
            /* fall back to storing the reference */
          }
        }
        zip.file(f.path, f.content);
      })
    );
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, "project.zip");
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
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 opacity-0 group-hover:opacity-100"
                      title="Download file"
                      onClick={(e) => { e.stopPropagation(); downloadOne(file); }}
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 opacity-0 group-hover:opacity-100"
                      title="Delete file"
                      onClick={(e) => { e.stopPropagation(); removeFile(file.id); }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
