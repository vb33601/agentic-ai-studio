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
  opts: { name?: string } = {}
): Promise<DeployResult> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not configured on the server.");
  if (files.length === 0) throw new Error("No files to deploy.");

  const name = projectName(opts.name);
  const body = {
    name,
    files: files.map((f) => ({ file: f.path, data: f.content })),
    projectSettings: { framework: detectFramework(files) },
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
