import { NextRequest, NextResponse } from "next/server";
import { recordFixOutcome, ruleScores } from "@/lib/deploy/learn";
import { diagForbidden } from "@/lib/deploy/diag-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

/**
 * Diagnostic: GET /api/deploy/outcome?tech=X → the learned weights for a tech
 * (count + per-rule Laplace-smoothed success rate). Read-only; used to confirm the
 * learning loop is persisting + aggregating in prod.
 */
export async function GET(req: NextRequest) {
  const forbidden = diagForbidden(req);
  if (forbidden) return forbidden;
  const tech = req.nextUrl.searchParams.get("tech");
  if (!tech) return NextResponse.json({ error: "tech query param required" }, { status: 400 });
  try {
    const total = await prisma.fixOutcome.count({ where: { tech } });
    const scores = await ruleScores(tech);
    return NextResponse.json({ tech, total, weights: [...scores.values()] });
  } catch (e) {
    return NextResponse.json({ tech, total: 0, weights: [], error: e instanceof Error ? e.message : String(e) });
  }
}

/** Sentinel cleanup: DELETE /api/deploy/outcome?tech=__verify__ (only sentinel techs). */
export async function DELETE(req: NextRequest) {
  const forbidden = diagForbidden(req);
  if (forbidden) return forbidden;
  const tech = req.nextUrl.searchParams.get("tech");
  if (!tech || !tech.startsWith("__")) {
    return NextResponse.json({ error: "only sentinel techs (prefix __) may be deleted" }, { status: 400 });
  }
  try {
    const del = await prisma.fixOutcome.deleteMany({ where: { tech } });
    return NextResponse.json({ deleted: del.count });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/**
 * Record a deploy/verify OUTCOME so the engine learns: the client reports whether
 * the deployed app actually passed verification (build/health/smoke), tagged by
 * technology and the action that was taken. Aggregated into per-rule success
 * rates that weight future selection. Best-effort — never throws.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      tech?: string;
      ruleId?: string;
      action?: string;
      success?: boolean;
      errorSignature?: string;
      phase?: "build" | "deploy" | "health" | "smoke";
      details?: string;
    };
    if (!body.tech || !body.ruleId || typeof body.success !== "boolean") {
      return NextResponse.json({ error: "tech, ruleId and success are required" }, { status: 400 });
    }
    await recordFixOutcome({
      tech: body.tech,
      ruleId: body.ruleId,
      action: body.action || body.ruleId,
      success: body.success,
      errorSignature: body.errorSignature,
      phase: body.phase,
      details: body.details,
    });
    return NextResponse.json({ recorded: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
