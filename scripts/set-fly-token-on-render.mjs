// One-off: push FLY_API_TOKEN from .env.local to the studio's Render service.
// Reads the secret from .env.local; prints only HTTP status (never the value).
// Usage:  node scripts/set-fly-token-on-render.mjs           (set FLY_API_TOKEN)
//         node scripts/set-fly-token-on-render.mjs --verify   (read-only key check)
import fs from "node:fs";

const SERVICE = "srv-d8hffii8pkls73cd3bu0"; // agentic-ai-studio
const ENV_PATH = new URL("../.env.local", import.meta.url);

// NOTE: .env.local values may be wrapped in quotes. dotenv strips them at
// runtime, so a naive parser must too — otherwise the literal quote chars
// corrupt the value (e.g. a Fly token that then fails auth).
const stripQuotes = (s) => s.replace(/^(['"])([\s\S]*)\1$/, "$2");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = stripQuotes(m[2].trim());
}

const RK = process.env.RENDER_API_KEY;
const auth = { Authorization: "Bearer " + RK };
const base = `https://api.render.com/v1/services/${SERVICE}/env-vars`;

async function listKeys() {
  const r = await fetch(`${base}?limit=100`, { headers: auth });
  const j = await r.json();
  const keys = (Array.isArray(j) ? j : []).map((x) => (x.envVar || x).key).sort();
  return { status: r.status, keys };
}

if (process.argv.includes("--verify")) {
  const { status, keys } = await listKeys();
  console.log("HTTP", status);
  console.log("FLY_API_TOKEN present:", keys.includes("FLY_API_TOKEN"));
  console.log("GITHUB_TOKEN present :", keys.includes("GITHUB_TOKEN"));
} else {
  if (!process.env.FLY_API_TOKEN) {
    console.error("FLY_API_TOKEN missing from .env.local — aborting.");
    process.exit(1);
  }
  const r = await fetch(`${base}/FLY_API_TOKEN`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ value: process.env.FLY_API_TOKEN }),
  });
  console.log("Render set FLY_API_TOKEN -> HTTP", r.status, r.ok ? "(ok)" : await r.text());
  const { keys } = await listKeys();
  console.log("FLY_API_TOKEN now present:", keys.includes("FLY_API_TOKEN"));
}
