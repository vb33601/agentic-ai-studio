import { NextRequest, NextResponse } from "next/server";
import { verifyAgainstPlan, type VerifyPhase, type PlanVerifyFile } from "@/lib/quality/plan-verify";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

/**
 * Subsystem D endpoint — plan-based end-to-end verification for the deploy flow.
 *
 * The chat route runs the post-generation check inline; the deploy panel calls
 * THIS route to run the same check (a) before a deploy over the prepared files,
 * and (b) after a deploy with the live URL + smoke/health signals — so the same
 * "is it really built and working end-to-end?" verdict gates the whole lifecycle.
 *
 * Always returns a report (the engine is fail-open); a `checked:false` report
 * just means it was skipped (no plan / model unavailable) and must never block.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      plan?: string | null;
      files?: PlanVerifyFile[];
      phase?: VerifyPhase;
      liveUrl?: string | null;
      smoke?: { ok: boolean; issues: string[] } | null;
      health?: { healthy: boolean; status: number | null } | null;
    };
    const report = await verifyAgainstPlan({
      plan: body.plan,
      files: Array.isArray(body.files) ? body.files : [],
      phase: body.phase ?? "pre-deploy",
      liveUrl: body.liveUrl,
      smoke: body.smoke,
      health: body.health,
    });
    return NextResponse.json(report);
  } catch (error) {
    // Even an unexpected failure must not block a deploy.
    return NextResponse.json(
      { ok: true, checked: false, score: 1, steps: [], gaps: [], summary: "Verification unavailable.", phase: "pre-deploy", error: error instanceof Error ? error.message : String(error) },
      { status: 200 },
    );
  }
}
