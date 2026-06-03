"use client";

import { useState } from "react";
import { Rocket, ExternalLink, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceStore } from "@/store/workspace";

const PROVIDERS = [
  { id: "vercel", name: "Vercel", description: "Live deploy · configured", logo: "▲", configured: true },
  { id: "netlify", name: "Netlify", description: "Static + serverless", logo: "◆", configured: false },
  { id: "cloudflare", name: "Cloudflare Pages", description: "Global edge network", logo: "○", configured: false },
  { id: "github", name: "GitHub Pages", description: "Free static hosting", logo: "◉", configured: false },
];

interface Deployment {
  id: string;
  provider: string;
  status: "pending" | "building" | "deployed" | "failed";
  url?: string;
  inspectorUrl?: string;
  timestamp: Date;
}

export function DeployPanel() {
  const { files, addBuildLog, buildLog, clearBuildLog } = useWorkspaceStore();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("my-app");

  const update = (id: string, patch: Partial<Deployment>) =>
    setDeployments((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const deploy = async (provider: string) => {
    if (files.length === 0) {
      alert("No files to deploy. Generate some code first.");
      return;
    }
    const deployId = crypto.randomUUID().replace(/-/g, "");
    setDeploying(provider);
    clearBuildLog();
    setDeployments((prev) => [
      { id: deployId, provider, status: "building", timestamp: new Date() },
      ...prev,
    ]);

    if (provider !== "vercel") {
      addBuildLog(`Provider "${provider}" is not configured yet — only Vercel is wired up.`);
      update(deployId, { status: "failed" });
      setDeploying(null);
      return;
    }

    try {
      addBuildLog(`Uploading ${files.length} files to Vercel…`);
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "vercel", files, name: projectName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deployment request failed");

      addBuildLog(`Deployment created → ${data.url}`);
      addBuildLog("Building on Vercel…");
      update(deployId, { url: data.url, inspectorUrl: data.inspectorUrl });

      // Poll readiness for up to ~2 minutes.
      let settled = false;
      for (let i = 0; i < 40 && !settled; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await fetch(`/api/deploy?id=${data.id}`).then((r) => r.json()).catch(() => null);
        if (!s?.readyState) continue;
        if (s.readyState === "READY") {
          addBuildLog("✓ Deployment is live!");
          update(deployId, { status: "deployed", url: s.url || data.url });
          settled = true;
        } else if (s.readyState === "ERROR" || s.readyState === "CANCELED") {
          addBuildLog(`✗ Build ${s.readyState.toLowerCase()} on Vercel.`);
          update(deployId, { status: "failed" });
          settled = true;
        } else {
          addBuildLog(`Status: ${s.readyState}…`);
        }
      }
      if (!settled) {
        addBuildLog("Still building — opening the URL will show progress.");
        update(deployId, { status: "deployed", url: data.url });
      }
    } catch (e) {
      addBuildLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
      update(deployId, { status: "failed" });
    } finally {
      setDeploying(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Rocket className="h-4 w-4" />
          Deploy Project
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          {files.length} files ready · Choose a hosting provider
        </p>
        <div className="flex items-center gap-2 mt-3">
          <label className="text-xs text-muted-foreground shrink-0">Project name</label>
          <Input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="h-7 text-xs font-mono"
            placeholder="my-app"
          />
        </div>
      </div>

      <div className="p-4 grid grid-cols-2 gap-3 border-b">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => deploy(p.id)}
            disabled={!!deploying}
            className="relative flex items-center gap-3 p-3 rounded-xl border hover:border-primary/60 hover:bg-primary/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-left"
          >
            <span className="text-2xl">{p.logo}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium flex items-center gap-1.5">
                {p.name}
                {p.configured && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
              </p>
              <p className="text-xs text-muted-foreground truncate">{p.description}</p>
            </div>
            {deploying === p.id && <Loader2 className="h-4 w-4 animate-spin ml-auto" />}
          </button>
        ))}
      </div>

      {buildLog.length > 0 && (
        <div className="p-4 border-b">
          <p className="text-xs font-medium mb-2">Build Log</p>
          <div className="bg-zinc-950 rounded-lg p-3 font-mono text-xs space-y-1 max-h-32 overflow-y-auto">
            {buildLog.map((line, i) => (
              <div key={i} className="text-green-400">
                <span className="text-zinc-500">$ </span>
                {line}
              </div>
            ))}
            {deploying && <div className="text-zinc-400 animate-pulse">…</div>}
          </div>
        </div>
      )}

      <ScrollArea className="flex-1 p-4">
        <p className="text-xs font-medium mb-3 text-muted-foreground">Deployment History</p>
        {deployments.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No deployments yet</p>
        ) : (
          <div className="space-y-2">
            {deployments.map((d) => (
              <div key={d.id} className="flex items-center justify-between p-3 rounded-lg border">
                <div className="flex items-center gap-2 min-w-0">
                  {d.status === "deployed" && <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />}
                  {d.status === "failed" && <XCircle className="h-4 w-4 text-red-500 shrink-0" />}
                  {d.status === "building" && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-xs font-medium capitalize">{d.provider}</p>
                    {d.url ? (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-primary hover:underline truncate block"
                      >
                        {d.url}
                      </a>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">{d.timestamp.toLocaleTimeString()}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant={d.status === "deployed" ? "success" : d.status === "failed" ? "destructive" : "secondary"}
                    className="text-[10px]"
                  >
                    {d.status}
                  </Badge>
                  {d.url && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => window.open(d.url, "_blank")}>
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
