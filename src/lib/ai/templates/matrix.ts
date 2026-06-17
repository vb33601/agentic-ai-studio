/**
 * STACK COVERAGE MATRIX — how the platform guarantees a runnable starting point
 * for the FULL breadth of stacks (the same ~38 languages / 26+ frameworks the
 * deploy engine in dockerfile.ts already supports), without hand-maintaining
 * hundreds of templates.
 *
 * Three tiers, in order of how "100% working" is CERTIFIED:
 *
 *  1. "curated"  — a small set of hand-authored, inline templates for the highest
 *                  frequency stacks (see registry.ts). Certified by a local
 *                  build/boot run in the sandbox (Phase 2) and pinned in CI.
 *
 *  2. "scaffold" — generated on demand by the stack's OFFICIAL tool (create-vite,
 *                  create-next-app, django-admin, dotnet new, rails new, cargo,
 *                  Spring Initializr, …). "100% working" is certified by the
 *                  official tool itself — always current, nothing for us to rot.
 *                  This is how breadth scales to 100-200 stacks.
 *
 *  3. "seed"     — a minimal, deploy-engine-aligned starter for stacks with no
 *                  ubiquitous scaffolder (FastAPI, Flask, Deno, Go, exotic langs).
 *                  Certified by the LOCAL build/boot certifier (Phase 2): the seed
 *                  is installed/built/booted in the sandbox and only used once it
 *                  passes — the "build a fully working tool locally that certifies"
 *                  path.
 *
 * Every Stack the deploy engine knows MUST have at least one entry here (enforced
 * by scripts/test-agent-loop.mts), so there are no silently unsupported stacks.
 */
import type { TemplateKey } from "./registry";

export type CoverageStrategy = "curated" | "scaffold" | "seed";
export type Certification = "curated-local-build" | "official-tool" | "local-build";

export interface ScaffoldSpec {
  /** The official tool invoked (informational/telemetry). */
  tool: string;
  /** The command run in the sandbox to produce the project. `{name}` is substituted. */
  command: string;
  /** Optional follow-up commands (e.g. add a dependency) after scaffolding. */
  post?: string[];
  note?: string;
}

export interface StackEntry {
  /** Deploy-engine stack family (see Stack in dockerfile.ts). */
  stack: string;
  /** Framework slug (matches detectStackPlan output where applicable). */
  framework: string;
  label: string;
  strategy: CoverageStrategy;
  /** For "curated": which inline template in registry.ts. */
  curatedKey?: TemplateKey;
  /** For "scaffold": the official generator. */
  scaffold?: ScaffoldSpec;
  certifiedBy: Certification;
  /** Keywords that route a request to this entry (used by higher-level routing). */
  match?: RegExp;
}

const npmCreate = (template: string): ScaffoldSpec => ({
  tool: "create-vite",
  command: `npm create vite@latest {name} -- --template ${template}`,
  post: ["npm install"],
});

export const STACK_MATRIX: StackEntry[] = [
  // ---- curated (inline, hot path) ----
  { stack: "static", framework: "static", label: "Static HTML/CSS/JS", strategy: "curated", curatedKey: "static", certifiedBy: "curated-local-build", match: /\b(landing|static|game|canvas|portfolio|brochure)\b/ },
  { stack: "node", framework: "vite", label: "React + Vite", strategy: "curated", curatedKey: "react-vite", certifiedBy: "curated-local-build", match: /\breact\b/ },
  { stack: "node", framework: "vue", label: "Vue 3 + Vite", strategy: "curated", curatedKey: "vue-vite", certifiedBy: "curated-local-build", match: /\bvue\b/ },
  { stack: "node", framework: "express", label: "Express API", strategy: "curated", curatedKey: "node-express", certifiedBy: "curated-local-build", match: /\bexpress\b/ },
  { stack: "node", framework: "fullstack", label: "Express + React (full-stack)", strategy: "curated", curatedKey: "express-react", certifiedBy: "curated-local-build", match: /\bfull[- ]?stack\b/ },

  // ---- scaffold (official tools — breadth without maintenance) ----
  { stack: "node", framework: "svelte", label: "Svelte + Vite", strategy: "scaffold", scaffold: npmCreate("svelte"), certifiedBy: "official-tool", match: /\bsvelte\b/ },
  { stack: "node", framework: "preact", label: "Preact + Vite", strategy: "scaffold", scaffold: npmCreate("preact"), certifiedBy: "official-tool", match: /\bpreact\b/ },
  { stack: "node", framework: "solid", label: "SolidJS + Vite", strategy: "scaffold", scaffold: npmCreate("solid"), certifiedBy: "official-tool", match: /\bsolid(js)?\b/ },
  { stack: "node", framework: "next", label: "Next.js", strategy: "scaffold", scaffold: { tool: "create-next-app", command: "npx --yes create-next-app@latest {name} --js --eslint --app --no-tailwind --no-src-dir --import-alias '@/*'", note: "App Router" }, certifiedBy: "official-tool", match: /\bnext\.?js\b/ },
  { stack: "node", framework: "nuxt", label: "Nuxt 3", strategy: "scaffold", scaffold: { tool: "nuxi", command: "npx --yes nuxi@latest init {name}", post: ["npm install"] }, certifiedBy: "official-tool", match: /\bnuxt\b/ },
  { stack: "node", framework: "angular", label: "Angular", strategy: "scaffold", scaffold: { tool: "angular-cli", command: "npx --yes @angular/cli@latest new {name} --defaults --skip-git" }, certifiedBy: "official-tool", match: /\bangular\b/ },
  { stack: "node", framework: "nest", label: "NestJS API", strategy: "scaffold", scaffold: { tool: "nest-cli", command: "npx --yes @nestjs/cli@latest new {name} --skip-git --package-manager npm" }, certifiedBy: "official-tool", match: /\bnest(js)?\b/ },
  { stack: "node", framework: "remix", label: "Remix", strategy: "scaffold", scaffold: { tool: "create-remix", command: "npx --yes create-remix@latest {name} --no-git-init --yes" }, certifiedBy: "official-tool", match: /\bremix\b/ },
  { stack: "node", framework: "astro", label: "Astro", strategy: "scaffold", scaffold: { tool: "create-astro", command: "npm create astro@latest {name} -- --template minimal --no-git --skip-houston --install" }, certifiedBy: "official-tool", match: /\bastro\b/ },

  { stack: "python", framework: "django", label: "Django", strategy: "scaffold", scaffold: { tool: "django-admin", command: "django-admin startproject {name}", post: ["pip install django"] }, certifiedBy: "official-tool", match: /\bdjango\b/ },
  { stack: "python", framework: "fastapi", label: "FastAPI", strategy: "seed", certifiedBy: "local-build", match: /\bfastapi\b/ },
  { stack: "python", framework: "flask", label: "Flask", strategy: "seed", certifiedBy: "local-build", match: /\bflask\b/ },
  { stack: "python", framework: "python", label: "Python (generic)", strategy: "seed", certifiedBy: "local-build" },

  { stack: "dotnet", framework: "aspnet", label: "ASP.NET Core Web API", strategy: "scaffold", scaffold: { tool: "dotnet", command: "dotnet new webapi -o {name}" }, certifiedBy: "official-tool", match: /\b(\.net|asp\.?net|c#|csharp)\b/ },
  { stack: "java", framework: "spring", label: "Spring Boot", strategy: "scaffold", scaffold: { tool: "spring-initializr", command: "curl -s https://start.spring.io/starter.tgz -d dependencies=web -d type=gradle-project -d name={name} | tar -xz -C {name}", note: "Spring Initializr" }, certifiedBy: "official-tool", match: /\bspring\b/ },
  { stack: "java", framework: "scala", label: "Scala (sbt)", strategy: "seed", certifiedBy: "local-build", match: /\bscala\b/ },
  { stack: "ruby", framework: "rails", label: "Ruby on Rails", strategy: "scaffold", scaffold: { tool: "rails", command: "rails new {name} --api --skip-git" }, certifiedBy: "official-tool", match: /\brails\b/ },
  { stack: "ruby", framework: "sinatra", label: "Sinatra", strategy: "seed", certifiedBy: "local-build", match: /\bsinatra\b/ },
  { stack: "ruby", framework: "ruby", label: "Ruby (generic)", strategy: "seed", certifiedBy: "local-build" },
  { stack: "php", framework: "laravel", label: "Laravel", strategy: "scaffold", scaffold: { tool: "composer", command: "composer create-project laravel/laravel {name}" }, certifiedBy: "official-tool", match: /\blaravel\b/ },
  { stack: "php", framework: "symfony", label: "Symfony", strategy: "scaffold", scaffold: { tool: "composer", command: "composer create-project symfony/skeleton {name}" }, certifiedBy: "official-tool", match: /\bsymfony\b/ },
  { stack: "php", framework: "php", label: "PHP (generic)", strategy: "seed", certifiedBy: "local-build" },
  { stack: "go", framework: "go", label: "Go (net/http)", strategy: "seed", certifiedBy: "local-build", match: /\bgo(lang)?\b/ },
  { stack: "rust", framework: "rust", label: "Rust (cargo)", strategy: "scaffold", scaffold: { tool: "cargo", command: "cargo new {name} --bin" }, certifiedBy: "official-tool", match: /\brust\b/ },
  { stack: "elixir", framework: "phoenix", label: "Phoenix", strategy: "scaffold", scaffold: { tool: "mix", command: "mix phx.new {name} --no-install" }, certifiedBy: "official-tool", match: /\b(phoenix|elixir)\b/ },
  { stack: "swift", framework: "vapor", label: "Vapor", strategy: "scaffold", scaffold: { tool: "vapor", command: "vapor new {name} -n" }, certifiedBy: "official-tool", match: /\b(vapor|swift)\b/ },
  { stack: "dart", framework: "dart", label: "Dart", strategy: "scaffold", scaffold: { tool: "dart", command: "dart create {name}" }, certifiedBy: "official-tool", match: /\bdart\b/ },
  { stack: "deno", framework: "deno", label: "Deno", strategy: "seed", certifiedBy: "local-build", match: /\bdeno\b/ },
  { stack: "bun", framework: "bun", label: "Bun", strategy: "scaffold", scaffold: { tool: "bun", command: "bun init {name} -y" }, certifiedBy: "official-tool", match: /\bbun\b/ },
  { stack: "cpp", framework: "cpp", label: "C++ (CMake)", strategy: "seed", certifiedBy: "local-build", match: /\b(c\+\+|cpp)\b/ },

  // ---- long tail: deploy-engine-known stacks with no ubiquitous scaffolder ----
  // Each gets a minimal seed certified by the LOCAL build/boot certifier.
  ...(["haskell", "clojure", "crystal", "nim", "perl", "r", "julia", "ocaml", "zig", "erlang", "gleam", "lua", "d", "vlang", "raku", "lisp", "racket", "pascal", "tcl", "ballerina", "prolog", "powershell", "hack", "ada", "haxe"].map(
    (s): StackEntry => ({ stack: s, framework: s, label: `${s} (seed)`, strategy: "seed", certifiedBy: "local-build" }),
  )),
];

/** Every Stack the deploy engine declares — kept in sync with dockerfile.ts. */
export const KNOWN_STACKS = [
  "node", "python", "go", "rust", "php", "java", "dotnet", "ruby", "elixir", "cpp", "static",
  "deno", "bun", "swift", "dart", "haskell", "clojure", "crystal", "nim", "perl", "r", "julia",
  "ocaml", "zig", "erlang", "gleam", "lua", "d", "vlang", "raku", "lisp", "racket", "pascal",
  "tcl", "ballerina", "prolog", "powershell", "hack", "ada", "haxe",
] as const;

/** Resolve the best coverage entry for a stack (+ optional framework). */
export function entriesForStack(stack: string): StackEntry[] {
  return STACK_MATRIX.filter((e) => e.stack === stack);
}

/**
 * Pick a NON-curated (scaffold/seed) entry whose keywords the request matches —
 * i.e. the user asked for a specific stack the curated 5 don't cover (django, go,
 * rust, svelte, next, …). Returns null when the request is best served by a
 * curated template (the caller then uses selectTemplate). First match wins, and
 * the matrix is ordered scaffold-before-seed so the official tool is preferred.
 */
export function selectScaffoldOrSeed(request: string): StackEntry | null {
  const t = (request || "").toLowerCase();
  for (const e of STACK_MATRIX) {
    if (e.strategy === "curated") continue;
    if (e.match && e.match.test(t)) return e;
  }
  return null;
}

/** Stacks that have NO coverage entry — must be empty (CI-enforced). */
export function uncoveredStacks(): string[] {
  return KNOWN_STACKS.filter((s) => !STACK_MATRIX.some((e) => e.stack === s));
}

/** Summary for reporting/telemetry. */
export function coverageReport() {
  const byStrategy = { curated: 0, scaffold: 0, seed: 0 } as Record<CoverageStrategy, number>;
  for (const e of STACK_MATRIX) byStrategy[e.strategy]++;
  return {
    entries: STACK_MATRIX.length,
    stacks: new Set(STACK_MATRIX.map((e) => e.stack)).size,
    knownStacks: KNOWN_STACKS.length,
    uncovered: uncoveredStacks(),
    byStrategy,
  };
}
