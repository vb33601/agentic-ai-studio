/**
 * Frontend smoke test — the third verification layer (after the Vercel build
 * status and the backend health gate). A frontend can build green and still be
 * broken for a real user: a blank render, an uncaught JS error, or — the case
 * that started this — the UI's API call failing ("Failed to fetch") because the
 * backend is down or CORS is wrong. This loads the deployed page the way a
 * browser does and reports those runtime failures.
 *
 * Two layers, so it works everywhere:
 *  1. HTTP-level sanity (always): the URL returns 200 HTML with an app mount or
 *     script tags — catches blank/error pages with zero dependencies.
 *  2. Real headless browser (best-effort via playwright-chromium): visits the
 *     page, captures console errors + failed/5xx requests, and checks something
 *     actually rendered. Auto-skips where no browser binary is available (e.g. a
 *     Vercel serverless function), degrading to the HTTP-level verdict.
 *
 * Server-only.
 */

export interface SmokeResult {
  url: string;
  ok: boolean;
  httpStatus: number | null;
  isHtml: boolean;
  hasAppMount: boolean;
  loadsScripts: boolean;
  /** Browser-level signals, or null when no browser binary was available. */
  browser: null | {
    renderedChars: number;
    blank: boolean;
    consoleErrors: string[];
    failedRequests: string[];
  };
  /** Human-readable problems; empty ⇒ healthy. */
  issues: string[];
}

const CRITICAL_CONSOLE =
  /failed to fetch|networkerror|net::err|is not defined|is not a function|uncaught|cannot read|module not found|chunkloaderror|cors|blocked by/i;

// Requests whose failure doesn't mean the app is broken.
const NOISE = /favicon|analytics|gtag|googletagmanager|fonts\.(googleapis|gstatic)|\.map(\?|$)|hot-update/i;

function isCriticalConsole(t: string): boolean {
  return CRITICAL_CONSOLE.test(t);
}

async function runBrowserChecks(url: string): Promise<NonNullable<SmokeResult["browser"]>> {
  // Dynamic import so the heavy/native module is never bundled and never loaded
  // unless a smoke test actually runs. Throws if the binary is unavailable →
  // caller treats it as "no browser" and falls back to the HTTP verdict.
  const { chromium } = await import("playwright-chromium");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await (await browser.newContext()).newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("requestfailed", (r) => { if (!NOISE.test(r.url())) failedRequests.push(`${r.url()} (${r.failure()?.errorText || "failed"})`); });
    page.on("response", (r) => { if (r.status() >= 500 && !NOISE.test(r.url())) failedRequests.push(`${r.status()} ${r.url()}`); });
    await page.goto(url, { waitUntil: "networkidle", timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200); // let initial data fetches fire (e.g. on mount)
    const renderedChars = (await page.locator("body").innerText().catch(() => "")).trim().length;
    return {
      renderedChars,
      blank: renderedChars < 5,
      consoleErrors: consoleErrors.slice(0, 10),
      failedRequests: failedRequests.slice(0, 10),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function smokeTestFrontend(
  rawUrl: string,
  opts: { backendUrl?: string | null } = {},
): Promise<SmokeResult> {
  const url = /^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const issues: string[] = [];

  // ---- 0) CORS preflight (browser-free; catches the "Failed to fetch" class) ----
  // The UI calls the backend cross-origin; if the backend doesn't allow the
  // frontend origin, every API call fails with "Failed to fetch" — exactly the
  // symptom we want to catch even where no browser binary is available.
  if (opts.backendUrl) {
    try {
      const origin = new URL(url).origin;
      const res = await fetch(opts.backendUrl, { headers: { Origin: origin } });
      const acao = res.headers.get("access-control-allow-origin");
      const corsOk = acao === "*" || acao === origin;
      if (!corsOk && res.status < 500) {
        issues.push(`backend CORS blocks the frontend origin (Access-Control-Allow-Origin: ${acao || "none"}) — the UI's API calls will fail with "Failed to fetch"`);
      }
    } catch {
      // Backend reachability is covered by the health gate; ignore here.
    }
  }

  // ---- 1) HTTP-level sanity ----
  let httpStatus: number | null = null;
  let html = "";
  let isHtml = false;
  try {
    const res = await fetch(url, { redirect: "follow" });
    httpStatus = res.status;
    isHtml = (res.headers.get("content-type") || "").includes("text/html");
    html = await res.text();
  } catch (e) {
    issues.push(`page unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hasAppMount = /id=["'](root|app|__next)["']|data-reactroot|__NEXT_DATA__/.test(html);
  const loadsScripts = /<script[^>]+src=/.test(html);
  if (httpStatus != null && httpStatus >= 400) issues.push(`page returned HTTP ${httpStatus}`);
  if (httpStatus != null && httpStatus < 400 && isHtml && !hasAppMount && !loadsScripts) {
    issues.push("no app mount or scripts in HTML — looks like a blank/error page");
  }

  // ---- 2) Real browser (best-effort) ----
  let browser: SmokeResult["browser"] = null;
  try {
    browser = await runBrowserChecks(url);
    if (browser.blank) issues.push("page rendered blank (no visible content)");
    const critical = browser.consoleErrors.filter(isCriticalConsole);
    if (critical.length) issues.push(`runtime console errors: ${critical.slice(0, 3).join(" | ").slice(0, 220)}`);
    if (browser.failedRequests.length) issues.push(`failed requests (likely API/backend): ${browser.failedRequests.slice(0, 3).join(" | ").slice(0, 220)}`);
  } catch {
    // No browser binary here (e.g. Vercel serverless) — HTTP verdict stands.
  }

  const reachable = httpStatus != null && httpStatus < 400;
  return { url, ok: reachable && issues.length === 0, httpStatus, isHtml, hasAppMount, loadsScripts, browser, issues };
}
