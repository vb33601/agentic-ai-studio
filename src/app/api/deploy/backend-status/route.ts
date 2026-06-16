import { NextRequest, NextResponse } from "next/server";
import { releaseSnapshot, type VerifyRef } from "@/lib/deploy/verify-release";
import { probeBackendHealth } from "@/lib/deploy/health";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

/**
 * Single point-in-time status of a backend deploy — the CLIENT sets the polling
 * cadence (so this route stays well under its time budget), letting a backend
 * resolve out of "pending" into live/failed instead of hanging forever.
 *
 * POST { ref: VerifyRef, url?: string } →
 *   { state, detail, hint, health? }
 *
 * `ref` is the opaque `backendStatusRef` returned by /api/deploy/fullstack. When a
 * `url` is given and the build reports live, we also confirm runtime liveness (a
 * build can go "live" yet crash on boot) so "live" means actually serving.
 */
export async function POST(req: NextRequest) {
  try {
    const { ref, url } = (await req.json()) as { ref?: VerifyRef; url?: string };
    if (!ref || typeof ref !== "object" || !("provider" in ref)) {
      return NextResponse.json({ error: "ref (VerifyRef) is required" }, { status: 400 });
    }
    const status = await releaseSnapshot(ref);
    // When the build says live, verify the process actually answers a request.
    let health = undefined;
    if (status.state === "live" && url) {
      try {
        health = await probeBackendHealth(url);
      } catch {
        /* health is best-effort */
      }
    }
    return NextResponse.json({ ...status, health });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
