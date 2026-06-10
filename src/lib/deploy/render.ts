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

/**
 * Read a Render API response without throwing the opaque "Unexpected end of
 * JSON input" when the body is empty or non-JSON (Render returns those for some
 * rate-limit / quota / gateway errors). Returns the parsed object plus the raw
 * text so callers can build an actionable message.
 */
async function readBody(res: Response): Promise<{ data: Record<string, unknown>; raw: string }> {
  const raw = await res.text();
  try {
    return { data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, raw };
  } catch {
    return { data: {}, raw };
  }
}

async function getOwnerId(key: string): Promise<string> {
  const res = await fetch(`${API}/owners?limit=1`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Render /owners → ${res.status}: ${raw.slice(0, 160) || "empty response"}`);
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("Render /owners returned a non-JSON response — check RENDER_API_KEY.");
  }
  const owner = Array.isArray(data) ? (data[0] as { owner?: { id?: string } } | undefined)?.owner?.id : undefined;
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
  const { data, raw } = await readBody(res);
  if (!res.ok) {
    const detail = (data.message as string) || (data.error as string) || raw.replace(/<[^>]+>/g, " ").trim().slice(0, 160) || `HTTP ${res.status}`;
    // 402/429 (or a quota message) on Render usually means the account's
    // free-instance limit is reached — the most common cause here.
    const limitHit = res.status === 402 || res.status === 429 || /limit|quota|maximum|too many/i.test(detail);
    const hint = limitHit
      ? " You've likely reached your Render free-tier service limit — delete unused services at https://dashboard.render.com, then redeploy."
      : "";
    throw new Error(`Render couldn't create the service (HTTP ${res.status}): ${detail}.${hint}`.slice(0, 400));
  }

  const svc = (data.service ?? data) as {
    id?: string; slug?: string; dashboardUrl?: string; serviceDetails?: { url?: string };
  };
  return {
    id: svc.id ?? "",
    url: svc.serviceDetails?.url || `https://${svc.slug}.onrender.com`,
    dashboardUrl: svc.dashboardUrl || `https://dashboard.render.com/web/${svc.id}`,
    deployId: data.deployId as string | undefined,
  };
}

/**
 * Set (upsert) environment variables on an existing service and trigger a fresh
 * deploy so they take effect. Used to wire the backend's CORS_ORIGIN/FRONTEND_URL
 * to the frontend's real Vercel URL once it's known (the frontend deploys after
 * the backend, so the URL isn't available at service-creation time).
 *
 * Best-effort: returns false (never throws) so a wiring hiccup can't fail an
 * otherwise-successful deploy.
 */
export async function updateRenderEnvVars(serviceId: string, vars: RenderEnvVar[]): Promise<boolean> {
  const key = process.env.RENDER_API_KEY;
  if (!key || !serviceId || vars.length === 0) return false;
  try {
    for (const v of vars) {
      const res = await fetch(`${API}/services/${serviceId}/env-vars/${encodeURIComponent(v.key)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ value: v.value }),
      });
      if (!res.ok) return false;
    }
    // Env-var changes don't always auto-redeploy; trigger one explicitly.
    await fetch(`${API}/services/${serviceId}/deploys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clearCache: "do_not_clear" }),
    });
    return true;
  } catch {
    return false;
  }
}
