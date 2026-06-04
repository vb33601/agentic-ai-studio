import { chromium } from "playwright-chromium";
import { readFileSync } from "fs";

const cfg = Object.fromEntries(readFileSync("/tmp/reopen-cid.txt", "utf8").trim().split("\n").map((l) => l.split("=")));
const { CID, U } = cfg;
console.log("testing chat", CID, "user", U);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
// Seed identity + open chat, exactly like a returning user.
await page.evaluate(({ uid, cid }) => {
  localStorage.setItem("aip-user-id", uid);
  localStorage.setItem("chat-store", JSON.stringify({ state: { activeChatId: cid, sidebarOpen: true }, version: 0 }));
}, { uid: U, cid: CID });

await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("text=AI Platform", { timeout: 20000 });
await page.waitForTimeout(3000); // allow load + extraction

// Is the conversation visible?
const msgsVisible = await page.evaluate(() => /build a page|Done\./.test(document.body.innerText));
console.log("messages visible:", msgsVisible);

// Files populated?
await page.getByRole("button", { name: "Files", exact: true }).first().click();
await page.waitForTimeout(800);
const count = parseInt((await page.evaluate(() => document.body.innerText)).match(/Files \((\d+)\)/)?.[1] || "0", 10);
console.log("files after reopen:", count);

// Preview renders?
await page.getByRole("button", { name: "Preview", exact: true }).first().click();
await page.waitForTimeout(1500);
let previewOk = false;
for (const f of page.frames()) { try { const t = await f.evaluate(() => document.body?.innerText); if (t && /Reopen Works/.test(t)) previewOk = true; } catch {} }
console.log("preview renders:", previewOk);
console.log("pageerrors:", errors.slice(0, 3));

await browser.close();
process.exit(count > 0 ? 0 : 1);
