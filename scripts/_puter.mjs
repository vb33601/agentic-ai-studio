import { chromium } from "playwright-chromium";
const b = await chromium.launch(); const p = await b.newPage();
p.on("console", m => { const t=m.text(); if(/puter|img|error/i.test(t)) console.log("PAGE:", t.slice(0,160)); });
await p.goto("http://localhost:3000",{waitUntil:"networkidle",timeout:30000});
await p.waitForSelector("text=AI Platform",{timeout:20000});
// wait for puter to load
const loaded = await p.waitForFunction(()=>!!(window.puter && window.puter.ai && window.puter.ai.txt2img), {timeout:15000}).then(()=>true).catch(()=>false);
console.log("window.puter.ai.txt2img available:", loaded);
if (loaded) {
  const result = await p.evaluate(async () => {
    try {
      const el = await window.puter.ai.txt2img("a red apple on a table");
      const src = (el && el.src) ? el.src : (typeof el === "string" ? el : "");
      return { ok: true, type: typeof el, tag: el && el.tagName, srcStart: (src||"").slice(0,40), srcLen: (src||"").length };
    } catch (e) { return { ok: false, error: String(e).slice(0,200) }; }
  });
  console.log("txt2img result:", JSON.stringify(result));
}
await b.close();
