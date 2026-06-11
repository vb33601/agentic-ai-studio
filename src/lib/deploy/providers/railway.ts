import type { RenderEnvVar } from "../render";

/**
 * Railway provider client (GraphQL Public API).
 *
 * Railway builds ANY stack from a connected GitHub repo with Railpack
 * (zero-config: Node, Python, Go, PHP, Ruby, Rust, Java, .NET via Dockerfile,
 * static…), making it the universal non-Render target for frontend, backend, or
 * fullstack apps. This client:
 *  1. creates a project,
 *  2. creates a service from `owner/repo` (+ branch),
 *  3. upserts environment variables,
 *  4. generates a public domain,
 *  5. triggers a deploy.
 *
 * Server-only: requires RAILWAY_API_TOKEN. Endpoint + auth per Railway docs.
 */

const API = "https://backboard.railway.com/graphql/v2";

export interface RailwayDeployInput {
  /** "owner/name" of the GitHub repo Railway should build from. */
  repo: string;
  branch: string;
  name: string;
  envVars: RenderEnvVar[];
}

export interface RailwayDeployResult {
  url: string;
  dashboardUrl: string;
  projectId: string;
  serviceId: string;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error("RAILWAY_API_TOKEN is not configured on the server.");
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await res.text();
  let json: { data?: T; errors?: Array<{ message: string }> };
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Railway API returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 160)}`);
  }
  if (json.errors?.length) throw new Error(`Railway API: ${json.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  if (!res.ok) throw new Error(`Railway API HTTP ${res.status}: ${raw.slice(0, 160)}`);
  return json.data as T;
}

/** Deploy a GitHub repo to Railway end-to-end. */
export async function deployToRailway(input: RailwayDeployInput): Promise<RailwayDeployResult> {
  // 1) Project (returns its default environment).
  const proj = await gql<{ projectCreate: { id: string; environments: { edges: Array<{ node: { id: string } }> } } }>(
    `mutation($input: ProjectCreateInput!) {
       projectCreate(input: $input) { id environments { edges { node { id } } } }
     }`,
    { input: { name: input.name } },
  );
  const projectId = proj.projectCreate.id;
  const environmentId = proj.projectCreate.environments.edges[0]?.node.id;
  if (!environmentId) throw new Error("Railway project has no default environment.");

  // 2) Service from the GitHub repo source.
  const svc = await gql<{ serviceCreate: { id: string } }>(
    `mutation($input: ServiceCreateInput!) {
       serviceCreate(input: $input) { id }
     }`,
    { input: { projectId, name: input.name, branch: input.branch, source: { repo: input.repo } } },
  );
  const serviceId = svc.serviceCreate.id;

  // 3) Environment variables (batch upsert).
  if (input.envVars.length) {
    const variables: Record<string, string> = {};
    for (const v of input.envVars) variables[v.key] = v.value;
    await gql(
      `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
      { input: { projectId, environmentId, serviceId, variables } },
    );
  }

  // 4) Public domain.
  let domain = "";
  try {
    const dom = await gql<{ serviceDomainCreate: { domain: string } }>(
      `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { environmentId, serviceId } },
    );
    domain = dom.serviceDomainCreate.domain;
  } catch {
    /* domain generation can lag service creation; non-fatal */
  }

  // 5) Trigger the first deploy.
  try {
    await gql(
      `mutation($serviceId: String!, $environmentId: String!) {
         serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
       }`,
      { serviceId, environmentId },
    );
  } catch {
    /* serviceCreate from a repo often auto-deploys; ignore a redundant trigger */
  }

  return {
    url: domain ? `https://${domain}` : "",
    dashboardUrl: `https://railway.app/project/${projectId}`,
    projectId,
    serviceId,
  };
}
