import type { StackPlan } from "./dockerfile";

/**
 * Build-correctness invariants for generated Dockerfiles.
 *
 * These encode the *intent* baked into each planner in `dockerfile.ts` — the
 * directives a stack's Dockerfile MUST carry to build/run, distilled from the
 * documented failure modes the planners exist to prevent (e.g. .NET's NU1605
 * downgrade abort, nginx's missing templates dir). They are the single source
 * of truth shared by two consumers:
 *
 *   1. `scripts/test-stacks.mts` — asserts every one of the 45 stack fixtures
 *      still satisfies its invariants (catches a regression the moment a planner
 *      is edited, with no Docker required).
 *   2. `prepareForContainer()` in `universal-prepare.ts` — a runtime gate that
 *      refuses to ship a generated app whose Dockerfile lost a required
 *      directive, so the studio fails loud at deploy time instead of producing a
 *      broken remote build.
 *
 * Keep these to invariants the engine *guarantees*: every rule here must hold
 * for the corresponding fixture in the harness, so the runtime gate never fires
 * on a healthy build.
 */

export interface Invariant {
  /** Must match the generated Dockerfile, or the rule is violated. */
  test: RegExp;
  /** Human-readable description of what the missing directive breaks. */
  msg: string;
}

/** Invariants that every Dockerfile, regardless of stack, must satisfy. */
const UNIVERSAL: Invariant[] = [
  { test: /^FROM\s+\S+/m, msg: "no FROM instruction — not a valid Dockerfile" },
];

/**
 * Stack/framework-specific invariants. Looked up by BOTH `plan.stack` and
 * `plan.framework`, so a rule can target a language ("go") or a single framework
 * ("aspnet", "django") interchangeably.
 */
const BY_KEY: Record<string, Invariant[]> = {
  // .NET: the NU1605 package-downgrade abort is the most common generated-code
  // build failure; both flags must survive on the `dotnet publish` line.
  aspnet: [
    { test: /-p:NoWarn=NU1605\b/, msg: "dotnet: NU1605 downgrade error not suppressed — restore will abort on generated package conflicts" },
    { test: /-p:TreatWarningsAsErrors=false\b/, msg: "dotnet: TreatWarningsAsErrors not disabled — warnings re-promote to build errors" },
  ],

  // Static: nginx:alpine renders /etc/nginx/templates/*.template via envsubst on
  // boot; the dir must be created before writing into it (absent on the base image).
  static: [
    { test: /mkdir -p \/etc\/nginx\/templates\b/, msg: "static: /etc/nginx/templates not created — template write fails on nginx:alpine" },
    { test: /\/etc\/nginx\/templates\/default\.conf\.template\b/, msg: "static: no nginx template emitted for $PORT substitution" },
  ],

  // Django: schema must be migrated on boot and the app served via gunicorn.
  django: [
    { test: /manage\.py migrate\b/, msg: "django: migrations not run on start" },
    { test: /gunicorn\b/, msg: "django: not served via gunicorn" },
  ],

  // Spring Boot must bind IPv6 dual-stack or Fly's IPv6 proxy gets an empty reply.
  spring: [
    { test: /server\.address=::/, msg: "spring: server.address=:: missing — unreachable behind Fly's IPv6 proxy" },
  ],

  // Go images must produce a static binary (no glibc) for the scratch/alpine runtime.
  go: [
    { test: /CGO_ENABLED=0\b/, msg: "go: CGO_ENABLED=0 missing — dynamically linked binary won't run on alpine" },
  ],
};

/**
 * Returns the list of invariant violations for a generated plan. An empty array
 * means the Dockerfile satisfies every applicable invariant.
 */
export function checkDockerfileInvariants(
  plan: Pick<StackPlan, "stack" | "framework" | "dockerfile">,
): string[] {
  const df = plan.dockerfile ?? "";
  const rules = [
    ...UNIVERSAL,
    ...(BY_KEY[plan.stack] ?? []),
    ...(plan.framework !== plan.stack ? BY_KEY[plan.framework] ?? [] : []),
  ];
  return rules.filter((r) => !r.test.test(df)).map((r) => r.msg);
}
