import { NextRequest, NextResponse } from "next/server";
import { releaseSnapshot, type VerifyRef } from "@/lib/deploy/verify-release";

export const maxDuration = 30;

/**
 * Post-deploy RELEASE verification — a single point-in-time status check the
 * client polls until terminal (live / failed / timeout). One provider API call
 * per request, so it stays well under the route's time budget while the build
 * itself runs for minutes in the background. Covers every provider:
 *
 *   GET /api/deploy/verify?provider=fly&appName=<app>
 *   GET /api/deploy/verify?provider=render&serviceId=<id>[&deployId=<id>]
 *   GET /api/deploy/verify?provider=railway&serviceId=<id>
 *   GET /api/deploy/verify?provider=vercel&deploymentId=<id>
 *
 * Closes the "app created but no release ever appears, stuck pending forever with
 * no feedback" gap (the my-app-rest-menu Fly failure).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const provider = q.get("provider");
  let ref: VerifyRef;
  switch (provider) {
    case "fly": {
      const appName = q.get("appName");
      if (!appName) return NextResponse.json({ error: "appName is required for fly" }, { status: 400 });
      ref = { provider: "fly", appName };
      break;
    }
    case "render": {
      const serviceId = q.get("serviceId");
      if (!serviceId) return NextResponse.json({ error: "serviceId is required for render" }, { status: 400 });
      ref = { provider: "render", serviceId, deployId: q.get("deployId") || undefined };
      break;
    }
    case "railway": {
      const serviceId = q.get("serviceId");
      if (!serviceId) return NextResponse.json({ error: "serviceId is required for railway" }, { status: 400 });
      ref = { provider: "railway", serviceId };
      break;
    }
    case "vercel": {
      const deploymentId = q.get("deploymentId");
      if (!deploymentId) return NextResponse.json({ error: "deploymentId is required for vercel" }, { status: 400 });
      ref = { provider: "vercel", deploymentId };
      break;
    }
    default:
      return NextResponse.json({ error: "provider must be one of: fly, render, railway, vercel" }, { status: 400 });
  }

  const status = await releaseSnapshot(ref);
  // `pending` → keep polling; everything else is terminal for the client.
  return NextResponse.json({ ...status, terminal: status.state !== "pending" });
}
