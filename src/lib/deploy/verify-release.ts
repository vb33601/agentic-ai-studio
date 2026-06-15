import { serverToken } from "./env";
import type { ProviderId } from "./providers/types";

/**
 * Post-deploy RELEASE verification — for every provider.
 *
 * The deploy pipeline triggers a build (Fly via a GitHub Actions workflow, Render/
 * Railway via their build queues, Vercel via an upload) and historically returned
 * immediately, never confirming the release actually went LIVE. When a build then
 * failed — e.g. a generated app that didn't compile — the app was created but no
 * machine/release ever appeared, and it sat in `pending` forever with zero feedback
 * (the exact failure that stranded my-app-rest-menu on Fly).
 *
 * This module closes that gap uniformly: poll the provider's API until the release
 * reaches a TERMINAL state, then report `live` / `failed` / `timeout` with an
 * actionable hint. The poll loop is a pure, injectable state machine (so it's unit-
 * tested without the network), and each provider contributes a pure status MAPPER
 * (raw API JSON → ReleaseStatus) plus a thin fetcher.
 */

export type ReleaseState =
  | "live" // a release is running / serving
  | "failed" // the build or release failed
  | "pending" // still building/deploying — keep polling
  | "timeout" // never went live within the budget (usually a silent build failure)
  | "unknown"; // couldn't determine (missing creds / API error) — never blocks a deploy

export interface ReleaseStatus {
  provider: ProviderId;
  state: ReleaseState;
  detail: string;
  /** Actionable next step when not live. */
  hint?: string;
}

const live = (provider: ProviderId, detail: string): ReleaseStatus => ({ provider, state: "live", detail });
const failed = (provider: ProviderId, detail: string, hint: string): ReleaseStatus => ({ provider, state: "failed", detail, hint });
const pending = (provider: ProviderId, detail: string, hint?: string): ReleaseStatus => ({ provider, state: "pending", detail, hint });
const unknown = (provider: ProviderId, detail: string): ReleaseStatus => ({ provider, state: "unknown", detail });

// ─────────────────────────── Pure provider mappers ───────────────────────────

interface FlyApp { status?: string; deployed?: boolean; releases?: { nodes?: Array<{ status?: string }> } }

/** Fly: live = app `deployed` AND a machine `started`. A CI build failure leaves
 *  0 releases / 0 machines → stays pending (→ timeout with the right hint). */
export function mapFlyState(app: FlyApp | null | undefined, machines: Array<{ state?: string }>): ReleaseStatus {
  const started = machines.some((m) => m.state === "started");
  const rels = app?.releases?.nodes ?? [];
  if (app?.deployed && app?.status === "deployed" && started) {
    return live("fly", `Fly app deployed with ${machines.length} machine(s) running`);
  }
  if (rels.some((r) => /fail|error|cancel/i.test(r.status ?? ""))) {
    return failed("fly", "a Fly release failed", "open the GitHub Actions build log (the workflow's flyctl deploy step)");
  }
  return pending(
    "fly",
    `Fly app ${app?.status ?? "pending"}, ${machines.length} machine(s), ${rels.length} release(s)`,
    rels.length === 0 ? "no release was created — the CI build likely failed to compile; check GitHub Actions" : undefined,
  );
}

/** Render deploy statuses (Render API `status` field). */
const RENDER_FAILED = new Set(["build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated"]);
export function mapRenderState(deploy: { status?: string } | null | undefined): ReleaseStatus {
  const s = deploy?.status ?? "";
  if (s === "live") return live("render", "Render deploy is live");
  if (RENDER_FAILED.has(s)) return failed("render", `Render deploy ${s}`, "open the build logs in the Render dashboard");
  return pending("render", `Render deploy ${s || "queued"}`);
}

/** Railway deployment statuses (GraphQL `status` enum). */
const RW_LIVE = new Set(["SUCCESS", "DEPLOYED"]);
const RW_FAILED = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);
export function mapRailwayState(deployment: { status?: string } | null | undefined): ReleaseStatus {
  const s = (deployment?.status ?? "").toUpperCase();
  if (RW_LIVE.has(s)) return live("railway", "Railway deployment succeeded");
  if (RW_FAILED.has(s)) return failed("railway", `Railway deployment ${s}`, "open the deploy logs in the Railway dashboard");
  return pending("railway", `Railway deployment ${s || "building"}`);
}

/** Vercel deployment readyState. */
export function mapVercelState(deployment: { readyState?: string; state?: string } | null | undefined): ReleaseStatus {
  const s = (deployment?.readyState ?? deployment?.state ?? "").toUpperCase();
  if (s === "READY") return live("vercel", "Vercel deployment is ready");
  if (s === "ERROR" || s === "CANCELED") return failed("vercel", `Vercel deployment ${s}`, "open the build logs in the Vercel dashboard");
  return pending("vercel", `Vercel deployment ${s || "building"}`);
}

// ─────────────────────────── Generic poll state machine ───────────────────────────

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable clock + sleep so the loop is unit-testable without real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Poll `fetchStatus` until it returns a terminal state (anything but `pending`),
 *  or convert a persistent `pending` into `timeout` once the budget is spent. */
export async function pollUntilLive(fetchStatus: () => Promise<ReleaseStatus>, opts: PollOptions = {}): Promise<ReleaseStatus> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 6_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  let last = await fetchStatus();
  while (last.state === "pending") {
    if (now() - start >= timeoutMs) {
      return {
        ...last,
        state: "timeout",
        detail: `${last.detail} — still not live after ${Math.round(timeoutMs / 1000)}s`,
        hint: last.hint ?? "the build may have failed; check the provider / CI logs",
      };
    }
    await sleep(intervalMs);
    last = await fetchStatus();
  }
  return last;
}

// ─────────────────────────── Network fetchers ───────────────────────────

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  return res.json();
}

async function flyStatus(appName: string): Promise<ReleaseStatus> {
  const tok = serverToken("FLY_API_TOKEN");
  if (!tok) return unknown("fly", "FLY_API_TOKEN not set — skipped verification");
  const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const q = `query($n:String!){ app(name:$n){ status deployed releases(first:3){ nodes { status } } } }`;
  const gql = (await fetchJson("https://api.fly.io/graphql", { method: "POST", headers, body: JSON.stringify({ query: q, variables: { n: appName } }) })) as { data?: { app?: FlyApp } };
  const machines = (await fetchJson(`https://api.machines.dev/v1/apps/${appName}/machines`, { headers: { Authorization: `Bearer ${tok}` } })) as Array<{ state?: string }>;
  return mapFlyState(gql?.data?.app, Array.isArray(machines) ? machines : []);
}

async function renderStatus(serviceId: string, deployId?: string): Promise<ReleaseStatus> {
  const key = serverToken("RENDER_API_KEY");
  if (!key) return unknown("render", "RENDER_API_KEY not set — skipped verification");
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const path = deployId
    ? `https://api.render.com/v1/services/${serviceId}/deploys/${deployId}`
    : `https://api.render.com/v1/services/${serviceId}/deploys?limit=1`;
  const body = (await fetchJson(path, { headers })) as unknown;
  const deploy = Array.isArray(body) ? ((body[0] as { deploy?: { status?: string } })?.deploy ?? body[0]) : body;
  return mapRenderState(deploy as { status?: string });
}

async function railwayStatus(serviceId: string): Promise<ReleaseStatus> {
  const tok = serverToken("RAILWAY_API_TOKEN");
  if (!tok) return unknown("railway", "RAILWAY_API_TOKEN not set — skipped verification");
  const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const q = `query($id:String!){ deployments(first:1, input:{serviceId:$id}){ edges { node { status } } } }`;
  const gql = (await fetchJson("https://backboard.railway.app/graphql/v2", { method: "POST", headers, body: JSON.stringify({ query: q, variables: { id: serviceId } }) })) as { data?: { deployments?: { edges?: Array<{ node?: { status?: string } }> } } };
  return mapRailwayState(gql?.data?.deployments?.edges?.[0]?.node);
}

async function vercelStatus(deploymentId: string): Promise<ReleaseStatus> {
  const tok = serverToken("VERCEL_TOKEN");
  if (!tok) return unknown("vercel", "VERCEL_TOKEN not set — skipped verification");
  const body = (await fetchJson(`https://api.vercel.com/v13/deployments/${deploymentId}`, { headers: { Authorization: `Bearer ${tok}` } })) as { readyState?: string; status?: string };
  return mapVercelState({ readyState: body?.readyState ?? body?.status });
}

// ─────────────────────────── Public entry ───────────────────────────

export type VerifyRef =
  | { provider: "fly"; appName: string }
  | { provider: "render"; serviceId: string; deployId?: string }
  | { provider: "railway"; serviceId: string }
  | { provider: "vercel"; deploymentId: string };

/**
 * Verify a freshly-triggered deploy actually reaches a live release. Best-effort:
 * any network/credential problem resolves to `unknown` rather than throwing, so
 * verification never turns a healthy deploy into a failure.
 */
export async function verifyRelease(ref: VerifyRef, opts: PollOptions = {}): Promise<ReleaseStatus> {
  const fetchStatus = (): Promise<ReleaseStatus> => {
    switch (ref.provider) {
      case "fly": return flyStatus(ref.appName);
      case "render": return renderStatus(ref.serviceId, ref.deployId);
      case "railway": return railwayStatus(ref.serviceId);
      case "vercel": return vercelStatus(ref.deploymentId);
    }
  };
  try {
    return await pollUntilLive(fetchStatus, opts);
  } catch (e) {
    return unknown(ref.provider, `verification error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
