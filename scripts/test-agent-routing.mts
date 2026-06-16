/**
 * Agent routing: a complete multi-module APP/SYSTEM must reach the appBuilder agent
 * (FULLSTACK_RULES — builds the whole thing), NOT the terse "coding" agent ("build
 * what was asked, then stop") which emits a couple files and stops. Equally, plain
 * coding tasks must NOT be over-routed to appBuilder.
 *
 *   npx tsx scripts/test-agent-routing.mts
 */
import { detectAgentType } from "../src/lib/ai/agents";

let fails = 0;
const check = (prompt: string, expected: string) => {
  const got = detectAgentType(prompt);
  const ok = got === expected;
  console.log(`  ${ok ? "✓" : "✗"} ${expected.padEnd(12)} ${ok ? "" : `(got ${got}) `}:: ${prompt.slice(0, 56)}`);
  if (!ok) fails++;
};

// Full apps / systems → appBuilder (the failures the user hit: "X management
// system", "end to end", ".NET backend + React", "N modules").
for (const p of [
  "Build a complete end to end insurance claims management system having 40-50 modules with .net backend and react MUI with tailwind CSS",
  "Build a complete end to end restaurant management system having backend and frontend",
  "Build a complete end to end stock portfolio management system",
  "build a complete end to end visitor management system",
  "Generate end to end inventory management system",
  "Build a full-stack SaaS CRM platform",
  "Create a responsive e-commerce website with both react frontend and backend",
  "Build a full-stack foreign exchange management platform",
  "build a complete end-to-end social media application",
]) check(p, "appBuilder");

// Plain coding tasks → coding (must NOT over-route to appBuilder).
for (const p of [
  "write a function to reverse a string",
  "fix this bug in my code",
  "create a python script to rename files",
  "debug this regex",
]) check(p, "coding");

// Other specialists unchanged.
check("build a snake game", "gameDev");
check("research the latest AI news", "research");
check("design a reusable button component", "uiux");
check("generate an image of a sunset", "orchestrator");
check("summarize this document", "fileAnalysis");

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL AGENT-ROUTING TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
