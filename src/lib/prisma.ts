import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

declare global {
  var prisma: PrismaClient | undefined;
}

// Prisma v7's default "client" engine requires a driver adapter. We use the
// node-postgres adapter pointed at DATABASE_URL.
function createClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = global.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") global.prisma = prisma;

/**
 * True when an error is a DB AVAILABILITY problem (can't reach / connect /
 * authenticate) rather than a bad query. Chat persistence is best-effort — when
 * the database is down (local dev with no Postgres, or a transient prod blip), the
 * routes should fail SOFT (don't 500 / spam the console mid-generation) instead of
 * making a working chat look broken. Prisma connection codes: P1000 auth, P1001
 * unreachable, P1002 timeout, P1008 op timeout, P1017 connection closed. The pg
 * adapter also surfaces raw ECONNREFUSED / ENOTFOUND / ETIMEDOUT.
 */
export function dbUnavailable(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code && /^P100[012]$|^P1008$|^P1017$/.test(code)) return true;
  if (code && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(code)) return true;
  const name = (error as { name?: string })?.name;
  if (name === "PrismaClientInitializationError") return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Can't reach database server|connection refused/i.test(msg);
}
