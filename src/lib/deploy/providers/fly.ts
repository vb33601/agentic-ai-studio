import { createRequire } from "node:module";
import type _SodiumType from "libsodium-wrappers";
import { gh, commitFilesToRepo, type RepoFile } from "../github";
import type { RenderEnvVar } from "../render";
import { requireServerToken } from "../env";

// libsodium-wrappers ships a broken ESM build (its dist/modules-esm dir is
// missing libsodium.mjs), so the default `import` resolves to a module Turbopack
// can't load. Force the working CJS build via require — server-only, and kept in
// next.config `serverExternalPackages` so it isn't bundled.
const _sodium = createRequire(import.meta.url)("libsodium-wrappers") as typeof _SodiumType;

/**
 * Fly.io provider client — the universal container fallback (after Render and
 * Railway).
 *
 * Fly is fundamentally different from Render/Railway: it does not build a service
 * from a connected GitHub repo. It deploys a **Docker image** that is built
 * either with local Docker or on a Fly **remote builder**. This server runs in a
 * serverless function with neither Docker nor `flyctl`, so the only way to build
 * arbitrary generated source into a running Fly app is to drive Fly's remote
 * builder from CI. This client therefore:
 *
 *  1. detects the token's org (GraphQL),
 *  2. creates the Fly app (Machines API),
 *  3. stages the app's runtime env as Fly secrets (GraphQL),
 *  4. commits a `fly.toml` + a `flyctl deploy --remote-only` GitHub Actions
 *     workflow into the already-pushed repo,
 *  5. stores the Fly token as an encrypted GitHub Actions secret, and
 *  6. dispatches the workflow.
 *
 * The remote build + release then runs in Actions (no Docker needed here),
 * exactly like Render/Railway building asynchronously after service creation.
 * The public URL is deterministic (`https://<app>.fly.dev`), so we can return it
 * immediately.
 *
 * Server-only: requires FLY_API_TOKEN (a `fly tokens create org` deploy token)
 * and a GITHUB_TOKEN for the repo it deploys. NOTE: because step 4 commits a
 * `.github/workflows` file, that token needs the **Workflows** write permission
 * (fine-grained PAT) / `workflow` scope (classic) — more than Render/Railway need.
 */

const GQL = "https://api.fly.io/graphql";
const MACHINES = "https://api.machines.dev/v1";

function flyToken(): string {
  return requireServerToken("FLY_API_TOKEN");
}

/**
 * Fly's two APIs want different header shapes for the same macaroon token:
 *  - GraphQL (api.fly.io) accepts the raw token verbatim (keeps its "FlyV1 " prefix);
 *  - the Machines API (api.machines.dev) wants it as a Bearer credential.
 */
function gqlAuth(): string {
  return flyToken();
}
function machinesAuth(): string {
  const t = flyToken();
  return t.toLowerCase().startsWith("bearer ") ? t : `Bearer ${t}`;
}

async function flyGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { Authorization: gqlAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await res.text();
  let json: { data?: T; errors?: Array<{ message: string }> };
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Fly GraphQL returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 160)}`);
  }
  if (json.errors?.length) throw new Error(`Fly GraphQL: ${json.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  if (!res.ok) throw new Error(`Fly GraphQL HTTP ${res.status}: ${raw.slice(0, 160)}`);
  return json.data as T;
}

export interface FlyOrg {
  id: string;
  slug: string;
  name: string;
}

/**
 * Resolve the org the token can deploy into. An org deploy token is scoped to a
 * single org, so we take the first one it can see (preferring a non-personal org
 * if several are returned).
 */
export async function getFlyOrg(): Promise<FlyOrg> {
  const data = await flyGraphql<{ organizations: { nodes: Array<FlyOrg & { type?: string }> } }>(
    `{ organizations { nodes { id slug name type } } }`,
    {},
  );
  const orgs = data.organizations?.nodes ?? [];
  if (orgs.length === 0) throw new Error("FLY_API_TOKEN can't see any Fly organization — check the token.");
  const chosen = orgs.find((o) => o.type && o.type !== "PERSONAL") ?? orgs[0];
  return { id: chosen.id, slug: chosen.slug, name: chosen.name };
}

/** Lightweight health check used by status endpoints: is the token valid + which org? */
export async function validateFlyToken(): Promise<{ ok: boolean; org?: FlyOrg; error?: string }> {
  try {
    return { ok: true, org: await getFlyOrg() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Create the app on Fly (idempotent: an existing same-name app in the org is reused). */
async function createFlyApp(appName: string, orgSlug: string): Promise<void> {
  const res = await fetch(`${MACHINES}/apps`, {
    method: "POST",
    headers: { Authorization: machinesAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({ app_name: appName, org_slug: orgSlug }),
  });
  if (res.ok || res.status === 201) return;
  const raw = await res.text();
  // 422 with a "taken"/"already" message ⇒ the app already exists; treat as reuse.
  if (res.status === 422 && /taken|exists|already/i.test(raw)) return;
  throw new Error(`Fly couldn't create app "${appName}" (HTTP ${res.status}): ${raw.slice(0, 200)}`);
}

/** Stage the app's runtime env as Fly secrets; applied on the next (CI) deploy. */
async function setFlySecrets(appName: string, envVars: RenderEnvVar[]): Promise<void> {
  if (!envVars.length) return;
  await flyGraphql(
    `mutation($input: SetSecretsInput!) { setSecrets(input: $input) { release { id } } }`,
    { input: { appId: appName, secrets: envVars.map((v) => ({ key: v.key, value: v.value })) } },
  );
}

/** Encrypt a value for a GitHub Actions secret (libsodium sealed box). */
async function encryptForGitHub(publicKey: string, secret: string): Promise<string> {
  await _sodium.ready;
  const sodium = _sodium;
  const bin = sodium.crypto_box_seal(
    sodium.from_string(secret),
    sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(bin, sodium.base64_variants.ORIGINAL);
}

/** Create/update the repo's FLY_API_TOKEN Actions secret so the workflow can deploy. */
async function setGitHubActionsSecret(
  githubToken: string,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  try {
    const key = await gh<{ key: string; key_id: string }>(
      githubToken,
      `/repos/${owner}/${repo}/actions/secrets/public-key`,
    );
    const encrypted_value = await encryptForGitHub(key.key, value);
    await gh(githubToken, `/repos/${owner}/${repo}/actions/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_value, key_id: key.key_id }),
    });
  } catch (e) {
    // Managing Actions secrets needs the fine-grained "Secrets" RW permission.
    if (/403|not accessible/i.test(String(e))) {
      throw new Error(
        "Fly deploy needs the GITHUB_TOKEN to have the 'Secrets' write permission " +
          "(it stores FLY_API_TOKEN as a repo Actions secret). Add Secrets: Read and write " +
          "to the token, then retry.",
      );
    }
    throw e;
  }
}

const WORKFLOW_FILE = "fly-deploy.yml";

function flyToml(appName: string, region: string, port: number): string {
  // internal_port + PORT are pinned to the stack's detected port so the Fly
  // proxy targets the right port whether the app reads $PORT or hardcodes its
  // framework default (the detector's port is that default). Single small
  // machine, scale-to-zero to stay cheap.
  return `app = "${appName}"
primary_region = "${region}"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "${port}"

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
`;
}

function flyWorkflow(appName: string): string {
  return `name: Fly Deploy
on:
  workflow_dispatch:
  push:
    branches: [main]
jobs:
  deploy:
    name: Deploy app
    runs-on: ubuntu-latest
    concurrency: deploy-group
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only --ha=false --app ${appName} --yes
        env:
          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}
`;
}

export interface FlyDeployInput {
  githubToken: string;
  /** Coordinates of the repo already pushed by createRepoAndPush. */
  repoOwner: string;
  repoName: string;
  branch: string;
  /** Desired app name (will be sanitized + made unique). */
  name: string;
  envVars: RenderEnvVar[];
  region?: string;
  /** Port the container listens on (from the stack detector). Defaults to 8080. */
  port?: number;
}

export interface FlyDeployResult {
  appName: string;
  url: string;
  dashboardUrl: string;
  actionsUrl: string;
  org: string;
  /** How the deploy workflow was kicked off. */
  triggeredVia: "workflow_dispatch" | "push";
  /** Non-fatal advisories (e.g. why it fell back to the push trigger). */
  notes: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Explicitly fire the deploy workflow via the API — a DETERMINISTIC trigger,
 * instead of trusting the `push` event from committing the workflow to fire it
 * (which left apps created-but-never-built, stuck `pending` with no machine).
 *
 * Returns true if dispatched. Best-effort: needs the token's `Actions: write`
 * permission, and there's a brief race where a just-committed workflow isn't yet
 * registered (404), so we retry a few times. When the token simply lacks Actions
 * (403), we return false and let the push trigger (already in place) carry it.
 */
async function dispatchFlyWorkflow(githubToken: string, owner: string, repo: string, branch: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await gh(githubToken, `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref: branch }),
      });
      return true;
    } catch (e) {
      const msg = String(e);
      if (/403|not accessible/i.test(msg)) return false; // token lacks Actions: write → push fallback
      if (/404|not found|does not have/i.test(msg) && attempt < 3) {
        await sleep(1500); // workflow not registered yet — wait and retry
        continue;
      }
      return false; // any other hiccup: don't fail the deploy; push trigger remains
    }
  }
  return false;
}

/** A Fly app name must be globally unique and DNS-safe; suffix with random hex. */
function flyAppName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "app";
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${base}-${suffix}`;
}

/**
 * Deploy an already-pushed repo to Fly.io via a remote-build GitHub Actions
 * workflow. Returns the deterministic public URL immediately; the build/release
 * completes asynchronously in Actions (watch `actionsUrl`).
 *
 * Step order is deliberate: the runtime prerequisites (the Actions secret + the
 * Fly app itself) are put in place BEFORE the workflow file is committed, because
 * committing the workflow is what triggers it (via its `push` event) — so by the
 * time CI runs `flyctl deploy`, the app exists and `FLY_API_TOKEN` is available.
 * Using the push trigger (instead of an API `workflow_dispatch`) also means the
 * token needs no "Actions" permission — only Contents, Workflows and Secrets.
 */
export async function deployToFly(input: FlyDeployInput): Promise<FlyDeployResult> {
  const org = await getFlyOrg();
  const appName = flyAppName(input.name);
  const region = input.region || "iad";
  const port = input.port || 8080;
  const { githubToken, repoOwner, repoName, branch } = input;

  // 1) Store the Fly token as a repo Actions secret (needs Secrets RW). Done
  //    first so a missing permission fails before any Fly app is created.
  await setGitHubActionsSecret(githubToken, repoOwner, repoName, "FLY_API_TOKEN", flyToken());

  // 2) Create the Fly app + stage its runtime env as secrets, so the app exists
  //    when the push-triggered workflow runs `flyctl deploy`.
  await createFlyApp(appName, org.slug);
  await setFlySecrets(appName, input.envVars);

  // 3) Commit fly.toml + the deploy workflow. This push triggers the workflow,
  //    which remote-builds the Dockerfile and releases — secret + app already set.
  const files: RepoFile[] = [
    { path: "fly.toml", content: flyToml(appName, region, port) },
    { path: `.github/workflows/${WORKFLOW_FILE}`, content: flyWorkflow(appName) },
  ];
  try {
    await commitFilesToRepo(githubToken, repoOwner, repoName, branch, files);
  } catch (e) {
    // GitHub forbids writing .github/workflows/* unless the token has the
    // "Workflows" permission (fine-grained PAT) / "workflow" scope (classic).
    if (/403|not accessible|workflow/i.test(String(e))) {
      throw new Error(
        "Fly deploy needs the GITHUB_TOKEN to have the 'Workflows' write permission " +
          "(it commits a .github/workflows deploy workflow). Regenerate the token with " +
          "Workflows: Read and write (fine-grained) or the `workflow` scope (classic), then retry.",
      );
    }
    throw e;
  }

  // Deterministically fire the workflow instead of trusting the commit's push
  // event to do it (the silent-`pending` failure was a build that never ran).
  const dispatched = await dispatchFlyWorkflow(githubToken, repoOwner, repoName, branch);
  const notes = dispatched
    ? []
    : [
        "Couldn't workflow_dispatch the deploy (the GITHUB_TOKEN lacks 'Actions: write'), " +
          "so it relies on the commit's push trigger. Add Actions: Read and write to the token " +
          "for a deterministic trigger. Verify the release at /api/deploy/verify?provider=fly&appName=" +
          appName + " (or watch the Actions tab).",
      ];

  return {
    appName,
    url: `https://${appName}.fly.dev`,
    dashboardUrl: `https://fly.io/apps/${appName}`,
    actionsUrl: `https://github.com/${repoOwner}/${repoName}/actions/workflows/${WORKFLOW_FILE}`,
    org: org.slug,
    triggeredVia: dispatched ? "workflow_dispatch" : "push",
    notes,
  };
}
