import { chromium } from "playwright-chromium";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("text=AI Platform", { timeout: 20000 });

// Type a prompt that should trigger the createFile tool (coding agent).
const prompt = "create a file index.html containing an h1 that says Hello E2E Test. Only that one file.";
const textarea = page.locator('textarea[placeholder*="Ask anything"]');
await textarea.fill(prompt);
await textarea.press("Enter");

console.log("prompt sent, waiting for generated files…");

// Wait until the Files tab badge shows at least one file (B1 fix verification).
await page.waitForFunction(
  () => /Files \(\d+\)/.test(document.body.innerText) || /No files/.test(""),
  { timeout: 90000 }
).catch(() => {});

// Switch to Files tab and count.
await page.getByRole("button", { name: /Files/ }).first().click();
await page.waitForTimeout(1500);
const filesText = await page.evaluate(() => document.body.innerText);
const fileMatch = filesText.match(/Files \((\d+)\)/);
const fileCount = fileMatch ? parseInt(fileMatch[1], 10) : 0;
console.log("workspace file count:", fileCount);

// Check Preview renders the generated content.
await page.getByRole("button", { name: /Preview/ }).first().click();
await page.waitForTimeout(1500);
let previewOk = false;
for (const frame of page.frames()) {
  try {
    const txt = await frame.evaluate(() => document.body && document.body.innerText);
    if (txt && /Hello E2E Test/i.test(txt)) previewOk = true;
  } catch {}
}
console.log("preview shows generated H1:", previewOk);

await browser.close();
process.exit(fileCount > 0 ? 0 : 1);
