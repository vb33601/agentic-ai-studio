import { chromium } from "playwright-chromium";

async function run(label, seedStale) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded", timeout: 30000 });

  if (seedStale) {
    // Simulate a browser that used an OLD version of the app (pre-refactor store).
    await page.evaluate(() => {
      localStorage.setItem(
        "chat-store",
        JSON.stringify({
          state: {
            sessions: [{ id: "old1", title: "Old chat", model: "gpt-4o", provider: "openai", createdAt: "2025-01-01T00:00:00.000Z", messages: 3 }],
            activeChatId: "old1",
            messagesBySession: { old1: [{ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }] },
            selectedModel: { id: "openai/gpt-4o", name: "GPT-4o", provider: "openrouter", contextWindow: 128000, supportsVision: true, supportsTools: true, description: "x" },
            agentType: "coding",
            enableTools: true,
            temperature: 0.7,
            sidebarOpen: true,
          },
          version: 0,
        })
      );
    });
    await page.reload({ waitUntil: "networkidle" });
  }

  let mounted = true;
  try {
    await page.waitForSelector("text=AI Platform", { timeout: 15000 });
  } catch {
    mounted = false;
  }

  const tab = (name) => page.getByRole("button", { name, exact: true }).first();
  const bodyHas = async (re) => re.test(await page.evaluate(() => document.body.innerText));

  const results = {};
  if (mounted) {
    for (const [name, marker] of [
      ["Code", /No files yet/],
      ["Files", /No files generated yet/],
      ["Preview", /No preview/],
      ["Deploy", /Deploy Project/],
    ]) {
      try {
        await tab(name).click();
        await page.waitForTimeout(600);
        results[name] = (await bodyHas(marker)) ? "OK" : "BLANK/MISSING";
      } catch (e) {
        results[name] = "CLICK-FAIL: " + e.message.slice(0, 50);
      }
    }
  }

  console.log(`\n### ${label}`);
  console.log("app mounted:", mounted);
  console.log("tab empty-states:", JSON.stringify(results));
  console.log("console errors:", errors.length, errors.slice(0, 5).map((e) => e.slice(0, 160)));

  await browser.close();
  return mounted && Object.values(results).every((v) => v === "OK");
}

const fresh = await run("FRESH (empty localStorage)", false);
const stale = await run("STALE (old localStorage seeded)", true);
console.log("\nfresh ok:", fresh, "| stale ok:", stale);
process.exit(fresh && stale ? 0 : 1);
