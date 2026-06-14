# Quality Engine — Architecture & Phased Plan

Goal: every prompt becomes a high-quality, web-grounded instruction; every
generated app is hardened for UI/UX + a secure/fast backend before deploy; and no
deploy ships unless the app actually builds (and, where feasible, runs the full
flow). This applies across all ~49 configured stacks.

This is additive and **fail-open**: every new step has a timeout + fallback, so it
can never break an existing chat or deploy. It builds on what already exists rather
than duplicating it:

| Concern | Existing module (reuse) |
|---|---|
| Prompt analyze / preprocess / augment / score | `src/lib/ai/prompt-pipeline.ts` |
| Web search (Tavily → Serper → DuckDuckGo, fail-open) | `src/lib/ai/web-search.ts` (`searchWeb`) |
| Per-framework rule research + registry | `src/lib/deploy/preflight.ts`, `distill.ts` |
| Deterministic deploy fixes + recognition | `src/lib/deploy/fix-registry.ts` (`matchKnownFix`, `rankFixes`) |
| Truncation repair + invariants (static gate) | `truncation.ts`, `stack-invariants.ts` |
| Outcome-weighted learning | `src/lib/deploy/learn.ts` |

---

## Subsystem A — Web-grounded prompt enhancer + prompt library

**Flow:** user prompt → `analyzePrompt()` (existing) → **prompt library** lookup
(intent → curated template) → on a miss, **cached web research** (`searchWeb`)
distilled into directives → merged augmentation appended via the existing
`buildAugmentation()` path.

- **Prompt library** (`src/lib/quality/prompt-library.ts`): a curated directory of
  high-quality prompt templates keyed by intent (auth app, dashboard, CRUD, chat
  UI, landing page, e-commerce, …) and by stack-quality directives (security,
  performance, a11y, responsive UI). Each entry is a stable id + matcher + the
  directive text. **Library-first**: a matched template is instant and free.
- **Enhancer** (`src/lib/quality/prompt-enhancer.ts`): library-first; only calls
  `searchWeb` when no template matches the detected intent. Results are **cached by
  intent** (so repeat prompts are instant) and research can run in the **background**
  to apply on the next turn. Search is behind an injectable interface so it's
  testable offline and degrades to library-only when no key is set.
- **Hooks (Phase 2 wiring):** chat generation (`/api/chat`, via the prompt-pipeline
  preprocess step) and pre-deploy (modify-before-deploy directives).

## Subsystem B — Pre-deploy app quality pass

Before deploy, run the generated app through high-quality, stack-aware prompts that
harden: UI/UX (responsive, accessible, consistent design system, loading/empty/error
states), and backend (input validation, authn/authz, parameterized queries, secrets
hygiene, rate limiting, pagination/N+1, caching). Implemented as a quality-directive
set in the prompt library (`stack-quality` entries) + an LLM refinement pass reusing
`prompt-pipeline` postprocess/repair. Fail-open: if refinement times out, the
original app deploys.

## Subsystem C — Pre-deploy build → run → verify → fix loop

Two tiers, because the deploy server is serverless (no Docker/flyctl) and cannot
build arbitrary stacks itself:

1. **Static gate (`src/lib/deploy/verify-gate.ts`) — implemented Phase 1.**
   Runs all static build-correctness checks (truncation, Dockerfile invariants,
   stack-specific shape) over the prepared files, **auto-fixes** known error classes
   (`matchKnownFix` + the deterministic passes), and returns a structured report:
   `{ ok, blockers[], fixesApplied[], recognized[] }`. If `ok` is false the deploy
   is **blocked with a precise, actionable error** instead of shipping a doomed
   build. This is the "fix it, or report and don't deploy broken" engine.

2. **Sandbox full-flow test (Vercel Sandbox) — Phase 3.**
   For stacks worth the cost, spin up an ephemeral microVM, run the real build +
   boot + smoke-test the primary flow, capture failures, feed them back through the
   auto-fix loop (`matchKnownFix` → apply → retry, bounded), and only deploy when
   green. Unmatched failures (`unmatchedFailure`) are surfaced and logged so a new
   rule can be authored — the engine keeps learning (`learn.ts`).

**Loop:** prepare → static gate (fix/retry) → [sandbox build+run+flow (fix/retry)]
→ deploy if green, else return the error + the files at fault.

---

## Phasing

- **Phase 1 (this change):** `verify-gate.ts` (static gate + auto-fix report) wired
  as the deploy backbone; `prompt-library.ts` + `prompt-enhancer.ts` (library-first,
  cached Tavily-on-miss) with tests. Foundations, fully tested, no new infra.
- **Phase 2:** wire the enhancer into `/api/chat` (preprocess) and into the deploy
  modify-before-deploy step; expand the library; add Subsystem B refinement.
- **Phase 3 (implemented — build tier):** `sandbox-verify.ts` builds the app in an
  ephemeral Vercel Sandbox before deploy, with the bounded auto-fix → retry loop
  (`DEFAULT_AUTO_FIXERS` + `matchKnownFix`); per-stack recipes (`recipeFor`, node/
  static today, additive). `vercel-sandbox-runner.ts` is the real adapter (lazy,
  runtime-constructed import so the optional `@vercel/sandbox` dep never breaks
  `next build`) + `sandboxGate()`, wired opt-in + fail-open into the deploy route's
  Node-backend and frontend paths. **Activate** with `npm i @vercel/sandbox` and
  `VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID` (OIDC is automatic on Vercel).
  - **Remaining (Phase 3b):** the live RUN + browser flow tier (boot the app +
    agent-browser smoke per the sandbox snapshot pattern) layered on the build tier;
    compiled-stack recipes (.NET/Java/Go/…); promote learned fixes via `learn.ts`.

Every phase keeps the test harness green (`npm run test:all`) and the
fail-open guarantee.
