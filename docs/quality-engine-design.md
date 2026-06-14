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
- **Phase 3 (implemented + live-verified):** `sandbox-verify.ts` builds the app in
  an ephemeral Vercel Sandbox before deploy, with the bounded auto-fix → retry loop
  (`DEFAULT_AUTO_FIXERS` + `matchKnownFix`), plus a **run/smoke tier** that boots the
  app and HTTP-probes it on its `.vercel.run` domain (soft signal — reports `runOk`/
  `runWarning`, never false-blocks). Per-stack recipes (`recipeFor`) cover **all 40
  stacks** in two tiers: a RELIABLE blocking tier (node/static/python/.NET/Go/Rust/
  C++/Java/Ruby/PHP/Deno — toolchain dependably available; the build blocks on
  failure, e.g. `ruby -c`/`php -l` catch truncation) and a BEST-EFFORT tier (the
  rest — toolchain install attempted in the node sandbox; if the Amazon-Linux repo
  lacks it the `setup` phase FAIL-OPENS and skips, so it never false-blocks and the
  remote Docker build verifies instead). `vercel-sandbox-runner.ts` is the real adapter — **auth follows
  the deploy path**: `inferScope({ token })` creates/reuses a sandbox project from
  `VERCEL_TOKEN` alone (no fixed team/project ids). `@vercel/sandbox` is a real dep
  in `serverExternalPackages` (never bundled). `sandboxGate()` is wired into the
  deploy route's Node-backend + frontend paths.
  - **Activation:** set `SANDBOX_VERIFY=true` (gated behind a flag, NOT mere token
    presence, because a sandbox install+build can exceed the route's 60s Hobby
    budget — prefer Render/Docker which has no cap). Token-only auth otherwise.
  - **Live-verified:** an Express app builds in the sandbox AND boots + answers the
    HTTP probe (`ok:true, runOk:true`) with token-only auth (inferScope created the
    project on the go).
  - **Live validation (`scripts/validate-recipes.mts`, all 40 stacks):** **~27
    BUILT** in the sandbox — dnf set (bun, static, python, dotnet, go, rust, cpp,
    ruby, php, deno, perl, lua, r, tcl, java[Corretto], ocaml) + node, + official
    downloads (nim/d/zig via `.tar.xz`+`xz`, julia/crystal/vlang/dart, haxe, lisp[SBCL
    binary], racket). The remaining ~13 fail-open SKIP — their toolchain isn't
    feasible in a node microVM: **erlang/elixir/gleam** (no Erlang in the AL2023 repo),
    **ada/pascal/prolog** (no gnat/fpc/swipl), **haskell** (ghcup too heavy),
    **clojure/swift/ballerina/raku** (heavy/uncertain installs), **powershell** (runtime
    deps), **hack** (HHVM is Debian/Ubuntu-only) — all verified by the remote Docker
    build instead. **0 BLOCK** across all 40, every run (the key safety property).
  - **Remaining (Phase 3c):** browser-level flow smoke (agent-browser snapshot
    pattern) for richer UI verification; Java/Rust recipes; promote learned fixes
    via `learn.ts`; sandbox snapshots for faster startup.

Every phase keeps the test harness green (`npm run test:all`) and the
fail-open guarantee.
