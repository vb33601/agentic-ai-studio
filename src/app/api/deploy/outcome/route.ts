import { NextRequest, NextResponse } from "next/server";
import { recordFixOutcome } from "@/lib/deploy/learn";

export const maxDuration = 30;

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
