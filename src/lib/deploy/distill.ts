import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/ai/providers";
import { prisma } from "@/lib/prisma";
import type { RegistryFix } from "./preflight";

/**
 * Advisory → structured-fix distiller.
 *
 * Researched registry advisories are free text; this turns a promising one into a
 * candidate DETERMINISTIC fix (a conservative regex find/replace) the engine can
 * auto-apply later. The output is stored UNVERIFIED — it never edits user code
 * until the learning loop promotes it (proven by real deploy outcomes). The
 * danger here is an LLM emitting a destructive regex, so every candidate must pass
 * `isSafeFix` (compiles, narrow, idempotent) before it's ever stored.
 *
 * Best-effort throughout: no model/DB → no candidate, deploys unaffected.
 */

const DEFAULT_DISTILL_MODEL = "anthropic/claude-sonnet-4.5";

const FixCandidate = z.object({
  applicable: z.boolean().describe("true only if the advisory maps to a SAFE, narrow, idempotent regex fix"),
  glob: z.string().optional().describe("RegExp source matched against the file PATH, e.g. \\\\.(jsx?|tsx?)$"),
  find: z.string().optional().describe("RegExp source for the exact buggy pattern; specific, not broad"),
  replace: z.string().optional().describe("replacement; may use $1.. backrefs"),
  flags: z.string().optional().describe("regex flags, usually g"),
});

/**
 * Validate a candidate fix is safe to ever auto-apply:
 *  - all parts present and the regexes COMPILE,
 *  - `find` is specific (not trivially broad / catastrophic),
 *  - applying it is IDEMPOTENT and a no-op on text that doesn't contain the bug.
 */
export function isSafeFix(fix: Partial<RegistryFix> | null | undefined): fix is RegistryFix {
  if (!fix || !fix.glob || !fix.find || fix.replace == null) return false;
  let globRe: RegExp, findRe: RegExp;
  try {
    globRe = new RegExp(fix.glob);
    findRe = new RegExp(fix.find, fix.flags ?? "g");
  } catch {
    return false;
  }
  // Reject dangerously broad patterns.
  if (fix.find.length < 8) return false;
  if (/^[.^$*+?()\[\]{}|\\\s]*$/.test(fix.find)) return false; // all-metacharacters
  if (/\.\*|\.\+|\[\^?\]|\\s\*\$/.test(fix.find) && fix.find.replace(/[^A-Za-z0-9_]/g, "").length < 6) return false;
  // The glob must look like a file-extension/path matcher (an escaped dot or a
  // path separator), not a code matcher.
  if (!/\\\./.test(fix.glob) && !/\//.test(fix.glob)) return false;
  // Idempotency + no-op safety on samples.
  try {
    const noop = "function nothingHereMatches() { return 1; }";
    if (noop.replace(findRe, fix.replace) !== noop && findRe.test(noop)) {
      // It matched generic code — too broad.
      return false;
    }
    // If we can synthesize a hit from the pattern, applying twice must equal once.
    const sample = `path test ${fix.find.replace(/[\\^$.*+?()[\]{}|]/g, "x")}`;
    const once = sample.replace(new RegExp(fix.find, fix.flags ?? "g"), fix.replace);
    const twice = once.replace(new RegExp(fix.find, fix.flags ?? "g"), fix.replace);
    if (once !== twice) return false; // not idempotent
  } catch {
    return false;
  }
  return true;
}

/** Distill ONE advisory into a safe fix candidate, or null. Never throws. */
export async function distillFix(input: {
  tech: string;
  title: string;
  detail: string;
  sourceUrl?: string;
  modelId?: string;
}): Promise<RegistryFix | null> {
  try {
    const { object } = await generateObject({
      model: getModel(input.modelId ?? DEFAULT_DISTILL_MODEL),
      schema: FixCandidate,
      temperature: 0,
      maxOutputTokens: 800,
      system:
        "You convert a known deployment/runtime issue into a SINGLE conservative, idempotent regex find/replace " +
        "fix for generated source code. Only return applicable=true when the fix is a SAFE, NARROW textual edit that " +
        "cannot corrupt unrelated code and is a no-op when the bug is absent. The `find` must be specific (anchored to " +
        "the exact buggy construct), never broad like `.*`. Prefer adding a guard/fallback over deleting code. If the " +
        "issue needs semantic understanding, multi-file changes, or a non-trivial rewrite, return applicable=false.",
      prompt:
        `TECHNOLOGY: ${input.tech}\nISSUE: ${input.title}\nDETAIL: ${input.detail}\n` +
        (input.sourceUrl ? `SOURCE: ${input.sourceUrl}\n` : "") +
        `\nReturn a regex fix only if it is unambiguously safe and idempotent.`,
    });
    if (!object.applicable) return null;
    const fix: Partial<RegistryFix> = { glob: object.glob, find: object.find, replace: object.replace, flags: object.flags || "g" };
    return isSafeFix(fix) ? fix : null;
  } catch {
    return null;
  }
}

/**
 * For a tech, distill fixes for up to `limit` stored advisories that don't have
 * one yet, and persist them UNVERIFIED. Best-effort; returns how many were added.
 */
export async function distillAndStore(tech: string, limit = 3): Promise<number> {
  try {
    const candidates = await prisma.preflightRule.findMany({
      where: { tech, fixFind: null, source: "web" },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    let added = 0;
    for (const row of candidates) {
      const fix = await distillFix({ tech, title: row.title, detail: row.detail, sourceUrl: row.sourceUrl ?? undefined });
      if (!fix) continue;
      await prisma.preflightRule.update({
        where: { id: row.id },
        data: { fixGlob: fix.glob, fixFind: fix.find, fixReplace: fix.replace, fixFlags: fix.flags ?? "g", verified: false },
      });
      added++;
    }
    return added;
  } catch {
    return 0;
  }
}
