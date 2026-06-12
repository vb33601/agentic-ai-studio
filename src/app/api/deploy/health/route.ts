import { NextRequest, NextResponse } from "next/server";
import { probeBackendHealth } from "@/lib/deploy/health";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

/**
 * Probe a deployed backend's liveness: GET /api/deploy/health?url=<backendUrl>.
 * Returns { healthy, reachable, status, bodySnippet } — see probeBackendHealth.
 * The deploy panel polls this after a backend deploy to verify the app actually
 * serves requests (build success ≠ runtime success), instead of optimistically
 * reporting "live".
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url query param required" }, { status: 400 });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return NextResponse.json({ error: "url must be http(s)" }, { status: 400 });
    }
    const health = await probeBackendHealth(parsed.toString());
    return NextResponse.json(health);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
