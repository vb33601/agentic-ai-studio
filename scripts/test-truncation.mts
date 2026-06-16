/**
 * Truncated-source repair: correctness + the cross-stack safety net.
 *
 *   npx tsx scripts/test-truncation.mts
 *
 * Two guarantees, both essential to "a fix to one thing must not break another":
 *   1) The repair fixes the real Vercel failure (and other truncation shapes) — the
 *      output re-analyzes as balanced + non-dangling, and the module's export
 *      surface is preserved.
 *   2) It is a strict NO-OP on a corpus of known-good files spanning the JS/TS
 *      family (JSX, template literals, regex, strings full of braces, …). A false
 *      positive would replace valid functionality with a stub, so this is the line
 *      that keeps the engine safe to run on ALL generated code.
 */
import {
  repairTruncatedJs,
  repairTruncatedSource,
  detectTruncatedSources,
} from "../src/lib/deploy/truncation";
import { findAppGaps, findBrokenLocalRefs } from "../src/lib/ai/incomplete-files";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// --- 1) The exact production failure: Settings.jsx truncated after `function`. ---
const SETTINGS_BROKEN = `import React, { useState } from 'react';

export default function Settings() {
  const [tab, setTab] = useState('profile');
  return (
    <div className="settings">
      <h1>Settings</h1>
      <button onClick={() => setTab('profile')}>Profile</button>
    </div>
  );
}

const helpers = [1, 2].map((n) => ({ n }))

function`;

const fixed = repairTruncatedJs("src/pages/Settings.jsx", SETTINGS_BROKEN);
check("real Settings.jsx is detected as truncated", fixed !== null);
check("repaired output preserves the default export", !!fixed && /export default function Settings/.test(fixed));
check("repaired output is no longer truncated", !!fixed && repairTruncatedJs("src/pages/Settings.jsx", fixed!) === null);

// --- 1b) Truncation INSIDE the component (the body itself was cut off). ---
const BODY_CUT = `import React from 'react';
export default function Dashboard() {
  const [data, setData] = useState(null);
  return (
    <div>
      <h1>Dash</h1>`;
const f2 = repairTruncatedJs("src/pages/Dashboard.jsx", BODY_CUT);
check("body-truncated component is repaired", f2 !== null && /export default function Dashboard/.test(f2!));
check("body-truncated repair re-analyzes clean", !!f2 && repairTruncatedJs("x.jsx", f2!) === null);

// --- 1c) Named export truncation in a plain module. ---
const NAMED_CUT = `export const API = 'https://x';
export function fetchUser(id) {
  return fetch(API + '/u/' + id).then(r => r.json())
}
export function fetchPosts(`;
const f3 = repairTruncatedJs("src/api.js", NAMED_CUT);
check("named-export module truncation is repaired", f3 !== null);
check("repair keeps the completed exports", !!f3 && /fetchUser/.test(f3!) && /fetchPosts/.test(f3!));
check("named repair re-analyzes clean", !!f3 && repairTruncatedJs("src/api.js", f3!) === null);

// --- 1d) Idempotency: repairing twice == repairing once. ---
const once = repairTruncatedSource([{ path: "a.jsx", content: SETTINGS_BROKEN }]).files[0].content;
const twice = repairTruncatedSource([{ path: "a.jsx", content: once }]).files[0].content;
check("repair is idempotent (fixed point)", once === twice);

// --- 2) NO-OP on known-good files. A hit here = a false positive that would
//        replace working code with a stub. These MUST all return null. ---
const GOOD: Array<[string, string]> = [
  ["simple component", `export default function App() {\n  return <div className="x">hi</div>;\n}\n`],
  ["template literal with braces", "const q = `SELECT * FROM t WHERE id = ${id} AND name = '{literal}'`;\nexport const Q = q;\n"],
  ["regex with braces/slashes", `export const re = /\\{[^}]*\\}\\/(foo|bar)/g;\nconst x = 1 / 2;\nexport const y = x;\n`],
  ["string containing unbalanced braces", `export const s = "function foo() { return ((( ";\nexport const t = 'a)]}';\n`],
  ["JSX ending in tag", `export default function C() {\n  return (\n    <ul>\n      <li>one</li>\n    </ul>\n  );\n}`],
  ["arrow + ternary, no trailing semicolons", `const a = (x) => x ? 1 : 2\nconst b = [1,2,3].map(n => n * 2)\nexport { a, b }`],
  ["object spread tail", `const base = { a: 1 }\nexport const merged = { ...base, b: 2 }`],
  ["TS generics + as cast", `export const f = <T,>(x: T): T => x as T\nexport type Wrap<T> = { value: T }\n`],
  ["line comment as last line", `export const N = 1\n// trailing comment, file ends here\n`],
  ["block comment at EOF", `export const N = 1;\n/* a closing note */\n`],
  ["division not regex", `export const ratio = width / height;\nexport const half = total / 2;\n`],
  // The combo-deploy regression: a COMPLETE component on ONE line. The closing tags
  // </h1></p></div> must not be mistaken for regex (which corrupted the scan and
  // stubbed the component to `return null` → a blank React app).
  ["single-line JSX component", `import React from 'react';export default function App(){return <div className='min-h-screen bg-slate-50 p-8'><h1 className='text-2xl font-bold'>Combo deploy</h1><p>frontend + backend</p></div>;}`],
  ["single-line nested closing tags", `export const Card = () => <div><span>a</span><b>x</b></div>;\nexport const Two = () => <ul><li>1</li><li>2</li></ul>;`],
  ["JSX with self-closing + division nearby", `export default function C(){const r = w / h;return <div><img src='x'/><br/></div>;}`],
];
for (const [name, content] of GOOD) {
  const r = repairTruncatedJs(name.endsWith("cast") ? "f.tsx" : "f.jsx", content);
  check(`no-op on good file: ${name}`, r === null, "FALSE POSITIVE — would corrupt valid code");
}

// --- 3) Universal detector flags backend truncation (read-only, no mutation). ---
const backend = [
  { path: "Controllers/UserController.cs", content: "public class UserController {\n  public IActionResult Get() {\n    return Ok(" },
  { path: "main.go", content: "package main\nfunc main() {\n  fmt.Println(\"ok\")\n}\n" },
];
const detected = detectTruncatedSources(backend);
check("detector flags the truncated .cs", detected.includes("Controllers/UserController.cs"));
check("detector leaves the valid .go alone", !detected.includes("main.go"));

// --- 4) Broken LOCAL references: a file imports a sibling that was never made.
//        This is the high-precision "a whole file got skipped" signal that keeps
//        the resume loop going even with no truncation. ---
const danglingJs = findBrokenLocalRefs([
  { path: "src/main.jsx", content: "import App from './App.jsx';\nimport './missing.css';\ncreateRoot(el).render(<App/>);" },
  // App.jsx exists; missing.css + ./Header do NOT.
  { path: "src/App.jsx", content: "import { Header } from './components/Header';\nexport default function App(){return <Header/>;}" },
]);
check("flags the missing ./components/Header", danglingJs.some((g) => /Header/.test(g)));
check("flags the missing ./missing.css", danglingJs.some((g) => /missing\.css/.test(g)));
// App.jsx exists, so no flag should name it as the MISSING reference (it appears
// only as an importer in the Header flag, which is fine).
check("does NOT flag the existing ./App.jsx", !danglingJs.some((g) => g.startsWith("`./App.jsx`")));

const danglingPy = findBrokenLocalRefs([
  { path: "app/main.py", content: "from .routes import claims\nfrom .db import session" },
  { path: "app/routes.py", content: "claims = 1" },
  // app/db.py is missing.
]);
check("flags the missing python .db module", danglingPy.some((g) => /db/.test(g)));
check("does NOT flag the existing .routes module", !danglingPy.some((g) => /routes/.test(g)));

const noBrokenRefs = findBrokenLocalRefs([
  { path: "src/main.jsx", content: "import App from './App';\nrender(<App/>);" },
  { path: "src/App.jsx", content: "export default function App(){return <div/>;}" },
]);
check("no broken-ref false positives on a resolved app", noBrokenRefs.length === 0);

// --- 5) findAppGaps is STRUCTURAL, not keyword-gated. A prompt like "insurance
//        claims management system" names no stack, yet a frontend that calls an
//        API with no server present must still flag the missing backend. ---
const feOnlyCallsApi = findAppGaps(
  [
    { path: "index.html", content: '<script type="module" src="/src/main.jsx"></script>' },
    { path: "src/main.jsx", content: "fetch('/api/claims').then(r=>r.json())" },
    { path: "src/App.jsx", content: "export default function App(){return <div/>;}" },
  ],
  "insurance claims management system", // NO backend/api/react keywords
);
check("missing backend flagged structurally (no keywords)", feOnlyCallsApi.some((g) => /BACKEND/i.test(g)));

const beOnlyWithCors = findAppGaps(
  [
    { path: "server.js", content: "const app = express(); app.use(cors({origin: process.env.CORS_ORIGIN})); app.get('/api/claims',(req,res)=>res.json([])); app.listen(3000);" },
    { path: "package.json", content: '{"dependencies":{"express":"^4"}}' },
  ],
  "insurance claims management system",
);
check("missing frontend flagged structurally (CORS wired)", beOnlyWithCors.some((g) => /FRONTEND/i.test(g)));

const completeFullstack = findAppGaps(
  [
    { path: "index.html", content: '<script type="module" src="/src/main.jsx"></script>' },
    { path: "src/main.jsx", content: "import App from './App.jsx';\nfetch('/api/claims')" },
    { path: "src/App.jsx", content: "export default function App(){return <div/>;}" },
    { path: "server/index.js", content: "const app = express(); app.get('/api/claims',(req,res)=>res.json([])); app.listen(3000);" },
  ],
  "insurance claims management system",
);
check("no gaps on a complete full-stack app", completeFullstack.length === 0, completeFullstack.join(" | "));

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL TRUNCATION TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
