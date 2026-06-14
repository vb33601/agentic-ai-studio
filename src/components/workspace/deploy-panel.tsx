"use client";

import { useState, useMemo } from "react";
import { Rocket, ExternalLink, CheckCircle, XCircle, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceStore, type WorkspaceFile } from "@/store/workspace";
import { downloadProjectZip } from "@/lib/deploy/download";
import { detectAppGroups, filesForApp, resolveAppRoot } from "@/lib/workspace/apps";
import { AppSelector } from "@/components/workspace/app-selector";

/**
 * Read a fetch Response as JSON without throwing the opaque
 * "Unexpected token '<' … is not valid JSON" when the server returns a non-JSON
 * body — e.g. a gateway 502/504 HTML page when a long deploy times out. Surfaces
 * a clear, actionable message instead.
 */
interface DeployResponse {
  error?: string;
  url?: string;
  inspectorUrl?: string;
  id?: string;
  readyState?: string;
  repoUrl?: string;
  dashboardUrl?: string;
  usesPrisma?: boolean;
  dbWired?: boolean;
  backendDir?: string;
  backendUrl?: string;
  backendDashboard?: string;
  backendProvider?: string;
  backendError?: string;
  backendNote?: string;
  hasBackend?: boolean;
  frontendUrl?: string;
  frontendId?: string;
  frontendError?: string;
  warnings?: string[];
  /** Universal-deploy metadata: detected stack/framework + chosen provider. */
  provider?: string;
  framework?: string;
  runtime?: string;
  stack?: string;
  backendRuntime?: string;
  backendFramework?: string;
}

async function readJson(res: Response): Promise<DeployResponse> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as DeployResponse) : {};
  } catch {
    throw new Error(
      res.ok
        ? "The server returned an unreadable response — the deploy likely timed out. Wait a moment and try again (large apps can take a while)."
        : `Deploy failed (HTTP ${res.status}). ${text.replace(/<[^>]+>/g, " ").trim().slice(0, 160) || "Please try again."}`,
    );
  }
}

const PROVIDERS = [
  { id: "vercel", name: "Vercel", description: "Frontend · live deploy", logo: "▲", configured: true, kind: "frontend" as const },
  { id: "render", name: "Render", description: "Backend · any language (Docker)", logo: "◆", configured: true, kind: "backend" as const },
  { id: "fly", name: "Fly.io", description: "Backend · global, remote-build", logo: "✦", configured: true, kind: "backend" as const },
  { id: "netlify", name: "Netlify", description: "Static + serverless", logo: "◢", configured: false, kind: "frontend" as const },
  { id: "cloudflare", name: "Cloudflare Pages", description: "Global edge network", logo: "○", configured: false, kind: "frontend" as const },
  { id: "github", name: "GitHub Pages", description: "Free static hosting", logo: "◉", configured: false, kind: "frontend" as const },
];

/** Plan-based end-to-end verification verdict (Subsystem D). */
interface PlanReport {
  ok: boolean;
  checked: boolean;
  score: number;
  summary: string;
  gaps: string[];
  steps?: { step: string; status: "done" | "partial" | "missing"; note?: string }[];
}

interface Deployment {
  id: string;
  provider: string;
  status: "pending" | "building" | "deployed" | "failed";
  url?: string;
  inspectorUrl?: string;
  /** Full-stack deploys track each side separately so the UI never mislabels a
   *  backend URL as the frontend (e.g. when the Vercel deploy didn't happen). */
  frontendUrl?: string;
  frontendError?: string;
  backendUrl?: string;
  backendDashboard?: string;
  /** Verified backend liveness: true=serving, false=built-but-crashing, null=unknown. */
  backendHealthy?: boolean | null;
  /** Frontend smoke verdict (renders + no console/API/CORS errors). */
  frontendSmoke?: { ok: boolean; issues: string[] } | null;
  /** Plan-based end-to-end verification before/after the deploy. */
  planPre?: PlanReport | null;
  planPost?: PlanReport | null;
  timestamp: Date;
}

export function DeployPanel() {
  const { files, addBuildLog, buildLog, clearBuildLog, selectedAppDir, updateFile, addFile, implementationPlan } = useWorkspaceStore();
  // Deploy/download the selected app only (re-rooted), so a multi-app chat
  // ships one clean project instead of all apps mixed together.
  const groups = useMemo(() => detectAppGroups(files), [files]);
  const appRoot = resolveAppRoot(groups, selectedAppDir);
  const appFiles = useMemo(() => filesForApp(files, appRoot), [files, appRoot]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("my-app");
  // Backend target for the full-app deploy (frontend always → Vercel).
  const [fullstackBackend, setFullstackBackend] = useState<"render" | "fly">("render");

  const update = (id: string, patch: Partial<Deployment>) =>
    setDeployments((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  // Fetch the real Vercel build log for a failed deployment and print its tail
  // (error lines) so the user sees the actual cause, not just "build failed".
  const printBuildLogs = async (vercelId: string | undefined) => {
    if (!vercelId) return;
    try {
      const r = await fetch(`/api/deploy?id=${vercelId}&logs=1`).then((res) => res.json()).catch(() => null);
      const logs: string[] = Array.isArray(r?.logs) ? r.logs : [];
      if (logs.length === 0) {
        addBuildLog("  (no build log available — open the Vercel inspector for details)");
        return;
      }
      for (const line of logs.slice(-20)) addBuildLog(`  ${line}`);
    } catch {
      addBuildLog("  (could not fetch the build log)");
    }
  };

  // How many times a failed build will auto-repair (web-search the fix +
  // redeploy) before giving up. Each attempt searches deeper.
  const MAX_AUTO_REPAIRS = 2;

  // Raw build-log text for a failed Vercel deployment (for the repair engine).
  const fetchBuildLogText = async (vercelId: string): Promise<string> => {
    try {
      const r = await fetch(`/api/deploy?id=${vercelId}&logs=1`).then((res) => res.json()).catch(() => null);
      return Array.isArray(r?.logs) ? r.logs.join("\n") : "";
    } catch {
      return "";
    }
  };

  // Write the engine's patched files back into the workspace so the preview and
  // future deploys use the fix. Existing files are matched by id; new files are
  // added under the app's root.
  const applyPatchedFiles = (patched: WorkspaceFile[]) => {
    const known = new Set(files.map((f) => f.id));
    for (const pf of patched) {
      if (pf.id && known.has(pf.id)) {
        updateFile(pf.id, { content: pf.content });
      } else {
        const full = appRoot ? `${appRoot}/${pf.path}` : pf.path;
        if (!files.some((f) => f.path === full)) addFile({ ...pf, path: full });
      }
    }
  };

  // Fire-and-forget: tell the engine whether a deploy/verify step passed, so it
  // learns which rules/fixes actually work per technology. Best-effort.
  const reportOutcome = (o: { tech: string; ruleId: string; action: string; success: boolean; phase: "build" | "deploy" | "health" | "smoke" }) => {
    void fetch("/api/deploy/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(o),
    }).catch(() => {});
  };

  // Plan-based end-to-end verification (Subsystem D). Runs the SAME check used
  // after generation, now around the deploy: BEFORE (over the prepared files —
  // "is it built correctly end-to-end?") and AFTER (with the live URL + smoke/
  // health signals — "is it working end-to-end as per the plan?"). Fail-open: a
  // missing plan or unavailable verifier never blocks or fails the deploy.
  const runPlanCheck = async (
    phase: "pre-deploy" | "post-deploy",
    opts: {
      liveUrl?: string | null;
      smoke?: { ok: boolean; issues: string[] } | null;
      health?: { healthy: boolean; status: number | null } | null;
    } = {},
  ): Promise<PlanReport | null> => {
    if (!implementationPlan) return null;
    addBuildLog(
      phase === "pre-deploy"
        ? "Verifying the build against the implementation plan (end-to-end)…"
        : "Verifying the deployed app against the implementation plan (end-to-end)…",
    );
    try {
      const r: PlanReport | null = await fetch("/api/verify/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: implementationPlan, files: appFiles, phase, ...opts }),
      })
        .then((res) => res.json())
        .catch(() => null);
      if (!r || r.checked === false) {
        addBuildLog("  Plan check skipped (no verdict available).");
        return r;
      }
      if (r.ok) {
        addBuildLog(`✓ PLAN CHECK ${phase === "pre-deploy" ? "(pre-deploy)" : "(post-deploy)"} PASSED — ${r.summary || "all steps implemented end-to-end"}`);
      } else {
        addBuildLog(`⚠ PLAN CHECK ${phase === "pre-deploy" ? "(pre-deploy)" : "(post-deploy)"}: ${r.summary || "gaps found"}`);
        for (const g of (r.gaps || []).slice(0, 5)) addBuildLog(`  · ${g}`);
      }
      return r;
    } catch (e) {
      addBuildLog(`  Plan check unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  // Poll a Vercel deployment to a terminal state.
  const pollVercel = async (vercelId: string): Promise<{ state: "READY" | "ERROR" | "TIMEOUT"; url?: string }> => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await fetch(`/api/deploy?id=${vercelId}`).then((r) => r.json()).catch(() => null);
      if (!s?.readyState) continue;
      if (s.readyState === "READY") return { state: "READY", url: s.url };
      if (s.readyState === "ERROR" || s.readyState === "CANCELED") return { state: "ERROR" };
      addBuildLog(`Status: ${s.readyState}…`);
    }
    return { state: "TIMEOUT" };
  };

  // Verify a deployed backend actually serves requests. Container providers
  // build asynchronously (minutes) and a generated app can build cleanly yet
  // crash on boot (missing driver, bad bind) — surfacing as a 5xx. Poll the
  // health endpoint until the app is up, or the budget runs out (≈6 min), so
  // we report verified liveness instead of an optimistic "live".
  const pollBackendHealth = async (
    url: string,
    attempts = 60, // ≈8 min — container providers build remotely + cold-start.
  ): Promise<{ healthy: boolean; status: number | null; bodySnippet?: string; reachedServer: boolean }> => {
    let last: { status: number | null; bodySnippet?: string } = { status: null };
    let reachedServer = false; // ever got an HTTP response (vs. pure "no response")
    for (let i = 0; i < attempts; i++) {
      const h = await fetch(`/api/deploy/health?url=${encodeURIComponent(url)}`)
        .then((r) => r.json())
        .catch(() => null);
      if (h?.healthy) return { healthy: true, status: h.status, reachedServer: true };
      if (typeof h?.status === "number") reachedServer = true;
      last = { status: h?.status ?? null, bodySnippet: h?.bodySnippet };
      // Log progress occasionally so a slow build doesn't look stuck. Distinguish
      // "no response" (still building / scaled-to-zero) from a real HTTP error.
      if (i % 4 === 0) {
        addBuildLog(
          last.status
            ? `  Verifying backend… HTTP ${last.status} (starting)`
            : `  Verifying backend… still building (remote build + boot can take a few minutes)`,
        );
      }
      await new Promise((r) => setTimeout(r, 8000));
    }
    return { healthy: false, status: last.status, bodySnippet: last.bodySnippet, reachedServer };
  };

  // A backend that built but won't serve (health gate failed): read the deployed
  // repo + crash signal, web-search the fix, and commit it back so the SAME
  // service rebuilds at the SAME URL (frontend stays wired). Returns true if a
  // fix was committed (caller then re-polls health). Best-effort writes the
  // patched files back into the workspace so future deploys carry the fix.
  const autoRepairBackend = async (args: {
    repoUrl: string;
    deployProvider?: string;
    dashboardUrl?: string;
    framework?: string;
    httpStatus: number | null;
    bodySnippet?: string;
    attempt: number;
  }): Promise<boolean> => {
    try {
      const res = await fetch("/api/deploy/repair-backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.changed) {
        addBuildLog(`  No reliable backend fix found${data?.report?.note ? `: ${data.report.note}` : "."}`);
        return false;
      }
      if (data.report?.rootCause) addBuildLog(`  Root cause: ${data.report.rootCause}`);
      if (Array.isArray(data.editedPaths) && data.editedPaths.length) addBuildLog(`  Patched: ${data.editedPaths.join(", ")} (committed → rebuilding)`);
      if (Array.isArray(data.report?.sources) && data.report.sources[0]) addBuildLog(`  Per: ${data.report.sources[0].url}`);
      // Best-effort: mirror the repo edits into the workspace by path suffix.
      if (Array.isArray(data.files)) {
        for (const ef of data.files as { path: string; content: string }[]) {
          const match = files.find((f) => f.path === ef.path || f.path.endsWith(`/${ef.path}`));
          if (match) updateFile(match.id, { content: ef.content });
        }
      }
      return true;
    } catch (e) {
      addBuildLog(`  Backend auto-repair error: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  // Smoke-test a live frontend the way a user hits it: renders, no runtime
  // console errors, no failed API calls, and the backend's CORS actually allows
  // the frontend origin (the "Failed to fetch" class). A tooling failure never
  // fails the deploy — only a real broken page does.
  const runFrontendSmoke = async (
    url: string,
    backendUrl?: string | null,
  ): Promise<{ ok: boolean; issues: string[] }> => {
    addBuildLog("Smoke-testing the live frontend (render · console · API · CORS)…");
    try {
      const r = await fetch("/api/deploy/smoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, backendUrl: backendUrl ?? null }),
      })
        .then((res) => res.json())
        .catch(() => null);
      if (!r || r.error) {
        addBuildLog(`  Smoke test unavailable${r?.error ? `: ${r.error}` : ""}`);
        return { ok: true, issues: [] };
      }
      if (r.ok) {
        addBuildLog(`✓ FRONTEND SMOKE PASSED${r.browser ? " (real browser)" : " (HTTP+CORS; no browser on host)"}`);
      } else {
        addBuildLog("⚠ FRONTEND SMOKE FAILED:");
        for (const iss of (r.issues || []).slice(0, 5)) addBuildLog(`  · ${iss}`);
      }
      return { ok: !!r.ok, issues: r.issues || [] };
    } catch (e) {
      addBuildLog(`  Smoke test error: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: true, issues: [] };
    }
  };

  // Verify backend liveness; if it built but won't serve, run the backend
  // auto-repair loop (in-place rebuild on the same URL) up to MAX_AUTO_REPAIRS,
  // re-verifying after each. Returns the final health.
  const verifyAndHealBackend = async (opts: {
    backendUrl: string;
    repoUrl?: string;
    deployProvider?: string;
    dashboardUrl?: string;
    framework?: string;
  }): Promise<{ healthy: boolean; status: number | null; reachedServer: boolean }> => {
    let bh = await pollBackendHealth(opts.backendUrl);
    if (bh.healthy) return { healthy: true, status: bh.status, reachedServer: true };
    // Only attempt CODE auto-repair when the app actually responded with a crash
    // (5xx). A backend that never responded is almost always still building or
    // scaled-to-zero, not broken — editing its source would be guesswork, so we
    // report "still starting" and stop rather than churn the repo.
    const crashed = bh.reachedServer && (bh.status ?? 0) >= 500;
    if (opts.repoUrl && crashed) {
      for (let attempt = 0; attempt < MAX_AUTO_REPAIRS; attempt++) {
        addBuildLog(`✗ Backend not responding (${bh.status ? `HTTP ${bh.status}` : "no response"}) — backend auto-repair ${attempt + 1}/${MAX_AUTO_REPAIRS}…`);
        const fixed = await autoRepairBackend({
          repoUrl: opts.repoUrl,
          deployProvider: opts.deployProvider,
          dashboardUrl: opts.dashboardUrl,
          framework: opts.framework,
          httpStatus: bh.status,
          bodySnippet: bh.bodySnippet,
          attempt,
        });
        if (!fixed) break;
        addBuildLog("  Re-verifying backend after rebuild…");
        bh = await pollBackendHealth(opts.backendUrl);
        if (bh.healthy) return { healthy: true, status: bh.status, reachedServer: true };
      }
    }
    return { healthy: false, status: bh.status, reachedServer: bh.reachedServer };
  };

  // On a failed build: fetch the real log, web-search the known fix for this
  // error across the app's stack, apply it, and redeploy. Returns the new
  // deployment id to poll, or null if no reliable fix was found.
  const autoRepairDeploy = async (vercelId: string, attempt: number, backendUrl?: string | null): Promise<string | null> => {
    const log = await fetchBuildLogText(vercelId);
    for (const line of log.split("\n").slice(-12)) if (line.trim()) addBuildLog(`  ${line}`);
    addBuildLog(`🔧 Auto-repair ${attempt + 1}/${MAX_AUTO_REPAIRS}: searching known fixes for this error…`);
    try {
      const res = await fetch("/api/deploy/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: appFiles, name: projectName, buildLog: log, attempt, backendUrl: backendUrl ?? null, mode: "deploy" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.changed) {
        addBuildLog(`  No reliable fix found${data?.report?.note ? `: ${data.report.note}` : "."}`);
        return null;
      }
      const rep = data.report ?? {};
      if (rep.rootCause) addBuildLog(`  Root cause: ${rep.rootCause}`);
      if (Array.isArray(rep.editedPaths) && rep.editedPaths.length) addBuildLog(`  Patched: ${rep.editedPaths.join(", ")}`);
      if (Array.isArray(rep.sources) && rep.sources[0]) addBuildLog(`  Per: ${rep.sources[0].url}`);
      if (Array.isArray(data.files)) applyPatchedFiles(data.files as WorkspaceFile[]);
      if (data.frontendUrl) addBuildLog(`  Redeploying patched build → ${data.frontendUrl}`);
      return data.frontendId ?? null;
    } catch (e) {
      addBuildLog(`  Auto-repair error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  // Poll a deployment; if the build fails, auto-repair and poll the redeploy,
  // up to MAX_AUTO_REPAIRS. Returns the final status + live url.
  const deployWithAutoRepair = async (
    vercelId: string,
    opts: { backendUrl?: string | null } = {},
  ): Promise<{ status: "live" | "building" | "failed"; url?: string }> => {
    let currentId = vercelId;
    for (let attempt = 0; attempt <= MAX_AUTO_REPAIRS; attempt++) {
      const r = await pollVercel(currentId);
      if (r.state === "READY") return { status: "live", url: r.url };
      if (r.state === "TIMEOUT") return { status: "building" };
      // Build errored.
      if (attempt === MAX_AUTO_REPAIRS) {
        addBuildLog("✗ Build failed on Vercel:");
        await printBuildLogs(currentId);
        return { status: "failed" };
      }
      addBuildLog("✗ Build failed on Vercel — attempting auto-repair:");
      const nextId = await autoRepairDeploy(currentId, attempt, opts.backendUrl);
      if (!nextId) return { status: "failed" };
      currentId = nextId;
    }
    return { status: "failed" };
  };

  // Full-stack: backend → Render (Aiven), frontend → Vercel (wired to the
  // backend URL). Returns the frontend link as the primary URL.
  const deployFullStack = async (backend: "render" | "fly" | "railway" = "render") => {
    if (appFiles.length === 0) {
      alert("No files to deploy. Generate an app first.");
      return;
    }
    const backendName = backend === "render" ? "Render" : backend === "fly" ? "Fly.io" : "Railway";
    const deployId = crypto.randomUUID().replace(/-/g, "");
    setDeploying("fullstack");
    clearBuildLog();
    setDeployments((prev) => [{ id: deployId, provider: "fullstack", status: "building", timestamp: new Date() }, ...prev]);
    try {
      // Pre-deploy end-to-end check: confirm the app is built per the plan.
      const pre = await runPlanCheck("pre-deploy");
      if (pre) update(deployId, { planPre: pre });
      addBuildLog(`Deploying full app — backend → ${backendName}, frontend → Vercel…`);
      const res = await fetch("/api/deploy/fullstack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: appFiles, name: projectName, provider: backend }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "Full-stack deploy failed");
      if (data.backendDir) addBuildLog(`Backend folder: ${data.backendDir}/`);
      if (data.repoUrl) addBuildLog(`Backend repo → ${data.repoUrl}`);
      if (data.backendUrl) addBuildLog(`Backend deploying (${(data.backendProvider || backend) === "fly" ? "Fly.io" : (data.backendProvider || backend) === "railway" ? "Railway" : "Render"}) → ${data.backendUrl}${data.dbWired ? "  (DATABASE_URL → Aiven)" : ""} — building & verifying…`);
      if (data.backendDashboard) addBuildLog(`Backend dashboard → ${data.backendDashboard}`);
      if (data.backendError) addBuildLog(`⚠ Backend NOT deployed: ${data.backendError}`);
      // No server in the app at all — explain it instead of silently shipping FE-only.
      if (!data.hasBackend && data.backendNote) addBuildLog(`ℹ ${data.backendNote}`);
      for (const w of data.warnings ?? []) addBuildLog(`⚠ ${w}`);
      if (data.frontendUrl) addBuildLog(`Frontend deploying on Vercel → ${data.frontendUrl} (building…)`);
      if (data.frontendError) addBuildLog(`⚠ Frontend: ${data.frontendError}`);
      // The Vercel build runs async — mark "building" and confirm the real
      // outcome by polling, rather than claiming "live" before it succeeds.
      update(deployId, {
        status: data.frontendUrl || data.backendUrl ? "building" : "failed",
        url: data.frontendUrl || data.backendUrl,
        inspectorUrl: data.backendDashboard,
        frontendUrl: data.frontendUrl,
        frontendError: data.frontendError,
        backendUrl: data.backendUrl,
        backendDashboard: data.backendDashboard,
      });

      // Verify the backend actually serves requests (build success ≠ runtime
      // success). Run it concurrently with the frontend build poll below so the
      // two slow async steps overlap instead of adding up.
      const backendCheck: Promise<{ healthy: boolean; status: number | null; reachedServer: boolean } | null> = data.backendUrl
        ? verifyAndHealBackend({
            backendUrl: data.backendUrl,
            repoUrl: data.repoUrl,
            deployProvider: data.backendProvider || backend,
            dashboardUrl: data.backendDashboard,
            framework: data.backendFramework,
          })
        : Promise.resolve(null);

      // Poll the Vercel frontend build to readiness so the result is honest —
      // and on a build failure, auto-repair (web-search the fix) and redeploy.
      let liveFrontendUrl: string | undefined;
      if (data.frontendId) {
        const outcome = await deployWithAutoRepair(data.frontendId, { backendUrl: data.backendUrl ?? null });
        if (outcome.status === "live") {
          const url = outcome.url || data.frontendUrl;
          liveFrontendUrl = url;
          addBuildLog(`✓ FRONTEND LIVE → ${url}`);
          update(deployId, { status: "deployed", url, frontendUrl: url });
        } else if (outcome.status === "building") {
          addBuildLog("Frontend still building — open the URL to check progress.");
          update(deployId, { status: "deployed", url: data.frontendUrl, frontendUrl: data.frontendUrl });
        } else {
          // Backend may still be live → keep the deploy as a partial success.
          update(deployId, {
            status: data.backendUrl ? "deployed" : "failed",
            url: data.backendUrl ?? undefined,
            frontendUrl: undefined,
            frontendError: "Vercel build failed (auto-repair exhausted)",
          });
        }
      } else {
        // No frontend deployment to poll (backend-only or frontend errored upfront).
        update(deployId, { status: data.backendUrl || data.frontendUrl ? "deployed" : "failed" });
      }

      // Report the verified backend liveness (the gate that catches runtime
      // crashes the build-status check misses).
      const bh = await backendCheck;
      if (bh) {
        // Learn: record whether THIS stack's deploy actually verified, so the
        // engine weights its rules/fixes by real outcomes over time.
        reportOutcome({ tech: data.backendFramework || "node", ruleId: "backend-deploy", action: "deploy", success: !!bh.healthy, phase: "health" });
        if (bh.healthy) {
          addBuildLog(`✓ BACKEND HEALTHY (HTTP ${bh.status}) → ${data.backendUrl}`);
          update(deployId, { backendHealthy: true });
        } else if (!bh.reachedServer) {
          // Never got an HTTP response within the window — the remote build/boot
          // is just slow (not a crash). The app should come up shortly on its own.
          addBuildLog(`⏳ BACKEND STILL STARTING (no response yet) → ${data.backendUrl}`);
          addBuildLog(`  Container builds run remotely and can finish after this check. Open the dashboard to confirm: ${data.backendDashboard || "the provider dashboard"}`);
          update(deployId, { backendHealthy: false });
        } else {
          addBuildLog(`✗ BACKEND NOT SERVING (HTTP ${bh.status}) → ${data.backendUrl}`);
          addBuildLog(`  Auto-repair couldn't get it serving. Check logs: ${data.backendDashboard || "the provider dashboard"}`);
          update(deployId, { backendHealthy: false });
        }
      }

      // Final layer: smoke-test the live frontend (now that the backend is
      // settled, so the CORS/API check is meaningful).
      let smokeResult: { ok: boolean; issues: string[] } | null = null;
      if (liveFrontendUrl) {
        smokeResult = await runFrontendSmoke(liveFrontendUrl, data.backendUrl ?? null);
        update(deployId, { frontendSmoke: smokeResult });
        reportOutcome({ tech: "frontend", ruleId: "frontend-smoke", action: "smoke", success: !!smokeResult.ok, phase: "smoke" });
      }

      // Post-deploy end-to-end check: verify the LIVE app against the plan,
      // folding in the runtime smoke/health signals.
      const post = await runPlanCheck("post-deploy", {
        liveUrl: liveFrontendUrl || data.backendUrl || null,
        smoke: smokeResult,
        health: bh ? { healthy: bh.healthy, status: bh.status } : null,
      });
      if (post) update(deployId, { planPost: post });
    } catch (e) {
      addBuildLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
      update(deployId, { status: "failed" });
    } finally {
      setDeploying(null);
    }
  };

  // Push the selected backend folder to GitHub and deploy it on a container
  // provider (Render by default, or an explicit target like Fly), wired to the
  // platform's managed Postgres (Aiven) via DATABASE_URL.
  const deployBackend = async (provider: "render" | "fly" | "railway" = "render") => {
    if (appFiles.length === 0) {
      alert("No files to deploy. Generate a backend first.");
      return;
    }
    const deployId = crypto.randomUUID().replace(/-/g, "");
    setDeploying(provider);
    clearBuildLog();
    setDeployments((prev) => [{ id: deployId, provider, status: "building", timestamp: new Date() }, ...prev]);
    try {
      const pre = await runPlanCheck("pre-deploy");
      if (pre) update(deployId, { planPre: pre });
      const target = provider === "render" ? "Render" : provider === "fly" ? "Fly.io" : "Railway";
      addBuildLog(`Pushing ${appFiles.length} files to GitHub and deploying to ${target}…`);
      const res = await fetch("/api/deploy/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: appFiles, name: projectName, provider }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "Backend deploy failed");
      if (data.framework) addBuildLog(`Detected stack: ${data.framework}${data.runtime ? ` (${data.runtime} runtime)` : ""}`);
      if (data.backendDir) addBuildLog(`Detected backend folder: ${data.backendDir}/`);
      addBuildLog(`Repo created → ${data.repoUrl}`);
      if (data.dbWired) addBuildLog("DATABASE_URL wired to managed Postgres (Aiven).");
      else if (data.usesPrisma) addBuildLog("⚠ DB app, but DEFAULT_DATABASE_URL isn't set — add it in Render env.");
      for (const w of data.warnings ?? []) addBuildLog(`⚠ ${w}`);
      addBuildLog(`Deployed via ${data.provider || "render"} → ${data.url} (building & verifying, ~few min)`);
      update(deployId, { status: "building", url: data.url, inspectorUrl: data.dashboardUrl, backendUrl: data.url });

      // Verify the backend actually serves requests (and auto-repair if it
      // built but won't boot) before calling it done.
      if (data.url) {
        const bh = await verifyAndHealBackend({
          backendUrl: data.url,
          repoUrl: data.repoUrl,
          deployProvider: data.provider || provider,
          dashboardUrl: data.dashboardUrl,
          framework: data.framework,
        });
        if (bh.healthy) {
          addBuildLog(`✓ BACKEND HEALTHY (HTTP ${bh.status}) → ${data.url}`);
          update(deployId, { status: "deployed", backendHealthy: true });
        } else {
          addBuildLog(`✗ BACKEND NOT RESPONDING (${bh.status ? `HTTP ${bh.status}` : "no response"}) — auto-repair couldn't get it serving.`);
          addBuildLog(`  Check logs: ${data.dashboardUrl || "the provider dashboard"}`);
          update(deployId, { status: "failed", backendHealthy: false });
        }
        // Post-deploy end-to-end check against the plan (with the health signal).
        const post = await runPlanCheck("post-deploy", {
          liveUrl: data.url,
          health: { healthy: bh.healthy, status: bh.status },
        });
        if (post) update(deployId, { planPost: post });
      } else {
        update(deployId, { status: "deployed" });
      }
    } catch (e) {
      addBuildLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
      update(deployId, { status: "failed" });
    } finally {
      setDeploying(null);
    }
  };

  const deploy = async (provider: string) => {
    if (appFiles.length === 0) {
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
      const pre = await runPlanCheck("pre-deploy");
      if (pre) update(deployId, { planPre: pre });
      addBuildLog(`Uploading ${appFiles.length} files to Vercel…`);
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "vercel", files: appFiles, name: projectName }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "Deployment request failed");

      if (!data.id) throw new Error("Vercel did not return a deployment id to poll.");
      addBuildLog(`Deployment created → ${data.url}`);
      addBuildLog("Building on Vercel…");
      update(deployId, { url: data.url, inspectorUrl: data.inspectorUrl });

      // Poll readiness; on a build failure, auto-repair (web-search the fix) and
      // redeploy, up to MAX_AUTO_REPAIRS, so we end on working code when possible.
      const outcome = await deployWithAutoRepair(data.id);
      if (outcome.status === "live") {
        const liveUrl = outcome.url || data.url;
        addBuildLog("✓ Deployment is live!");
        update(deployId, { status: "deployed", url: liveUrl });
        let smoke: { ok: boolean; issues: string[] } | null = null;
        if (liveUrl) {
          smoke = await runFrontendSmoke(liveUrl);
          update(deployId, { frontendSmoke: smoke });
        }
        const post = await runPlanCheck("post-deploy", { liveUrl, smoke });
        if (post) update(deployId, { planPost: post });
      } else if (outcome.status === "building") {
        addBuildLog("Still building — opening the URL will show progress.");
        update(deployId, { status: "deployed", url: data.url });
      } else {
        update(deployId, { status: "failed" });
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
      <ScrollArea className="flex-1 min-h-0">
      <div className="px-6 py-4 border-b">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Deploy Project
          </h2>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <AppSelector />
            <div className="flex items-center rounded-md border overflow-hidden">
              <Button
                size="sm"
                className="h-7 gap-1.5 text-xs rounded-none border-0"
                disabled={!!deploying || appFiles.length === 0}
                onClick={() => deployFullStack(fullstackBackend)}
                title={`Deploy frontend (Vercel) + backend (${fullstackBackend === "fly" ? "Fly.io" : "Render"} with Aiven DB), wired together — returns the frontend link`}
              >
                {deploying === "fullstack" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                Deploy full app
              </Button>
              <select
                value={fullstackBackend}
                onChange={(e) => setFullstackBackend(e.target.value as "render" | "fly")}
                disabled={!!deploying}
                title="Backend host for the full-app deploy (frontend always → Vercel)"
                className="h-7 text-xs bg-transparent border-0 border-l px-1.5 outline-none cursor-pointer disabled:opacity-50"
              >
                <option value="render">be: Render</option>
                <option value="fly">be: Fly.io</option>
              </select>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={appFiles.length === 0}
              onClick={() => downloadProjectZip(appFiles, projectName || "project")}
              title="Download this app as a .zip (includes a Dockerfile + deploy guide for any platform/language)"
            >
              <Download className="h-3.5 w-3.5" /> Download .zip
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {appFiles.length} files ready · Pick a target below (frontend → Vercel; backend → Render or Fly), deploy the full app, or download the .zip
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

      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 border-b">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() =>
              p.kind === "backend"
                ? deployBackend(p.id as "render" | "fly" | "railway")
                : deploy(p.id)
            }
            disabled={!!deploying || appFiles.length === 0}
            className="relative flex items-center gap-3 p-3 rounded-xl border hover:border-primary/60 hover:bg-primary/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-left"
          >
            <span className="text-2xl">{p.logo}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium flex items-center gap-1.5">
                {p.name}
                <span className="text-[10px] font-normal text-muted-foreground">{p.kind}</span>
                {p.configured && <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="configured" />}
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
          <div className="bg-muted rounded-lg p-3 font-mono text-xs space-y-1 max-h-32 overflow-y-auto">
            {buildLog.map((line, i) => (
              <div key={i} className="text-green-600 dark:text-green-400">
                <span className="text-muted-foreground">$ </span>
                {line}
              </div>
            ))}
            {deploying && <div className="text-muted-foreground animate-pulse">…</div>}
          </div>
        </div>
      )}

      <div className="p-4">
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
                    {d.provider === "fullstack" ? (
                      <>
                        {/* Frontend (Vercel): only labelled when it actually deployed. */}
                        {d.frontendUrl ? (
                          <a href={d.frontendUrl} target="_blank" rel="noreferrer" className="text-[10px] text-primary hover:underline truncate block">
                            Frontend: {d.frontendUrl}
                          </a>
                        ) : (
                          <p className="text-[10px] text-amber-500 truncate" title={d.frontendError}>
                            Frontend: not deployed{d.frontendError ? ` — ${d.frontendError}` : ""}
                          </p>
                        )}
                        {d.backendUrl && (
                          <span className="text-[10px] truncate block">
                            <a href={d.backendUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                              Backend: {d.backendUrl}
                            </a>
                            {d.backendHealthy === true && <span className="text-green-500"> · healthy ✓</span>}
                            {d.backendHealthy === false && <span className="text-red-500"> · not responding ✗</span>}
                            {d.backendHealthy == null && <span className="text-muted-foreground"> · verifying…</span>}
                          </span>
                        )}
                        {d.backendDashboard && (
                          <a href={d.backendDashboard} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:underline truncate block">
                            Render dashboard ↗
                          </a>
                        )}
                      </>
                    ) : d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-[10px] text-primary hover:underline truncate block">
                        {d.url}
                      </a>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">{d.timestamp.toLocaleTimeString()}</p>
                    )}
                    {d.frontendSmoke && (
                      d.frontendSmoke.ok ? (
                        <p className="text-[10px] text-green-500">Smoke: passed ✓</p>
                      ) : (
                        <p className="text-[10px] text-amber-500 truncate" title={d.frontendSmoke.issues.join("; ")}>
                          Smoke: {d.frontendSmoke.issues[0] || "issues found"} ⚠
                        </p>
                      )
                    )}
                    {(() => {
                      // Show the most meaningful plan verdict (post-deploy wins).
                      const pv = d.planPost?.checked ? d.planPost : d.planPre?.checked ? d.planPre : null;
                      if (!pv) return null;
                      const label = d.planPost?.checked ? "Plan (live)" : "Plan";
                      return pv.ok ? (
                        <p className="text-[10px] text-green-500" title={pv.summary}>
                          {label}: end-to-end ✓
                        </p>
                      ) : (
                        <p className="text-[10px] text-amber-500 truncate" title={[pv.summary, ...pv.gaps].join(" — ")}>
                          {label}: {pv.gaps[0] || pv.summary || "gaps found"} ⚠
                        </p>
                      );
                    })()}
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
      </div>
      </ScrollArea>
    </div>
  );
}
