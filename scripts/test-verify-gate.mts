/**
 * Pre-deploy verify-gate: repair-or-block + failure recognition.
 *
 *   npx tsx scripts/test-verify-gate.mts
 */
import { verifyForDeploy, gateOrThrow } from "../src/lib/deploy/verify-gate";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// Truncated JS is repaired in place → deploy may proceed.
const r1 = verifyForDeploy({
  files: [{ path: "src/pages/Settings.jsx", content: "export default function Settings() {\n  return (\n    <div>x\nfunction" }],
});
check("repairs truncated JS and allows deploy", r1.ok && r1.fixesApplied.length > 0);

// C# truncated mid-EXPRESSION can't be safely completed → BLOCK.
const r2 = verifyForDeploy({
  files: [{ path: "Services/X.cs", content: "namespace A;\npublic class X {\n  public int F() {\n    var y = 1 +\n" }],
});
check("blocks unrepairable C# truncation", !r2.ok && r2.blockers.some((b) => /truncated/i.test(b)));

// Clean files → ok, no blockers, nothing applied.
const r3 = verifyForDeploy({
  files: [{ path: "Program.cs", content: "namespace A;\npublic class P { public int N() { return 1; } }\n" }],
});
check("passes clean files untouched", r3.ok && r3.blockers.length === 0 && r3.fixesApplied.length === 0);

// Dockerfile invariant violation is a blocker.
const r4 = verifyForDeploy({
  files: [],
  plan: { stack: "go", framework: "go", dockerfile: "FROM golang:1.22\nRUN go build\n" }, // missing CGO_ENABLED=0
});
check("blocks on a Dockerfile invariant violation", !r4.ok && r4.blockers.some((b) => /CGO_ENABLED/.test(b)));

// Recognises a prior failure from its error log.
const r5 = verifyForDeploy({
  files: [],
  errorLog: "/src/Services/MenuService.cs(130,46): error CS1513: } expected",
});
check("recognises CS1513 as repair-truncated-source", r5.recognized.some((f) => f.id === "repair-truncated-source"));
check("recognised failure carries its module", r5.recognized.some((f) => f.module === "truncation.ts"));

// Flags a genuinely novel failure.
const r6 = verifyForDeploy({ files: [], errorLog: "kernel panic: unknown opcode 0xff in libmystery" });
check("flags a novel failure (author a new rule)", r6.novelFailure);

// Missing server ENTRY: package.json "start" runs a file that was never created →
// the backend would crash on boot and hang the deploy in "pending". BLOCK it.
const r7 = verifyForDeploy({
  files: [{ path: "package.json", content: '{"scripts":{"start":"node src/server.js"},"dependencies":{"express":"^4"}}' }],
});
check("blocks a missing server entry", !r7.ok && r7.blockers.some((b) => /server entry|pending/i.test(b)));

// Server entry present → no entry blocker.
const r8 = verifyForDeploy({
  files: [
    { path: "package.json", content: '{"scripts":{"start":"node src/server.js"}}' },
    { path: "src/server.js", content: "const express=require('express');const app=express();app.listen(3000);" },
  ],
});
check("allows a present server entry", r8.ok);

// Unresolved LOCAL import in the backend → block (would crash with Cannot find module).
const r9 = verifyForDeploy({
  files: [
    { path: "package.json", content: '{"scripts":{"start":"node server.js"}}' },
    { path: "server.js", content: "const routes = require('./routes/claims');\nconst app = require('express')();\napp.listen(3000);" },
    // routes/claims.js was never created.
  ],
});
check("blocks an unresolved local import", !r9.ok && r9.blockers.some((b) => /claims/.test(b)));

// gateOrThrow throws on a blocker, returns on clean.
let threw = false;
try { gateOrThrow({ files: [{ path: "a.cs", content: "class C { void F() { var x = 1 +\n" }] }); } catch { threw = true; }
check("gateOrThrow throws on a blocker", threw);
check("gateOrThrow returns repaired files when ok", gateOrThrow({ files: [{ path: "ok.cs", content: "class C { int N() => 1; }\n" }] }).files.length === 1);

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL VERIFY-GATE TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
