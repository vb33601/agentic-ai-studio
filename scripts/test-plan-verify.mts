/**
 * Subsystem D — plan-based end-to-end verification.
 *
 *   npx tsx scripts/test-plan-verify.mts
 *
 * Runs fully offline by injecting the judge (the real judge is the LLM); the
 * deterministic heuristic + runtime-signal folding are exercised directly.
 */
import {
  verifyAgainstPlan,
  parsePlanSteps,
  judgeHeuristic,
  type JudgeFn,
  type PlanStepCheck,
} from "../src/lib/quality/plan-verify";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// --- parsePlanSteps ---------------------------------------------------------
const steps = parsePlanSteps(
  "- Build the React entry (index.html + main.jsx)\n* Create the TodoList component\n1. Wire the API\n1. Wire the API\n   \n- ok",
);
check("parses mixed bullet/number markers (drops dup + too-short)", steps.length === 3, JSON.stringify(steps));
check("dedupes identical steps", steps.filter((s) => s === "Wire the API").length === 1);

// --- injected judge: clean pass ---------------------------------------------
const allDone: JudgeFn = async (s) => ({
  steps: s.map((step): PlanStepCheck => ({ step, status: "done" })),
  summary: "looks complete",
});
const plan = "- Build entry\n- Create list view\n- Wire the API";
const files = [{ path: "src/main.jsx", content: "import App from './App'" }];

const r1 = await verifyAgainstPlan({ plan, files, phase: "post-generation", judge: allDone });
check("clean pass is ok + checked", r1.ok && r1.checked && r1.score === 1, JSON.stringify(r1));
check("clean pass has no gaps", r1.gaps.length === 0);

// --- injected judge: a missing step blocks ok -------------------------------
const oneMissing: JudgeFn = async (s) => ({
  steps: s.map((step, i): PlanStepCheck => ({ step, status: i === 1 ? "missing" : "done" })),
  summary: "one feature missing",
});
const r2 = await verifyAgainstPlan({ plan, files, phase: "pre-deploy", judge: oneMissing });
check("a missing step makes ok=false", !r2.ok);
check("missing step surfaces as a gap", r2.gaps.some((g) => /Missing/.test(g)));

// --- no plan → skipped, never blocks ----------------------------------------
const r3 = await verifyAgainstPlan({ plan: "", files, phase: "pre-deploy" });
check("no plan → checked=false, ok=true", !r3.checked && r3.ok);

// --- judge declines → deterministic heuristic fallback ----------------------
const decline: JudgeFn = async () => null;
const r4 = await verifyAgainstPlan({
  plan: "- Build the TodoList component\n- Add a payment checkout flow",
  files: [{ path: "src/TodoList.jsx", content: "export function TodoList(){ return null }" }],
  phase: "post-generation",
  judge: decline,
});
check("declined judge falls back to heuristic (checked=false)", !r4.checked);
check("heuristic finds the absent feature missing", r4.gaps.some((g) => /payment|checkout/i.test(g)), JSON.stringify(r4.gaps));

// --- heuristic directly -----------------------------------------------------
const h = judgeHeuristic(
  ["Build the dashboard chart", "Add websocket notifications"],
  [{ path: "Dashboard.jsx", content: "const chart = renderChart(); // dashboard" }],
);
check("heuristic marks covered step done", h[0].status === "done", JSON.stringify(h));
check("heuristic marks uncovered step missing", h[1].status === "missing");

// --- post-deploy folds runtime signals --------------------------------------
const r5 = await verifyAgainstPlan({
  plan,
  files,
  phase: "post-deploy",
  judge: allDone,
  health: { healthy: false, status: 502 },
});
check("unhealthy backend makes post-deploy not ok", !r5.ok);
check("unhealthy backend adds a runtime gap", r5.gaps.some((g) => /not serving|502/i.test(g)));

const r6 = await verifyAgainstPlan({
  plan,
  files,
  phase: "post-deploy",
  judge: allDone,
  smoke: { ok: false, issues: ["Uncaught TypeError on load"] },
});
check("failed smoke makes post-deploy not ok", !r6.ok);
check("failed smoke adds a runtime gap", r6.gaps.some((g) => /smoke|TypeError/i.test(g)));

// A healthy live app with all steps done passes end-to-end.
const r7 = await verifyAgainstPlan({
  plan,
  files,
  phase: "post-deploy",
  judge: allDone,
  health: { healthy: true, status: 200 },
  smoke: { ok: true, issues: [] },
});
check("healthy live app + all steps done is ok", r7.ok && r7.checked);

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL PLAN-VERIFY TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
