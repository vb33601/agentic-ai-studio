/**
 * Render API client — create a web service from a GitHub repo. Used to deploy a
 * generated backend (Render builds from the repo, not inline files).
 *
 * Server-only: requires RENDER_API_KEY.
 */

import { requireServerToken } from "./env";

const API = "https://api.render.com/v1";

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface CreateServiceInput {
  name: string;
  repo: string;
  branch: string;
  envVars: RenderEnvVar[];
  region?: string;
  plan?: string;
  /**
   * "node" (native, default) builds with build/start commands; "docker" builds
   * the repo's Dockerfile — the universal path for any language Render has no
   * native runtime for (Python/Django, Rails, Spring, PHP, Go, Rust, …).
   */
  runtime?: "node" | "docker";
  /** Native runtime (runtime !== "docker"). */
  buildCommand?: string;
  startCommand?: string;
  /** Docker runtime (runtime === "docker"). */
  dockerfilePath?: string;
  dockerContext?: string;
  /** Optional CMD override; "" uses the Dockerfile's own CMD. */
  dockerCommand?: string;
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

/**
 * Create a web service that builds & deploys from a GitHub repo. Supports both
 * Render's native Node runtime (build/start commands) and the universal Docker
 * runtime (builds the repo's Dockerfile) — the Render API `serviceDetails`
 * carries either `nativeEnvironmentDetails` (buildCommand/startCommand) or
 * `dockerDetails` (dockerfilePath/dockerContext/dockerCommand) under
 * `envSpecificDetails`, selected by `runtime`.
 */
export async function createRenderService(input: CreateServiceInput): Promise<RenderServiceResult> {
  const key = requireServerToken("RENDER_API_KEY");
  const ownerId = await getOwnerId(key);

  const isDocker = input.runtime === "docker";
  const envSpecificDetails = isDocker
    ? {
        dockerfilePath: input.dockerfilePath || "./Dockerfile",
        dockerContext: input.dockerContext || ".",
        dockerCommand: input.dockerCommand || "",
      }
    : {
        buildCommand: input.buildCommand || "npm install",
        startCommand: input.startCommand || "npm start",
      };

  const body = {
    type: "web_service",
    name: input.name,
    ownerId,
    repo: input.repo,
    branch: input.branch,
    autoDeploy: "yes",
    serviceDetails: {
      runtime: isDocker ? "docker" : "node",
      plan: input.plan || "free",
      region: input.region || "oregon",
      envSpecificDetails,
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