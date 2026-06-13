/**
 * Cross-pass regression net — the guarantee that a fix to one thing cannot
 * silently break another.
 *
 *   npx tsx scripts/test-regression.mts
 *
 * The deploy engine applies many source transforms in sequence. The risk the user
 * named — "fixing one functionality breaks another" — is precisely that one pass
 * corrupts what another produced. We pin that down with two machine-checkable
 * invariants over the FULL JS transform chain (truncation repair → runtime
 * hardening), run over a corpus of real-world-shaped files:
 *
 *   1. IDEMPOTENCE — applying the chain twice equals applying it once. A pass that
 *      isn't a fixed point is a pass that fights another (or itself) on re-run.
 *   2. NON-CORRUPTION — a file that parsed before the chain still parses after it
 *      (no pass introduces a truncation/imbalance), and a file that was BROKEN is
 *      healthy after. Hardening may add `?? {}`, rename, or stub — never break.
 *
 * Add a new JS-touching pass? Add it to `chain()` here; if it isn't a behaviour-
 * preserving fixed point, this test fails before it can reach a real deploy.
 */
import { repairTruncatedSource } from "../src/lib/deploy/truncation";
import { repairTruncatedJs } from "../src/lib/deploy/truncation";
import { hardenFiles } from "../src/lib/deploy/harden";

interface F { path: string; content: string }

/** The JS source-transform chain as prepareForDeploy applies it (the pure subset). */
function chain(files: F[]): F[] {
  const repaired = repairTruncatedSource(files).files;
  return hardenFiles(repaired).files;
}

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// A corpus spanning the shapes generated apps actually take. The first is BROKEN
// (must end up healthy); the rest are VALID (must survive untouched-or-hardened
// and still parse).
const CORPUS: Array<{ name: string; path: string; content: string; broken?: boolean }> = [
  {
    name: "truncated page (the real failure)",
    path: "src/pages/Settings.jsx",
    broken: true,
    content: `import React, { useState } from 'react';
export default function Settings() {
  const { user } = props.data;
  return <div>{user.name}</div>;
}
function`,
  },
  {
    name: "api client with risky destructure",
    path: "src/api.js",
    content: `export async function login(body) {
  const res = await fetch('/api/login', { method: 'POST', body });
  return res.json();
}
export function parse(res) {
  const { token } = res.data;
  return token;
}`,
  },
  {
    name: "list component mapping API data",
    path: "src/components/Users.jsx",
    content: `import React from 'react';
export default function Users({ data }) {
  return (
    <ul>
      {data.users.map((u) => <li key={u.id}>{u.name}</li>)}
    </ul>
  );
}`,
  },
  {
    name: "template literals + regex + nested braces",
    path: "src/util.ts",
    content: `export const url = (id: string) => \`/api/\${id}?x={y}\`;
export const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-');
export const cfg = { a: { b: { c: 1 } } };`,
  },
  {
    name: "already-hardened (idempotence on prior output)",
    path: "src/safe.js",
    content: `const { token } = (res.data) ?? {};
const items = (state.list ?? []).map((x) => x);
export { token, items };`,
  },
  {
    name: "valid component ending in JSX tag",
    path: "src/App.jsx",
    content: `export default function App() {\n  return (\n    <main className="p-4">\n      <h1>Hi</h1>\n    </main>\n  );\n}`,
  },
];

const files: F[] = CORPUS.map(({ path, content }) => ({ path, content }));

// 1) Idempotence of the whole chain.
const once = chain(files);
const twice = chain(once);
for (let i = 0; i < once.length; i++) {
  check(`idempotent: ${CORPUS[i].name}`, once[i].content === twice[i].content);
}

// 2) Non-corruption: every output JS file parses (analyzer reports it non-truncated).
for (let i = 0; i < once.length; i++) {
  const out = once[i];
  const stillTruncated = repairTruncatedJs(out.path, out.content) !== null;
  check(`chain output parses: ${CORPUS[i].name}`, !stillTruncated, "a pass left the file truncated/unbalanced");
}

// 3) The broken file genuinely got fixed (not merely 'not worse').
const settings = once[0];
check("broken page is healthy after the chain", repairTruncatedJs(settings.path, settings.content) === null);
check("broken page kept its default export", /export default function Settings/.test(settings.content));

// 4) Valid files were not gutted — their exports survive the chain.
check("api client keeps its exports", /export async function login/.test(once[1].content) && /export function parse/.test(once[1].content));
check("list component keeps its default export", /export default function Users/.test(once[2].content));
check("util module keeps all three exports", ["url", "slug", "cfg"].every((n) => once[3].content.includes(n)));

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL REGRESSION TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
