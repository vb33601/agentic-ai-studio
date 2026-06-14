import { repairTruncatedSource, detectTruncatedSources, type SrcFile } from "./truncation";
import { checkDockerfileInvariants } from "./stack-invariants";
import { matchKnownFix, unmatchedFailure, type FixRule } from "./fix-registry";
import type { StackPlan } from "./dockerfile";

/**
 * Pre-deploy verification gate — the static tier of the build → verify → fix loop
 * (see docs/quality-engine-design.md). Before a deploy is pushed to the remote
 * builder, run every static build-correctness check we can do server-side,
 * auto-fix the classes we know how to fix, and return a structured verdict:
 *
 *   - repair truncated source (JS/TS + C#) that would otherwise fail the build,
 *   - block (don't ship) anything still truncated after repair — a build that is
 *     CERTAIN to fail, so failing loud here beats a silent doomed remote build,
 *   - check the generated Dockerfile still carries its stack's required directives,
 *   - and, given a prior build/deploy error log, recognise the failure class via the
 *     fix registry so callers can apply the matching fix and retry.
 *
 * Pure and FAIL-OPEN by construction: it only ever repairs source or reports
 * blockers; it never calls the network or mutates anything outside the returned
 * file set, so it cannot break a deploy that would otherwise have worked.
 *
 * This is the single backbone the deploy route and (Phase 3) the Vercel Sandbox
 * full-flow verifier both call, so the "fix it, or report and don't deploy broken"
 * policy lives in exactly one place.
 */

export interface VerifyInput {
  files: SrcFile[];
  /** The detected plan, when available — enables Dockerfile-invariant checks. */
  plan?: Pick<StackPlan, "stack" | "framework" | "dockerfile">;
  /** A build/deploy error log from a prior attempt, to recognise + suggest fixes. */
  errorLog?: string;
}

export interface RecognizedFailure {
  id: string;
  title: string;
  module: string;
}

export interface VerifyReport {
  /** Safe to proceed with the deploy. */
  ok: boolean;
  /** The (possibly repaired) file set to deploy. */
  files: SrcFile[];
  /** What was auto-fixed (human-readable, for the deploy log). */
  fixesApplied: string[];
  /** Why the deploy must NOT proceed (precise + actionable). Empty when ok. */
  blockers: string[];
  /** Fixes whose signature matched `errorLog` (drives auto-fix + retry). */
  recognized: RecognizedFailure[];
  /** True when `errorLog` matched no known fix — the trigger to author a new rule. */
  novelFailure: boolean;
}

const asRecognized = (f: FixRule): RecognizedFailure => ({ id: f.id, title: f.title, module: f.module });

/**
 * Run the static gate over a prepared file set. Repairs what it can, blocks what it
 * can't, and recognises a prior failure when an error log is supplied.
 */
export function verifyForDeploy(input: VerifyInput): VerifyReport {
  const fixesApplied: string[] = [];
  const blockers: string[] = [];

  // 1) Repair truncated source (JS/TS fully; C# brace-completion).
  const trunc = repairTruncatedSource(input.files);
  let files = trunc.files;
  if (trunc.repaired.length) {
    fixesApplied.push(`repair-truncated-source: completed ${trunc.repaired.length} file(s) the generator cut off (${trunc.repaired.join(", ")})`);
  }

  // 2) Block anything STILL truncated after repair — a guaranteed build failure
  //    (e.g. truncated mid-expression / mid-string, or a stack we can't complete).
  const stillTruncated = detectTruncatedSources(files);
  if (stillTruncated.length) {
    blockers.push(
      `${stillTruncated.length} source file(s) are truncated and can't be safely auto-completed — ` +
        `the generator's output was cut off mid-statement, so the build would fail (e.g. CS1513 '} expected'). ` +
        `Regenerate: ${stillTruncated.join(", ")}.`,
    );
  }

  // 3) Dockerfile build-correctness invariants for the detected stack.
  if (input.plan) {
    const violations = checkDockerfileInvariants(input.plan);
    for (const v of violations) blockers.push(`Dockerfile invariant violated: ${v}`);
  }

  // 4) Recognise a prior failure so callers can apply the matching fix and retry.
  const recognized = input.errorLog ? matchKnownFix(input.errorLog).map(asRecognized) : [];
  const novelFailure = !!input.errorLog && unmatchedFailure(input.errorLog);

  return { ok: blockers.length === 0, files, fixesApplied, blockers, recognized, novelFailure };
}

/**
 * Convenience wrapper for call sites that want the existing "repair, else throw"
 * behaviour (the deploy route's hard gate). Returns the repaired files or throws a
 * precise Error listing the blockers.
 */
export function gateOrThrow(input: VerifyInput): { files: SrcFile[]; fixesApplied: string[] } {
  const report = verifyForDeploy(input);
  if (!report.ok) {
    throw new Error(`Deploy blocked by pre-deploy verification:\n  - ${report.blockers.join("\n  - ")}`);
  }
  return { files: report.files, fixesApplied: report.fixesApplied };
}
