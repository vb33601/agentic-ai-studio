/**
 * Post-deploy backend health probe.
 *
 * The container providers (Render/Fly/Railway) report only *build/release*
 * status — they don't tell us whether the running process actually serves a
 * request. A generated app can build cleanly yet crash on boot (missing DB
 * driver, bad bind, unhandled env), which the edge surfaces as a 5xx and the
 * browser as "Failed to fetch". This probe checks the deployed URL the way a
 * real client would, so the deploy pipeline can verify liveness (and trigger
 * backend auto-repair) instead of optimistically reporting "live".
 *
 * Server-only: run from an API route so the fetch is same-origin-free (no CORS)
 * and sees the real HTTP status, including a cross-origin app that doesn't send
 * CORS headers for a probe.
 */

export interface BackendHealth {
  /** The base URL probed. */
  url: string;
  /** The path that produced the conclusive result. */
  probedPath: string;
  /** A TCP/TLS connection was established and an HTTP response came back. */
  reachable: boolean;
  /** HTTP status of the best response, or null if never reachable. */
  status: number | null;
  /**
   * The app is up and serving. True for any response < 500 — a 404/405 on `/`
   * still proves the server booted and is handling requests; only a 5xx (or no
   * response at all) means it's down/crashing.
   */
  healthy: boolean;
  /** First chunk of a 5xx body, to help diagnose the crash. */
  bodySnippet?: string;
}

// Try the root first; an app that 404s on `/` is still "up". Fall through to
// conventional health paths only when the root is a 5xx / unreachable, so a
// healthy app resolves in a single request.
const PROBE_PATHS = ["/", "/health", "/healthz", "/api/health"];

export async function probeBackendHealth(baseUrl: string, timeoutMs = 12000): Promise<BackendHealth> {
  const base = baseUrl.replace(/\/+$/, "");
  let last: BackendHealth = { url: base, probedPath: "/", reachable: false, status: null, healthy: false };

  for (const path of PROBE_PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, { signal: controller.signal, redirect: "manual" });
      const healthy = res.status < 500;
      const result: BackendHealth = {
        url: base,
        probedPath: path,
        reachable: true,
        status: res.status,
        healthy,
        bodySnippet: healthy ? undefined : (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 400) || undefined,
      };
      // A healthy response on any path is conclusive — stop probing.
      if (healthy) return result;
      last = result;
    } catch {
      // Network error / abort (DNS not propagated, cold-start timeout, refused).
      // Keep trying the remaining paths before concluding "unreachable".
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}
