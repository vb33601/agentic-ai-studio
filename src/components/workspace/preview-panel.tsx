"use client";

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import {
  RefreshCw, ExternalLink, Monitor, Smartphone, Tablet, Play, Square, Loader2, Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspaceStore, WorkspaceFile } from "@/store/workspace";
import { runProject, webContainerSupported, type RunResult } from "@/lib/webcontainer/runner";
import { detectAppGroups, filesForApp, resolveAppRoot } from "@/lib/workspace/apps";
import { AppSelector } from "@/components/workspace/app-selector";

type Viewport = "desktop" | "tablet" | "mobile";
const VIEWPORT_SIZES: Record<Viewport, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

// Normalize an href/src so "./style.css", "/style.css" and "style.css" all match.
function normalizeRef(ref: string): string {
  return ref.trim().replace(/^\.?\//, "");
}

function findFile(files: WorkspaceFile[], ref: string): WorkspaceFile | undefined {
  const norm = normalizeRef(ref);
  return files.find((f) => f.path === norm || f.name === norm || normalizeRef(f.path) === norm);
}

/**
 * Build a self-contained HTML document by inlining any workspace CSS/JS that
 * index.html references via <link>/<script>. srcDoc iframes can't resolve
 * relative paths, so without this multi-file sites render unstyled and inert.
 */
function buildPreviewDoc(files: WorkspaceFile[], indexHtml: string): string {
  let doc = indexHtml.replace(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (tag, href) => {
    if (!/stylesheet/i.test(tag)) return tag;
    const file = findFile(files, href);
    return file ? `<style>\n${file.content}\n</style>` : tag;
  });
  doc = doc.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, _pre, src) => {
    const file = findFile(files, src);
    return file ? `<script>\n${file.content}\n</script>` : tag;
  });
  return doc;
}

type RunStatus = "idle" | "booting" | "ready" | "error";

export function PreviewPanel() {
  const { previewUrl, files, selectedAppDir } = useWorkspaceStore();
  // When the chat has multiple apps, scope preview to the selected one (its
  // files re-rooted), so package.json/index.html resolve at the app's root.
  const groups = useMemo(() => detectAppGroups(files), [files]);
  const appRoot = resolveAppRoot(groups, selectedAppDir);
  const appFiles = useMemo(() => filesForApp(files, appRoot), [files, appRoot]);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [customUrl, setCustomUrl] = useState(previewUrl || "");
  const [key, setKey] = useState(0);

  // WebContainer run state
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [wcUrl, setWcUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const runRef = useRef<RunResult | null>(null);

  const hasPackageJson = appFiles.some((f) => f.name === "package.json");
  const indexFile = appFiles.find((f) => f.name === "index.html");
  const isNodeProject = hasPackageJson;

  const srcDoc = useMemo(
    () => (!isNodeProject && indexFile ? buildPreviewDoc(appFiles, indexFile.content) : undefined),
    [appFiles, indexFile, isNodeProject]
  );

  const appendLog = useCallback((chunk: string) => {
    setLogs((prev) => [...prev.slice(-400), chunk]);
  }, []);

  const stop = useCallback(() => {
    runRef.current?.teardown();
    runRef.current = null;
    setRunStatus("idle");
    setStatusMsg("");
    setWcUrl(null);
  }, []);

  const run = useCallback(async () => {
    if (!webContainerSupported()) {
      setError("Live preview needs a cross-origin-isolated context. Hard-refresh the page (Cmd/Ctrl+Shift+R) and try again — Chrome/Edge recommended.");
      setRunStatus("error");
      return;
    }
    setError(null);
    setLogs([]);
    setWcUrl(null);
    setLogsOpen(true);
    setRunStatus("booting");
    try {
      runRef.current?.teardown();
      runRef.current = await runProject(appFiles, {
        onLog: appendLog,
        onServerReady: (url) => {
          setWcUrl(url);
          setRunStatus("ready");
        },
        onStatus: setStatusMsg,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunStatus("error");
    }
  }, [appFiles, appendLog]);

  // Tear down the running process when leaving the panel.
  useEffect(() => () => runRef.current?.teardown(), []);

  const activeUrl = wcUrl || customUrl;

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2 border-b">
        <AppSelector />
        {isNodeProject ? (
          runStatus === "ready" || runStatus === "booting" ? (
            <Button size="sm" variant="destructive" className="h-7 gap-1.5 text-xs" onClick={stop}>
              <Square className="h-3 w-3" /> Stop
            </Button>
          ) : (
            <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={run} disabled={appFiles.length === 0}>
              <Play className="h-3 w-3" /> Run app
            </Button>
          )
        ) : null}

        <Input
          value={customUrl}
          onChange={(e) => setCustomUrl(e.target.value)}
          className="h-7 text-xs font-mono flex-1"
          placeholder={isNodeProject ? "Dev server URL appears here when running…" : "http://localhost:3000"}
          onKeyDown={(e) => e.key === "Enter" && setKey((k) => k + 1)}
        />
        <div className="flex items-center gap-1 border rounded-md p-0.5">
          {(["desktop", "tablet", "mobile"] as Viewport[]).map((v) => (
            <Button
              key={v}
              variant={viewport === v ? "secondary" : "ghost"}
              size="icon"
              className="h-6 w-6"
              onClick={() => setViewport(v)}
            >
              {v === "desktop" && <Monitor className="h-3 w-3" />}
              {v === "tablet" && <Tablet className="h-3 w-3" />}
              {v === "mobile" && <Smartphone className="h-3 w-3" />}
            </Button>
          ))}
        </div>
        {(logs.length > 0 || isNodeProject) && (
          <Button
            variant={logsOpen ? "secondary" : "ghost"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setLogsOpen((o) => !o)}
            title="Toggle logs"
          >
            <Terminal className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setKey((k) => k + 1)}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={wcUrl ? "Open in a new tab (same browser only — the dev server runs in-browser)" : "Open in a new tab"}
          onClick={() => activeUrl && window.open(activeUrl, "_blank")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>

      {(runStatus === "booting" || statusMsg) && runStatus !== "idle" && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b bg-muted/30">
          {runStatus === "booting" && <Loader2 className="h-3 w-3 animate-spin" />}
          <span className="text-muted-foreground">{statusMsg}</span>
        </div>
      )}

      {error && (
        <div className="px-4 py-2 text-xs border-b bg-destructive/10 text-destructive">{error}</div>
      )}

      {logsOpen && (
        <div className="border-b bg-zinc-950 px-3 py-2 max-h-40 overflow-y-auto font-mono text-[11px] text-zinc-300 whitespace-pre-wrap">
          {logs.length === 0 ? (
            <span className="text-zinc-500">Logs from npm install / dev server will appear here…</span>
          ) : (
            logs.join("")
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center overflow-auto p-4">
        {!isNodeProject && !srcDoc && !customUrl ? (
          <div className="text-center text-muted-foreground text-sm">
            <Monitor className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No preview yet.</p>
            <p className="text-xs mt-1">Generate an HTML site or a Node project, then preview it here.</p>
          </div>
        ) : (
          <div
            className="bg-background shadow-xl rounded-lg overflow-hidden transition-all duration-300 h-full"
            style={{ width: VIEWPORT_SIZES[viewport], maxWidth: "100%" }}
          >
            {wcUrl ? (
              <iframe key={`wc-${key}`} src={wcUrl} className="w-full h-full border-none" title="App preview" />
            ) : srcDoc ? (
              <iframe
                key={`doc-${key}`}
                srcDoc={srcDoc}
                className="w-full h-full border-none"
                sandbox="allow-scripts allow-same-origin"
                title="Preview"
              />
            ) : customUrl ? (
              <iframe key={`url-${key}`} src={customUrl} className="w-full h-full border-none" title="Preview" />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-8 text-center">
                Click <span className="font-medium mx-1">Run app</span> to install dependencies and start the dev server.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
