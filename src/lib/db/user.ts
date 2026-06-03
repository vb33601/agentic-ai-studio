import { NextRequest } from "next/server";

/** Read the client-supplied local user id. All chat APIs are scoped to it. */
export function getUserId(req: NextRequest): string | null {
  const id = req.headers.get("x-user-id");
  if (!id || id.length < 8 || id.length > 64) return null;
  return id;
}
