import { chromium } from "playwright-chromium";

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("text=AI Platform", { timeout: 20000 });

const fileCount = async () => {
  await page.getByRole("button", { name: "Files", exact: true }).first().click();
  await page.waitForTimeout(800);
  const t = await page.evaluate(() => document.body.innerText);
  return parseInt(t.match(/Files \((\d+)\)/)?.[1] || "0", 10);
};

// 1. Generate a file, then wait for the save (PUT /messages) to actually land.
await page.getByRole("button", { name: "Chat", exact: true }).first().click();
const ta = page.locator('textarea[placeholder*="Ask anything"]');
const saved = page.waitForResponse(
  (r) => /\/api\/chats\/.+\/messages/.test(r.url()) && r.request().method() === "PUT",
  { timeout: 90000 }
);
await ta.fill("create index.html with an h1 that says Persist Test");
await ta.press("Enter");
await page.waitForFunction(() => /Files \(([1-9]\d*)\)/.test(document.body.innerText), { timeout: 90000 }).catch(() => {});
console.log("after generate, files:", await fileCount());
await saved.then(() => console.log("save PUT completed")).catch(() => console.log("save PUT not seen"));
await page.waitForTimeout(1500);

// 2. Reload the page (simulates coming back later).
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("text=AI Platform", { timeout: 20000 });
await page.waitForTimeout(1500);
console.log("after reload, files:", await fileCount());
const sessionsVisible = await page.evaluate(() => /Persist Test|create index/.test(document.body.innerText));
console.log("chat session visible in sidebar after reload:", sessionsVisible);

// 3. Click the session to reopen it.
const sess = page.locator("text=/Persist Test|create index/").first();
if (await sess.count()) {
  await sess.click();
  await page.waitForTimeout(2500);
  console.log("after reopening chat, files:", await fileCount());
}

await browser.close();
