import type { WorkspaceFile } from "@/store/workspace";
import { slugify } from "@/lib/utils";

const VERCEL_API = "https://api.vercel.com";

export interface DeployResult {
  id: string;
  url: string;
  inspectorUrl?: string;
  readyState?: string;
}

/** Infer the Vercel framework preset from package.json dependencies. */
function detectFramework(files: WorkspaceFile[]): string | null {
  const pkgFile = files.find((f) => f.name === "package.json");
  if (!pkgFile) return null; // static site
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(pkgFile.content);
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return null;
  }
  if (deps["next"]) return "nextjs";
  if (deps["@sveltejs/kit"]) return "sveltekit";
  if (deps["nuxt"]) return "nuxtjs";
  if (deps["@angular/core"]) return "angular";
  if (deps["react-scripts"]) return "create-react-app";
  if (deps["gatsby"]) return "gatsby";
  if (deps["astro"]) return "astro";
  if (deps["vite"]) return "vite";
  return null;
}

function projectName(name?: string): string {
  const base = slugify(name || "ai-app") || "ai-app";
  return base.slice(0, 90);
}

/** Create a production deployment from inline workspace files. */
export async function deployToVercel(
  files: WorkspaceFile[],
  opts: { name?: string; framework?: string | null; buildCommand?: string; outputDirectory?: string; rootDirectory?: string } = {}
): Promise<DeployResult> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not configured on the server.");
  if (files.length === 0) throw new Error("No files to deploy.");

  const name = projectName(opts.name);
  const projectSettings: Record<string, unknown> = {
    framework: opts.framework !== undefined ? opts.framework : detectFramework(files),
  };
  if (opts.buildCommand) projectSettings.buildCommand = opts.buildCommand;
  if (opts.outputDirectory) projectSettings.outputDirectory = opts.outputDirectory;
  // Build from the app's subdirectory (e.g. "frontend") when it isn't at root.
  if (opts.rootDirectory) projectSettings.rootDirectory = opts.rootDirectory;
  const body = {
    name,
    files: files.map((f) => ({ file: f.path, data: f.content })),
    projectSettings,
    target: "production",
  };

  const res = await fetch(`${VERCEL_API}/v13/deployments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Vercel API error (${res.status})`);
  }

  // Opt-in: make the deployment publicly viewable by disabling Vercel's
  // Deployment Protection (SSO). Off by default; enable with
  // VERCEL_PUBLIC_DEPLOYMENTS=true. Best-effort — never fails the deploy.
  if (process.env.VERCEL_PUBLIC_DEPLOYMENTS === "true") {
    await setProjectPublic(name, token).catch((e) =>
      console.warn("[deploy] could not disable deployment protection:", e?.message)
    );
  }

  return {
    id: data.id,
    url: data.url ? `https://${data.url}` : "",
    inspectorUrl: data.inspectorUrl,
    readyState: data.readyState || data.status,
  };
}

/** Disable Deployment Protection so the public URL is viewable without login. */
async function setProjectPublic(nameOrId: string, token: string): Promise<void> {
  const res = await fetch(`${VERCEL_API}/v9/projects/${encodeURIComponent(nameOrId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ssoProtection: null }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Vercel API error (${res.status})`);
  }
}

/** Poll the readiness of an existing deployment. */
export async function getDeploymentStatus(id: string): Promise<{ readyState: string; url?: string }> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not configured on the server.");
  const res = await fetch(`${VERCEL_API}/v13/deployments/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Vercel API error (${res.status})`);
  return { readyState: data.readyState || data.status, url: data.url ? `https://${data.url}` : undefined };
}

/**
 * Fetch the build log lines for a deployment, so a failed build shows the REAL
 * cause (e.g. "Could not resolve …", an ETARGET install error) instead of a bare
 * "build failed". Returns the tail of the build output, prioritizing the error
 * lines. Best-effort: returns [] if the events can't be read.
 */
export async function getDeploymentBuildLogs(id: string, limit = 40): Promise<string[]> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return [];
  try {
    // Build/output events for the deployment (newest builds support v3).
    const res = await fetch(`${VERCEL_API}/v3/deployments/${id}/events?builds=1&direction=backward&limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const events: Array<Record<string, unknown>> = Array.isArray(data)
      ? data
      : Array.isArray(data?.events)
        ? data.events
        : [];
    const lines: string[] = [];
    for (const ev of events) {
      const type = ev.type as string | undefined;
      if (type !== "stdout" && type !== "stderr" && type !== "command" && type !== "error") continue;
      const payload = ev.payload as { text?: string } | undefined;
      const text = (payload?.text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd(); // strip ANSI
      if (text) lines.push(text);
    }
    // Events come back newest-first (direction=backward); restore chronological order.
    lines.reverse();
    // Prefer lines that look like real errors when there are many.
    const errorLines = lines.filter((l) => /error|could not resolve|failed|ETARGET|ENOENT|cannot find|exited with/i.test(l));
    const picked = (errorLines.length ? errorLines : lines).slice(-limit);
    return picked;
  } catch {
    return [];
  }
}
