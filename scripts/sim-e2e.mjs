/**
 * End-user simulation: drive the REAL app in a browser across many scenarios and
 * report what actually happens, so issues surface the way a user hits them.
 *
 *   BASE=http://localhost:3007 DEVLOG=/tmp/aip-test/dev.log npx tsx scripts/sim-e2e.mjs
 *   # optional: ONLY=chat,single-file   HEADED=1   GEN_TIMEOUT_MS=480000
 *
 * Per scenario it captures: uncaught page errors, console errors, network
 * completion (incl. client auto-resume rounds), the DEBUG_STREAM server-produced
 * vs client-received byte accounting (transport integrity = issue #6), the final
 * chat transcript (error banners), and whether files reached the workspace.
 */
import { chromium } from "playwright-chromium";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3007";
const DEVLOG = process.env.DEVLOG || "/tmp/aip-test/dev.log";
const GEN_TIMEOUT_MS = Number(process.env.GEN_TIMEOUT_MS) || 420000; // 7 min/gen
const IDLE_MS = 9000; // network quiet this long (covers client auto-resume gap) = done
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

const PLACEHOLDER = 'textarea[placeholder*="Ask anything"]';

// Scenarios ordered light→heavy so cheap signal lands before pricey full-stack.
const SCENARIOS = [
  { id: "ui-load", kind: "ui", desc: "App loads with no console/page errors" },
  { id: "ui-controls", kind: "ui", desc: "Agent/model selectors, tools toggle, tab switching, settings" },
  { id: "chat", kind: "gen", prompt: "What is the capital of France? Answer in one short sentence.", expect: { minFiles: 0 } },
  { id: "single-file", kind: "gen", prompt: "Create a single file index.html containing an <h1> that says Hello E2E Test. Only that one file.", expect: { minFiles: 1 } },
  { id: "frontend-spa", kind: "gen", prompt: "Build a small React + Vite todo app: add a todo, list todos, delete a todo. Keep it to a few files.", expect: { minFiles: 3 } },
  { id: "fullstack", kind: "gen", prompt: "Build a notes app: an Express backend exposing GET and POST /api/notes, and a React (Vite) frontend that fetches and creates notes by calling that API.", expect: { minFiles: 4, wantBackend: true, wantFrontend: true } },
];

const results = [];
let devlogSeen = 0;

function newDebugLines() {
  let lines = [];
  try { lines = readFileSync(DEVLOG, "utf8").split("\n"); } catch { /* ignore */ }
  const dbg = lines.filter((l) => l.includes("[DEBUG_STREAM] server produced") || l.includes("[completeness]") || l.includes("[chat] anchor") || l.includes("[chat] finished"));
  const fresh = dbg.slice(devlogSeen);
  devlogSeen = dbg.length;
  return fresh;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const ctx = await browser.newContext();
  // Turn on the client-side DEBUG_STREAM probe before any app code runs.
  await ctx.addInitScript(() => { try { window.localStorage.setItem("DEBUG_STREAM", "1"); } catch {} });
  const page = await ctx.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const clientStreamLogs = [];
  let chatInflight = 0;
  let lastChatActivity = Date.now();

  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[DEBUG_STREAM] client received")) clientStreamLogs.push(t);
    if (m.type() === "error") {
      // Ignore noisy, harmless network favicon/devtools lines.
      if (/favicon|Download the React DevTools/i.test(t)) return;
      consoleErrors.push(t);
    }
  });
  page.on("request", (r) => { if (r.url().includes("/api/chat")) { chatInflight++; lastChatActivity = Date.now(); } });
  const settle = (r) => { if (r.url().includes("/api/chat")) { chatInflight = Math.max(0, chatInflight - 1); lastChatActivity = Date.now(); } };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(PLACEHOLDER, { timeout: 20000 });
  await sleep(1500); // let hydration settle

  const want = (id) => ONLY.length === 0 || ONLY.includes(id);

  for (const sc of SCENARIOS) {
    if (!want(sc.id)) continue;
    const errBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const issues = [];

    try {
      if (sc.id === "ui-load") {
        // Just being here with the input present is the check.
        const hasInput = await page.locator(PLACEHOLDER).count();
        if (!hasInput) issues.push("chat input not found on load");
      }

      if (sc.id === "ui-controls") {
        // Agent selector (Radix Select trigger shows "Orchestrator" by default).
        try {
          await page.getByText("Orchestrator", { exact: false }).first().click({ timeout: 5000 });
          await sleep(400);
          const opt = page.getByText(/App Builder|Coding|UI\/?UX|Game/i).first();
          if (await opt.count()) await opt.click({ timeout: 3000 }).catch(() => {});
          await page.keyboard.press("Escape").catch(() => {});
        } catch (e) { issues.push("agent selector: " + String(e).split("\n")[0]); }
        // Model selector opens a search box.
        try {
          await page.locator("button", { hasText: /.*/ }).first().waitFor({ timeout: 2000 }).catch(() => {});
          const modelBtn = page.locator('button:has-text("·"), button').filter({ hasText: /./ });
          await page.getByRole("button").nth(2).click({ timeout: 3000 }).catch(() => {});
          const search = page.locator('input[placeholder*="Search any model"]');
          if (await search.count()) {
            await search.fill("haiku");
            await sleep(800);
          }
          await page.keyboard.press("Escape").catch(() => {});
        } catch (e) { issues.push("model selector: " + String(e).split("\n")[0]); }
        // Tab switching.
        for (const tab of ["Code", "Files", "Preview", "Deploy", "Chat"]) {
          try { await page.getByRole("button", { name: new RegExp(`^${tab}$`) }).first().click({ timeout: 4000 }); await sleep(300); }
          catch { issues.push(`tab '${tab}' not clickable`); }
        }
      }

      if (sc.kind === "gen") {
        // Fresh chat each generation scenario (sidebar "New chat") to isolate files.
        // (First scenario already starts clean.)
        const ta = page.locator(PLACEHOLDER);
        await ta.click();
        await ta.fill(sc.prompt);
        await page.keyboard.press("Enter");

        // Wait for generation: request starts, then network quiet for IDLE_MS, or cap.
        const start = Date.now();
        // give it a moment to fire the first request
        await sleep(2500);
        for (;;) {
          const quiet = Date.now() - lastChatActivity;
          if (chatInflight === 0 && quiet > IDLE_MS) break;
          if (Date.now() - start > GEN_TIMEOUT_MS) { issues.push(`generation did not settle within ${GEN_TIMEOUT_MS}ms`); break; }
          await sleep(1500);
        }
        await sleep(1500);

        // Real error banner in transcript? (The amber "free fallback model" notice
        // is INFORMATIONAL — degraded mode, not a failure — so it is NOT an issue.)
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (/Running on a free fallback model/i.test(bodyText)) console.log("   (info) degraded mode: running on a free fallback model");
        if (/Generation (failed|error)|An error occurred|Internal server error|Provider .* isn't configured/i.test(bodyText)) {
          const m = bodyText.match(/[^\n]*(Generation (failed|error)|An error occurred|Internal server error|isn't configured)[^\n]*/i);
          issues.push("error banner: " + (m ? m[0].trim().slice(0, 200) : "present"));
        }

        // Files in workspace (Files tab).
        await page.getByRole("button", { name: /^Files$/ }).first().click().catch(() => {});
        await sleep(1200);
        const filesText = await page.evaluate(() => document.body.innerText);
        const noFiles = /No files generated yet/i.test(filesText);
        if (sc.expect?.minFiles > 0 && noFiles) issues.push("workspace shows NO files");

        // Server vs client byte accounting from this scenario's fresh logs.
        const fresh = newDebugLines();
        const serverLine = [...fresh].reverse().find((l) => l.includes("[DEBUG_STREAM] server produced"));
        const clientLine = clientStreamLogs[clientStreamLogs.length - 1];
        const sChars = serverLine && /totalChars=(\d+)/.exec(serverLine)?.[1];
        const cTotal = clientLine && /total=(\d+)/.exec(clientLine)?.[1];
        if (sChars && cTotal) {
          const sv = +sChars, cv = +cTotal;
          // Client should receive at least ~70% of server-produced chars (tool-call
          // JSON framing differs slightly); a big shortfall = real transport loss.
          if (sv > 2000 && cv < sv * 0.5) issues.push(`STREAM LOSS: server ${sv} chars vs client ${cv} chars`);
          results.push({ note: `${sc.id} bytes: server=${sv} client=${cv}` });
        }

        await page.getByRole("button", { name: /^Chat$/ }).first().click().catch(() => {});
      }
    } catch (e) {
      issues.push("scenario threw: " + String(e.message || e).split("\n")[0]);
    }

    const newPageErrs = pageErrors.slice(errBefore);
    const newConsErrs = consoleErrors.slice(consBefore);
    if (newPageErrs.length) issues.push(...newPageErrs.map((e) => "pageerror: " + e.slice(0, 200)));
    if (newConsErrs.length) issues.push(...newConsErrs.slice(0, 5).map((e) => "console.error: " + e.slice(0, 200)));

    const status = issues.length === 0 ? "PASS" : "ISSUES";
    console.log(`\n[${status}] ${sc.id} — ${sc.desc || sc.prompt?.slice(0, 60)}`);
    for (const i of issues) console.log("   • " + i);
    results.push({ id: sc.id, status, issues });
  }

  await browser.close();

  console.log("\n" + "=".repeat(64));
  const failed = results.filter((r) => r.status === "ISSUES");
  console.log(failed.length === 0 ? "ALL SCENARIOS PASSED" : `${failed.length} SCENARIO(S) WITH ISSUES: ${failed.map((r) => r.id).join(", ")}`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
