import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

/** Studio-owned tables (Prisma models) — never migration candidates. */
const STUDIO_TABLES = new Set([
  "Agent", "ApiKey", "Chat", "Deployment", "Execution", "File", "FixOutcome",
  "Memory", "Message", "Organization", "OrganizationMember", "PreflightRule",
  "Project", "Task", "User",
]);

/**
 * Read-only diagnostic: list the tables in `public` with estimated row counts,
 * flagging which are studio-owned vs candidate app tables. Used to plan moving a
 * deployed app's tables into its own schema (the shared-`public` collision).
 */
export async function GET() {
  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string; rows: bigint }[]>(
      `SELECT c.relname AS name, c.reltuples::bigint AS rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = 'public'
       ORDER BY c.relname`,
    );
    const tables = rows.map((r) => ({
      name: r.name,
      rows: Number(r.rows),
      owner: STUDIO_TABLES.has(r.name) ? "studio" : "app-candidate",
    }));
    return NextResponse.json({
      schema: "public",
      studio: tables.filter((t) => t.owner === "studio").map((t) => t.name),
      appCandidates: tables.filter((t) => t.owner === "app-candidate"),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
