import { chromium } from "playwright-chromium";

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("text=AI Platform", { timeout: 20000 });

const imgCount = () => page.evaluate(() =>
  [...document.querySelectorAll("img")].filter((i) => /^https?:|^data:/.test(i.src)).length
);

// Generate an image; wait for the save (PUT) to land.
const saved = page.waitForResponse((r) => /\/api\/chats\/.+\/messages/.test(r.url()) && r.request().method() === "PUT", { timeout: 90000 });
const ta = page.locator('textarea[placeholder*="Ask anything"]');
await ta.fill("generate an image of a red cube");
await ta.press("Enter");
await page.waitForFunction(() => [...document.querySelectorAll("img")].some((i) => /^https?:|^data:/.test(i.src)), { timeout: 90000 }).catch(() => {});
console.log("images in chat after generate:", await imgCount());
await saved.then(() => console.log("save PUT landed")).catch(() => console.log("save PUT NOT seen"));
await page.waitForTimeout(1500);

// Reload — does the image come back from history?
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("text=AI Platform", { timeout: 20000 });
await page.waitForFunction(() => [...document.querySelectorAll("img")].some((i) => /^https?:|^data:/.test(i.src)), { timeout: 60000 }).catch(() => {});
const after = await imgCount();
console.log("images in chat after reload:", after);

await browser.close();
process.exit(after > 0 ? 0 : 1);
