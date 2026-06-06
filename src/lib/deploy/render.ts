/**
 * Render API client — create a web service from a GitHub repo. Used to deploy a
 * generated backend (Render builds from the repo, not inline files).
 *
 * Server-only: requires RENDER_API_KEY.
 */

const API = "https://api.render.com/v1";

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface CreateServiceInput {
  name: string;
  repo: string;
  branch: string;
  buildCommand: string;
  startCommand: string;
  envVars: RenderEnvVar[];
  region?: string;
  plan?: string;
}

export interface RenderServiceResult {
  id: string;
  url: string;
  dashboardUrl: string;
  deployId?: string;
}

async function getOwnerId(key: string): Promise<string> {
  const res = await fetch(`${API}/owners?limit=1`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Render /owners → ${res.status}`);
  const owner = data?.[0]?.owner?.id;
  if (!owner) throw new Error("No Render owner/workspace found for this API key.");
  return owner;
}

/** Create a Node web service that builds & deploys from a GitHub repo. */
export async function createRenderService(input: CreateServiceInput): Promise<RenderServiceResult> {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error("RENDER_API_KEY is not configured on the server.");
  const ownerId = await getOwnerId(key);

  const body = {
    type: "web_service",
    name: input.name,
    ownerId,
    repo: input.repo,
    branch: input.branch,
    autoDeploy: "yes",
    serviceDetails: {
      runtime: "node",
      plan: input.plan || "free",
      region: input.region || "oregon",
      envSpecificDetails: {
        buildCommand: input.buildCommand,
        startCommand: input.startCommand,
      },
    },
    envVars: input.envVars,
  };

  const res = await fetch(`${API}/services`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Render create service → ${res.status}: ${data.message || JSON.stringify(data)}`.slice(0, 300));

  const svc = data.service ?? data;
  return {
    id: svc.id,
    url: svc.serviceDetails?.url || `https://${svc.slug}.onrender.com`,
    dashboardUrl: svc.dashboardUrl || `https://dashboard.render.com/web/${svc.id}`,
    deployId: data.deployId,
  };
}
