import { chromium } from "playwright-chromium";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 30000 });

// Wait for the real app UI to mount (not just the loader).
await page.waitForSelector("text=AI Platform", { timeout: 20000 });

const isolated = await page.evaluate(() => window.crossOriginIsolated);
const hasWC = await page.evaluate(() => typeof window.WebAssembly !== "undefined");
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 120));

console.log("crossOriginIsolated:", isolated);
console.log("WebAssembly available:", hasWC);
console.log("body starts:", JSON.stringify(bodyText));
// Filter noise: WebContainer/analytics warnings aren't real app errors.
const real = errors.filter((e) => !/Manifest|favicon|analytics/i.test(e));
console.log("console errors:", real.length, real.slice(0, 5));

await browser.close();
process.exit(isolated && real.length === 0 ? 0 : 1);
