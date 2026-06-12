import { prisma } from "@/lib/prisma";

/**
 * Outcome-weighted learning for the deploy engine.
 *
 * Every fix/rule the engine applies is recorded together with whether the deploy
 * + verification that FOLLOWED actually passed (build → health → smoke). Those
 * outcomes are aggregated into a per-rule success rate, and rule/fix selection is
 * weighted by it: things that have worked float up, things that have failed get
 * demoted or flagged. It's not neural RL — it's a Laplace-smoothed
 * contextual-bandit-style heuristic — but it genuinely "learns from its own
 * mistakes" and gets wiser as data accumulates.
 *
 * All DB access is best-effort (try/catch): with no table/DB the engine still
 * runs on its curated rules; learning simply doesn't kick in yet.
 */

export interface FixOutcomeInput {
  tech: string;
  ruleId: string;
  action: string;
  success: boolean;
  errorSignature?: string;
  phase?: "build" | "deploy" | "health" | "smoke";
  details?: string;
}

/** Record one outcome. No-op on any DB error. */
export async function recordFixOutcome(o: FixOutcomeInput): Promise<void> {
  try {
    await prisma.fixOutcome.create({
      data: {
        tech: o.tech,
        ruleId: o.ruleId,
        action: o.action,
        success: o.success,
        errorSignature: o.errorSignature,
        phase: o.phase ?? "deploy",
        details: o.details?.slice(0, 2000),
      },
    });
  } catch {
    /* table/DB absent — learning disabled, engine still runs on curated rules */
  }
}

export interface RuleScore {
  ruleId: string;
  success: number;
  total: number;
  /** Laplace-smoothed success rate in (0,1); 0.5 when unseen. */
  weight: number;
}

/**
 * Per-rule success rates for a tech (Laplace-smoothed so a single sample doesn't
 * swing selection). Empty map when there's no data/DB — callers then fall back to
 * the curated order.
 */
export async function ruleScores(tech: string): Promise<Map<string, RuleScore>> {
  const scores = new Map<string, RuleScore>();
  try {
    const rows = await prisma.fixOutcome.groupBy({
      by: ["ruleId", "success"],
      where: { tech },
      _count: { _all: true },
    });
    const agg = new Map<string, { s: number; t: number }>();
    for (const row of rows) {
      const a = agg.get(row.ruleId) ?? { s: 0, t: 0 };
      a.t += row._count._all;
      if (row.success) a.s += row._count._all;
      agg.set(row.ruleId, a);
    }
    for (const [ruleId, { s, t }] of agg) {
      scores.set(ruleId, { ruleId, success: s, total: t, weight: (s + 1) / (t + 2) });
    }
  } catch {
    /* no data yet */
  }
  return scores;
}

/** The learned weight for one rule (0.5 = unseen/neutral). */
export function weightOf(scores: Map<string, RuleScore>, ruleId: string): number {
  return scores.get(ruleId)?.weight ?? 0.5;
}
