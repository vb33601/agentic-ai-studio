import { NextRequest, NextResponse } from "next/server";
import { smokeTestFrontend } from "@/lib/deploy/smoke";

// A real headless-browser run can take ~30s; keep within the Hobby 60s cap.
export const maxDuration = 60;

/**
 * Smoke-test a deployed frontend: POST { url } (or GET ?url=).
 * Returns a SmokeResult — HTTP sanity always, plus a real browser pass where a
 * Chromium binary is available (else it degrades to the HTTP verdict). The
 * deploy panel runs this once the frontend is live to verify it actually works
 * for a user (renders, no console/API errors) rather than just "built".
 */
async function handle(url: string | null, backendUrl?: string | null) {
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });
  try {
    const parsed = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    const result = await smokeTestFrontend(parsed.toString(), { backendUrl: backendUrl ?? null });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req.nextUrl.searchParams.get("url"), req.nextUrl.searchParams.get("backendUrl"));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return handle(body?.url ?? null, body?.backendUrl ?? null);
}
