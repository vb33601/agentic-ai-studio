import type { Stack } from "./dockerfile";

/**
 * Per-stack deploy-hardening matrix.
 *
 * The .NET work this session surfaced one principle: a generated app must not
 * just BUILD, it must RUN. The concrete fixes, though, are context-dependent —
 * applying them where the stack's toolchain can't already catch the defect, and
 * NOT applying them where it can:
 *
 *   • Interpreted/dynamic stacks (Python, Node, Ruby) install only what the
 *     manifest declares, so a used-but-undeclared dependency survives the build
 *     and crashes at import → they get the dependency reconciler.
 *   • Compiled stacks (Rust, Java, Go, Haskell, Swift, …) FAIL THE BUILD on an
 *     undeclared/undefined reference — the compiler is the guardrail, so no
 *     runtime reconciler is needed (Go is the one exception: `go mod tidy`
 *     back-fills go.mod from source).
 *   • Explicit-DI + NuGet + EF migrations are .NET-only concepts; the DI
 *     register/prune and NU1605 fixes apply to `dotnet` alone. Other DI worlds
 *     (Spring, Clojure/JVM) are annotation/data-driven and don't have the
 *     "compiles but the container can't resolve the service" failure.
 *   • Schema auto-create (no migrations) applies wherever an ORM can build the
 *     schema from the model: .NET (EF), Django, Rails, Spring (JPA), Prisma.
 *
 * This matrix makes that reasoning explicit and is completeness-tested
 * (scripts/test-hardening-matrix.mts asserts every Stack has an entry), so no
 * technology is silently left unhardened and adding a stack forces a decision.
 */

export type HardeningPass =
  | "strip-broken-files"        // universal: drop source files that are actually markup/XML
  | "dep-reconcile"             // add deps used in code but missing from the manifest
  | "go-mod-tidy"               // Go: back-fill go.mod from source before build
  | "schema-autocreate"         // no migrations; ORM builds schema from the model
  | "dotnet-package-conflict"   // .NET: resolve NU1605 downgrade at source
  | "dotnet-di-register"        // .NET: register injected-but-unregistered services
  | "dotnet-di-prune";          // .NET: drop registrations for undefined services

export interface StackHardening {
  passes: HardeningPass[];
  /** Why these passes (and not others) fit this stack's toolchain. */
  context: string;
}

const STRIP: HardeningPass = "strip-broken-files";

/** Compiled stacks: the compiler catches missing/undefined references at build. */
const compiled = (lang: string): StackHardening => ({
  passes: [STRIP],
  context: `${lang} resolves declared deps at build and fails compilation on anything missing/undefined — the toolchain is the guardrail; no DI container or migration layer to harden.`,
});

export const HARDENING_MATRIX: Record<Stack, StackHardening> = {
  // --- .NET: the only stack with all three .NET-specific defect classes ---
  dotnet: {
    passes: [STRIP, "dotnet-package-conflict", "dotnet-di-register", "dotnet-di-prune", "schema-autocreate"],
    context: "Explicit DI registration, NuGet restore (NU1605 downgrades), and EF migrations — compiles-but-crashes in three distinct ways, each auto-fixed.",
  },

  // --- Interpreted/dynamic: install only declared deps → reconcile manifest ---
  python: { passes: [STRIP, "dep-reconcile", "schema-autocreate"], context: "pip installs only what requirements.txt lists; an undeclared import crashes with ModuleNotFoundError. Django builds the schema via migrate --run-syncdb." },
  node:   { passes: [STRIP, "dep-reconcile", "schema-autocreate"], context: "npm installs only declared deps; an undeclared import throws 'Cannot find module'. Prisma pushes the schema (db push) instead of migrating." },
  bun:    { passes: [STRIP, "dep-reconcile"], context: "Bun installs only declared deps; undeclared imports crash at runtime." },
  ruby:   { passes: [STRIP, "dep-reconcile", "schema-autocreate"], context: "Bundler installs only gems in the Gemfile; an undeclared require is a LoadError. Rails loads schema directly (db:schema:load)." },

  // --- Go: compiler catches, and `go mod tidy` self-heals go.mod from source ---
  go: { passes: [STRIP, "go-mod-tidy"], context: "The compiler fails on undeclared imports; `go mod tidy` back-fills go.mod/go.sum from the source so they don't fail the build." },

  // --- PHP: Composer autoload; namespace→package mapping is unreliable to auto-add ---
  php: { passes: [STRIP, "schema-autocreate"], context: "Composer resolves via PSR-4 autoload; import→package is not deterministic enough to auto-add safely. Laravel/Symfony run their own (framework-authored) migrations at start." },

  // --- JVM: Spring beans are annotation-scanned (no explicit-registration bug) ---
  java: { passes: [STRIP, "schema-autocreate"], context: "Maven/Gradle resolve declared deps and the compiler catches the rest; Spring autowires beans by component-scan (no .NET-style 'unregistered service'). Hibernate builds the schema via ddl-auto=update." },

  // --- Compiled / build-is-the-guardrail ---
  rust: compiled("Cargo"),
  cpp: compiled("CMake/the C/C++ compiler"),
  swift: compiled("SwiftPM"),
  haskell: compiled("Cabal/Stack"),
  crystal: compiled("Shards/the Crystal compiler"),
  nim: compiled("Nimble/the Nim compiler"),
  zig: compiled("the Zig compiler"),
  d: compiled("dub/the D compiler"),
  vlang: compiled("the V compiler"),
  ada: compiled("Alire/GNAT"),
  pascal: compiled("the Free Pascal compiler"),
  haxe: compiled("Haxe"),
  ocaml: compiled("Dune/the OCaml compiler"),
  dart: compiled("pub/the Dart compiler"),

  // --- BEAM: mix/rebar resolve; Ecto migrations are explicit (not hallucinated like EF) ---
  elixir: { passes: [STRIP], context: "Mix resolves declared deps and the compiler catches the rest; Ecto migrations are first-party and explicit — no EF-style hallucinated scaffolding to strip." },
  erlang: { passes: [STRIP], context: "rebar3 resolves declared deps; the compiler is the guardrail; no DI/ORM layer." },
  gleam: { passes: [STRIP], context: "Gleam's build resolves deps and type-checks; no DI/migration layer to harden." },

  // --- JVM/Lisp & scripting: dep resolution at build or runtime self-managed ---
  clojure: { passes: [STRIP], context: "deps.edn/Leiningen resolve on the JVM; data-driven, no explicit-DI container; the REPL/AOT step catches missing vars." },
  lisp: compiled("ASDF/Quicklisp"),
  racket: compiled("raco/the Racket compiler"),

  lua: { passes: [STRIP], context: "LuaRocks/runtime require; dependency names are not deterministically mappable from `require` paths, so deps aren't auto-added." },
  perl: { passes: [STRIP], context: "cpanfile/CPAN; module→dist mapping is ambiguous, so deps aren't auto-added." },
  r: { passes: [STRIP], context: "CRAN/renv; library() calls don't map 1:1 to installable names reliably." },
  julia: { passes: [STRIP], context: "Pkg resolves from Project.toml; the loader catches missing packages at precompile." },
  raku: { passes: [STRIP], context: "zef/META6; module→dist mapping is ambiguous." },
  tcl: { passes: [STRIP], context: "Tcl packages via package require; no deterministic registry mapping." },
  ballerina: { passes: [STRIP], context: "Ballerina's build resolves imports from Ballerina.toml and fails compilation otherwise." },
  prolog: { passes: [STRIP], context: "SWI-Prolog packs; no manifest reconciliation; no DI/DB layer." },
  powershell: { passes: [STRIP], context: "PowerShell modules; no build-time manifest to reconcile." },
  hack: { passes: [STRIP], context: "HHVM/Composer; like PHP, namespace→package mapping isn't safe to auto-add." },

  // --- No build / no deps / no DB ---
  static: { passes: [STRIP], context: "No build step, dependencies, DB, or DI; the SPA-routing fallback is handled directly in the static planner." },
  deno: { passes: [STRIP], context: "URL / jsr: / npm: imports resolve themselves at runtime — there is no manifest to reconcile." },
};

/** The hardening passes that apply to a stack (empty-safe). */
export function hardeningPassesFor(stack: Stack): HardeningPass[] {
  return HARDENING_MATRIX[stack]?.passes ?? [STRIP];
}
