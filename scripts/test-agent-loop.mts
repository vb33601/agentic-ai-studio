/**
 * Headless tests for the Phase-1 agentic edit engine (no LLM, no credits, CI-safe):
 *  1. Every template is COMPLETE (no truncation / broken local refs / missing
 *     namespaces) and single-service templates are DEPLOY-READY (Dockerfile
 *     invariants pass) — i.e. each build genuinely starts from a runnable app.
 *  2. VirtualFileSystem exact-match edit semantics (the opencode safety model).
 *  3. Edit tools mutate the VFS and surface errors instead of throwing.
 *  4. Template selection routes representative requests to the right starter.
 *  5. The loop module wires together.
 *
 *   npx tsx scripts/test-agent-loop.mts
 */
import { TEMPLATES, selectTemplate, type TemplateKey } from "../src/lib/ai/templates/registry";
import { STACK_MATRIX, coverageReport } from "../src/lib/ai/templates/matrix";
import { certifyFiles, errorsFromLog, buildCertifyFixPrompt } from "../src/lib/ai/agent/certify";
import type { SandboxFactory } from "../src/lib/deploy/sandbox-verify";
import { getSeed, SEED_KEYS } from "../src/lib/ai/templates/seeds";
import { runScaffolder, parseProjectDump } from "../src/lib/ai/templates/scaffolder";
import { resolveStartTemplate } from "../src/lib/ai/templates/resolve";
import { VirtualFileSystem, EditError } from "../src/lib/ai/agent/vfs";
import { makeEditTools } from "../src/lib/ai/agent/tools";
import { runAgentLoop } from "../src/lib/ai/agent/loop";
import { findIncompleteFiles, findBrokenLocalRefs, findMissingNamespaces } from "../src/lib/ai/incomplete-files";
import { detectStackPlan } from "../src/lib/deploy/dockerfile";
import { checkDockerfileInvariants } from "../src/lib/deploy/stack-invariants";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (cond) { pass++; /* quiet on success */ }
  else { fail++; console.log(`  ✗ ${label}${detail ? "  — " + detail : ""}`); }
};
const section = (s: string) => console.log(`\n${s}`);

// Tool executors accept (input, options); we don't use options here.
const exec = (t: { execute?: (i: unknown, o: unknown) => unknown }, input: unknown) =>
  (t.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {});

// ---------------------------------------------------------------------------
section("1. Templates are complete + deploy-ready");
const SINGLE_SERVICE: TemplateKey[] = ["static", "react-vite", "vue-vite", "node-express"];
for (const key of Object.keys(TEMPLATES) as TemplateKey[]) {
  const t = TEMPLATES[key];
  const files = Object.entries(t.files).map(([path, content]) => ({ path, content }));
  ok(files.length > 0, `${key}: has files`);

  const trunc = findIncompleteFiles(files);
  ok(trunc.length === 0, `${key}: no truncated files`, trunc.join(", "));

  const broken = findBrokenLocalRefs(files);
  ok(broken.length === 0, `${key}: no broken local imports`, broken.slice(0, 2).join(" | "));

  const ns = findMissingNamespaces(files);
  ok(ns.length === 0, `${key}: no missing namespaces`, ns.slice(0, 2).join(" | "));

  // Deploy-readiness: single-service templates must satisfy the deploy engine.
  if (SINGLE_SERVICE.includes(key)) {
    let errs: string[] = [];
    let stack = "?";
    try {
      const plan = detectStackPlan(files);
      stack = `${plan.stack}/${plan.framework}`;
      errs = checkDockerfileInvariants(plan);
    } catch (e) {
      errs = [`detect threw: ${(e as Error).message}`];
    }
    ok(errs.length === 0, `${key}: deploy-ready (${stack})`, errs.slice(0, 2).join(" | "));
  } else {
    // Multi-service (fullstack) — just confirm both halves are present.
    const paths = files.map((f) => f.path);
    ok(paths.some((p) => p.startsWith("backend/")) && paths.some((p) => p.startsWith("frontend/")),
      `${key}: has backend + frontend halves`);
  }
}

// ---------------------------------------------------------------------------
section("2. VirtualFileSystem exact-match edit semantics");
{
  const vfs = new VirtualFileSystem({ "a.js": "const x = 1;\nconst y = 1;\n" });
  ok(vfs.has("a.js"), "seed present");

  // write + path normalization
  vfs.write("./src/b.js", "export const b = 2;\n");
  ok(vfs.has("src/b.js"), "write normalizes ./ prefix");
  ok(vfs.changed.has("src/b.js"), "write records change");

  // exact unique edit
  const n = vfs.edit("a.js", "const x = 1;", "const x = 42;");
  ok(n === 1 && vfs.read("a.js")!.includes("const x = 42;"), "exact unique edit applied");

  // 0-match errors
  let threw = false;
  try { vfs.edit("a.js", "does-not-exist", "z"); } catch (e) { threw = e instanceof EditError; }
  ok(threw, "edit with no match throws EditError");

  // multi-match without replaceAll errors; WITH replaceAll replaces every one.
  const vfsM = new VirtualFileSystem({ "c.js": "a a a" });
  threw = false;
  try { vfsM.edit("c.js", "a", "b"); } catch (e) { threw = e instanceof EditError; }
  ok(threw && vfsM.read("c.js") === "a a a", "multi-match without replaceAll throws + leaves file untouched");
  const c = vfsM.edit("c.js", "a", "b", true);
  ok(c === 3 && vfsM.read("c.js") === "b b b", "replaceAll replaces every occurrence");

  // identical strings error
  threw = false;
  try { vfs.edit("a.js", "const y = 1;", "const y = 1;"); } catch { threw = true; }
  ok(threw, "identical old/new throws");

  // delete + rename
  vfs.remove("src/b.js");
  ok(!vfs.has("src/b.js") && vfs.deleted.has("src/b.js"), "remove deletes + records");
  vfs.rename("a.js", "renamed.js");
  ok(!vfs.has("a.js") && vfs.has("renamed.js"), "rename moves content");

  // serialize
  const s = vfs.serialize();
  ok(s.includes("renamed.js"), "serialize lists files");
}

// ---------------------------------------------------------------------------
section("3. Edit tools mutate VFS + surface errors (no throw)");
{
  const vfs = new VirtualFileSystem({ "index.js": "console.log(1);\n" });
  const changes: string[] = [];
  const tools = makeEditTools(vfs, { onChange: (op, p) => changes.push(`${op}:${p}`) });

  const w = await exec(tools.write_file, { path: "src/App.jsx", content: "export default () => null;\n" });
  ok(w.ok === true && vfs.has("src/App.jsx"), "write_file creates file");
  ok(changes.includes("write:src/App.jsx"), "onChange fired for write");

  const badEdit = await exec(tools.edit_file, { path: "index.js", oldString: "NOPE", newString: "x" });
  ok(badEdit.ok === false && typeof badEdit.error === "string", "bad edit returns error, does not throw");

  const goodEdit = await exec(tools.edit_file, { path: "index.js", oldString: "console.log(1);", newString: "console.log(2);" });
  ok(goodEdit.ok === true && vfs.read("index.js")!.includes("(2)"), "good edit applies");

  const missing = await exec(tools.read_file, { path: "nope.js" });
  ok(missing.ok === false, "read_file missing returns error");

  const listed = await exec(tools.list_files, {});
  ok(Array.isArray(listed.files) && (listed.files as string[]).includes("src/App.jsx"), "list_files returns paths");

  const del = await exec(tools.delete_file, { path: "src/App.jsx" });
  ok(del.ok === true && !vfs.has("src/App.jsx"), "delete_file removes");

  const ren = await exec(tools.rename_file, { from: "index.js", to: "server.js" });
  ok(ren.ok === true && vfs.has("server.js"), "rename_file moves");
}

// ---------------------------------------------------------------------------
section("4. Template selection routing");
{
  const cases: [string, TemplateKey][] = [
    ["Build a marketing landing page", "static"],
    ["Make a snake game on an HTML canvas", "static"],
    ["A React todo app that saves to localStorage", "react-vite"],
    ["Build a Vue 3 notes app", "vue-vite"],
    ["An Express REST API for tasks, backend only", "node-express"],
    ["Build a notes app with an Express backend and a React frontend", "express-react"],
    ["A CRM app with a database to manage customers", "express-react"],
    ["Build a dashboard UI", "react-vite"],
  ];
  for (const [req, expected] of cases) {
    const got = selectTemplate(req).key;
    ok(got === expected, `selectTemplate("${req.slice(0, 32)}…") → ${expected}`, got !== expected ? `got ${got}` : "");
  }
}

// ---------------------------------------------------------------------------
section("5. Loop module wiring");
ok(typeof runAgentLoop === "function", "runAgentLoop is callable");

// ---------------------------------------------------------------------------
section("6. Full stack-matrix coverage (no deploy-engine stack left out)");
{
  const rep = coverageReport();
  ok(rep.uncovered.length === 0, "every known deploy stack has a coverage entry", rep.uncovered.join(", "));
  ok(rep.stacks >= rep.knownStacks, `covers all ${rep.knownStacks} stacks (${rep.stacks} covered)`);
  console.log(`    matrix: ${rep.entries} entries — curated=${rep.byStrategy.curated} scaffold=${rep.byStrategy.scaffold} seed=${rep.byStrategy.seed}`);

  for (const e of STACK_MATRIX) {
    if (e.strategy === "curated") {
      ok(!!e.curatedKey && !!TEMPLATES[e.curatedKey], `curated ${e.stack}/${e.framework} → real template`, e.curatedKey ?? "no key");
    } else if (e.strategy === "scaffold") {
      ok(!!e.scaffold?.command && e.scaffold.command.includes("{name}"), `scaffold ${e.stack}/${e.framework} has official command`, e.scaffold?.tool ?? "");
    }
  }
}

// ---------------------------------------------------------------------------
section("7. Phase-2 certifier (offline, mock sandbox)");
{
  // A scripted sandbox: each run() call returns the next scripted result, so we can
  // simulate "install ok, build FAILS" then "install ok, build PASSES".
  const fakeFactory = (results: Array<{ exitCode: number; stderr?: string; stdout?: string }>): SandboxFactory => {
    let i = 0;
    return async () => ({
      writeFiles: async () => {},
      run: async () => results[Math.min(i++, results.length - 1)] ?? { exitCode: 0, stdout: "", stderr: "" },
      domain: (p: number) => `http://localhost:${p}`,
      stop: async () => {},
    });
  };
  const nodeFiles = [
    { path: "package.json", content: '{"name":"x","scripts":{"build":"vite build"},"dependencies":{"react":"^18"}}' },
    { path: "src/main.jsx", content: "import App from './App.jsx';\n" },
    { path: "src/App.jsx", content: "export default function App(){return null;}" },
  ];

  // Build FAILS → ran:true, ok:false, errors extracted from the log.
  const failing = await certifyFiles(nodeFiles, {
    stack: "node",
    factory: fakeFactory([{ exitCode: 0 }, { exitCode: 1, stderr: "src/App.jsx: error TS2304: Cannot find name 'foo'.\nnpm ERR! build failed" }]),
  });
  ok(failing.ran === true, "certify ran with injected factory");
  ok(failing.ok === false, "failing build → ok:false");
  ok(failing.errors.some((e) => /TS2304|build failed|error/i.test(e)), "errors extracted from build log", failing.errors.slice(0, 1).join(""));

  // Build PASSES → ran:true, ok:true, no errors.
  const passing = await certifyFiles(nodeFiles, { stack: "node", factory: fakeFactory([{ exitCode: 0 }, { exitCode: 0 }]) });
  ok(passing.ran === true && passing.ok === true && passing.errors.length === 0, "passing build → ok:true, no errors");

  // No factory + no sandbox configured → skipped cleanly (ran:false, ok:true).
  const skipped = await certifyFiles(nodeFiles, { stack: "node", factory: undefined });
  ok(skipped.ran === false && skipped.ok === true, "no sandbox → skipped (ran:false, ok:true, non-blocking)");

  // errorsFromLog + fix prompt.
  const errs = errorsFromLog({ blocker: "build failed", log: "line1\nerror: boom\nline3", ok: false } as never);
  ok(errs.some((e) => /boom|build failed/i.test(e)), "errorsFromLog picks error lines");
  ok(buildCertifyFixPrompt(failing).includes("BUILD FAILED"), "fix prompt includes the failure + errors");
}

// ---------------------------------------------------------------------------
section("8. Seeds are complete + detectable (all matrix seed stacks)");
{
  for (const key of SEED_KEYS) {
    const t = getSeed(t2stack(key), key);
    const files = Object.entries(t.files).map(([path, content]) => ({ path, content }));
    ok(files.length > 0, `seed ${key}: has files`);
    ok(findIncompleteFiles(files).length === 0, `seed ${key}: not truncated`);
    ok(findBrokenLocalRefs(files).length === 0, `seed ${key}: no broken refs`, findBrokenLocalRefs(files).slice(0, 1).join(""));
  }
  // Spot-check stack detection on the server seeds.
  for (const [fw, wantStack] of [["fastapi", "python"], ["go", "go"], ["rust", "rust"], ["deno", "deno"]] as const) {
    const files = Object.entries(getSeed(wantStack, fw).files).map(([path, content]) => ({ path, content }));
    ok(detectStackPlan(files).stack === wantStack, `seed ${fw} detects as ${wantStack}`, detectStackPlan(files).stack);
  }
}

// helper: most seed keys map to their own stack; framework variants map to a base.
function t2stack(key: string): string {
  if (["fastapi", "flask", "python"].includes(key)) return "python";
  if (["sinatra", "ruby"].includes(key)) return "ruby";
  if (["scala", "java"].includes(key)) return "java";
  return key;
}

// ---------------------------------------------------------------------------
section("9. Scaffolder executor (offline, mock sandbox)");
{
  const F = "===AIP_FILE::";
  const E = "===AIP_ENDFILE===";
  const dump = `${F}package.json\n{"name":"x"}\n\n${E}\n${F}src/App.jsx\nexport default () => null;\n\n${E}\n`;
  const parsed = parseProjectDump(dump);
  ok(parsed.length === 2, "parseProjectDump parses both files", String(parsed.length));
  ok(parsed.some((f) => f.path === "package.json") && parsed.some((f) => f.path === "src/App.jsx"), "parsed paths correct");

  const scaffoldFactory: SandboxFactory = async () => ({
    writeFiles: async () => {},
    run: async (_cmd: string, args: string[]) => {
      const script = args?.[1] || "";
      return { exitCode: 0, stdout: script.includes("AIP_FILE") ? dump : "", stderr: "" };
    },
    stop: async () => {},
  });
  const files = await runScaffolder({ tool: "create-vite", command: "npm create vite@latest {name} -- --template react", post: ["npm install"] }, { factory: scaffoldFactory });
  ok(files.length === 2, "runScaffolder returns produced files", String(files.length));
}

// ---------------------------------------------------------------------------
section("10. Start-template resolution across the matrix");
{
  // Curated path (no specific non-curated stack named).
  const react = await resolveStartTemplate("Build a React todo app");
  ok(react.strategy === "curated" && react.template.stack === "node", "react → curated node template", react.strategy);

  // Seed path (Go named, no sandbox needed).
  const go = await resolveStartTemplate("Build a Go HTTP JSON API", { factory: null });
  ok(go.strategy === "seed" && go.template.stack === "go", "go → seed", `${go.strategy}/${go.template.stack}`);

  // Scaffold entry without a sandbox → runnable fallback (never empty).
  const django = await resolveStartTemplate("Build a Django REST API", { factory: null });
  ok(django.strategy === "scaffold-fallback" && Object.keys(django.template.files).length > 0, "django (no sandbox) → runnable fallback", django.strategy);

  // Scaffold entry WITH a mock sandbox → runs the official generator.
  const F = "===AIP_FILE::", E = "===AIP_ENDFILE===";
  const dump = `${F}package.json\n{"name":"next"}\n\n${E}\n${F}app/page.tsx\nexport default () => null;\n\n${E}\n`;
  const mockFactory: SandboxFactory = async () => ({
    writeFiles: async () => {},
    run: async (_c: string, a: string[]) => ({ exitCode: 0, stdout: (a?.[1] || "").includes("AIP_FILE") ? dump : "", stderr: "" }),
    stop: async () => {},
  });
  const next = await resolveStartTemplate("Build a Next.js blog", { factory: mockFactory });
  ok(next.strategy === "scaffold" && Object.keys(next.template.files).length === 2, "next (mock sandbox) → scaffold", `${next.strategy}/${Object.keys(next.template.files).length}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(48)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log("=".repeat(48));
process.exit(fail === 0 ? 0 : 1);
