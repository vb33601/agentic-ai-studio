import { chromium } from "playwright-chromium";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("text=AI Platform", { timeout: 20000 });

// Disable tools so the model replies with markdown code blocks (no createFile).
const toolsBtn = page.locator('button[title*="tools" i]').first();
await toolsBtn.click();
await page.waitForTimeout(300);
const footer = await page.evaluate(() => document.body.innerText);
console.log("tools state:", /No tools/.test(footer) ? "DISABLED ✓" : "still enabled");

const prompt = "build a simple todo list app with separate html, css and javascript. Write the code in markdown code blocks.";
const textarea = page.locator('textarea[placeholder*="Ask anything"]');
await textarea.fill(prompt);
await textarea.press("Enter");
console.log("prompt sent (tools off), waiting for markdown -> files…");

await page.waitForFunction(() => /Files \((\d+)\)/.test(document.body.innerText) && !/Files \(0\)/.test(document.body.innerText), { timeout: 90000 }).catch(() => {});

await page.getByRole("button", { name: /Files/ }).first().click();
await page.waitForTimeout(1000);
const txt = await page.evaluate(() => document.body.innerText);
const count = parseInt(txt.match(/Files \((\d+)\)/)?.[1] || "0", 10);
console.log("workspace file count (from markdown):", count);

// List the file names shown
const names = await page.locator("span.font-mono.truncate").allInnerTexts().catch(() => []);
console.log("files:", names.slice(0, 10).join(", "));

await browser.close();
process.exit(count > 0 ? 0 : 1);
