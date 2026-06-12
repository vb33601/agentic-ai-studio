import { NextRequest, NextResponse } from "next/server";

/**
 * Fail-closed gate for diagnostic/introspection endpoints. A handler is DISABLED
 * (403) unless `PREFLIGHT_DIAG_TOKEN` is set AND the request presents it (header
 * `x-diag-token` or `?token=`). No token configured ⇒ no access — never open by
 * default. Keeps internal data (table names, learned weights) private.
 */
export function diagAuthorized(req: NextRequest): boolean {
  const expected = process.env.PREFLIGHT_DIAG_TOKEN;
  if (!expected) return false;
  const given = req.headers.get("x-diag-token") || req.nextUrl.searchParams.get("token");
  return !!given && given === expected;
}

/** Returns a 403 response when the request isn't authorized, else null. */
export function diagForbidden(req: NextRequest): NextResponse | null {
  return diagAuthorized(req) ? null : NextResponse.json({ error: "forbidden" }, { status: 403 });
}
