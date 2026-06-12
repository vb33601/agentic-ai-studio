/**
 * Best-effort runtime-log retrieval for a deployed backend, so the auto-repair
 * engine gets the actual crash reason (e.g. "ModuleNotFoundError: No module
 * named 'psycopg2'") rather than guessing from source alone.
 *
 * - Render exposes runtime logs over its REST API → we fetch them directly.
 * - Fly has no public log API reachable from a serverless function (logs stream
 *   over a private channel via flyctl), so we return null and the caller falls
 *   back to a synthesized hint + static source analysis.
 *
 * Server-only: uses RENDER_API_KEY.
 */

/** Pull recent app (runtime) logs for a Render service. Returns "" on failure. */
export async function getRenderRuntimeLogs(serviceId: string, limit = 100): Promise<string> {
  const key = process.env.RENDER_API_KEY;
  if (!key) return "";
  const auth = { Authorization: `Bearer ${key}` };
  try {
    const svc = await fetch(`https://api.render.com/v1/services/${serviceId}`, { headers: auth }).then((r) => r.json());
    const ownerId = svc?.ownerId || svc?.service?.ownerId;
    if (!ownerId) return "";
    const qs = new URLSearchParams({ ownerId, limit: String(limit), direction: "backward" });
    qs.append("resource", serviceId);
    qs.append("type", "app");
    const res = await fetch(`https://api.render.com/v1/logs?${qs.toString()}`, { headers: auth });
    if (!res.ok) return "";
    const data = await res.json();
    const lines: string[] = (data?.logs || data || [])
      .map((l: { message?: string; text?: string } | string) => (typeof l === "string" ? l : l.message || l.text || ""))
      .filter(Boolean);
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Extract a Render service id (`srv-…`) from a dashboard URL, if present. */
export function renderServiceIdFromDashboard(dashboardUrl?: string | null): string | null {
  if (!dashboardUrl) return null;
  return dashboardUrl.match(/srv-[a-z0-9]+/i)?.[0] ?? null;
}

/**
 * Get the best available error signal for a crashing backend. Prefers real
 * provider logs; otherwise synthesizes a description from the framework + the
 * failed health probe so the engine can still diagnose from source.
 */
export async function getBackendErrorSignal(opts: {
  provider?: string | null;
  dashboardUrl?: string | null;
  framework?: string | null;
  httpStatus?: number | null;
  bodySnippet?: string | null;
}): Promise<{ log: string; source: "render-logs" | "synthesized" }> {
  const { provider, dashboardUrl, framework, httpStatus, bodySnippet } = opts;

  if (provider === "render") {
    const id = renderServiceIdFromDashboard(dashboardUrl);
    if (id) {
      const logs = await getRenderRuntimeLogs(id);
      if (logs.trim()) return { log: logs, source: "render-logs" };
    }
  }

  // Fallback: describe the failure so the engine diagnoses from the repo source.
  const hint =
    `The deployed ${framework || "backend"} app builds successfully but the running server ` +
    `${httpStatus ? `returns HTTP ${httpStatus}` : "is unreachable / returns no response"} for every request, ` +
    `which means the process is crashing on boot or not binding the port. ` +
    `Diagnose the most likely cause from the source: the entrypoint/start command, the dependency manifest ` +
    `(a missing runtime driver such as a database driver is common), database/connection setup, and the port bind. ` +
    (bodySnippet ? `The server response body was: ${bodySnippet}` : "");
  return { log: hint, source: "synthesized" };
}
