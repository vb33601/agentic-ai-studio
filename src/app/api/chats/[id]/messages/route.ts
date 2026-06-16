import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/db/user";
import { saveMessages } from "@/lib/db/repo";
import { dbUnavailable } from "@/lib/prisma";
import type { UIMessage } from "ai";

// Replace the full message list for a chat (client sends the authoritative set).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  const { id } = await params;
  try {
    const { messages } = (await req.json()) as { messages: UIMessage[] };
    if (!Array.isArray(messages)) return NextResponse.json({ error: "messages required" }, { status: 400 });
    const ok = await saveMessages(userId, id, messages);
    return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    // Best-effort persistence: a DB outage must not 500 mid-generation (the chat
    // still works in the browser). Report it softly so the client doesn't log it.
    if (dbUnavailable(error)) {
      console.warn("[messages:save] database unavailable — not persisted");
      return NextResponse.json({ ok: false, persisted: false }, { status: 200 });
    }
    console.error("[messages:save]", error);
    return NextResponse.json({ error: "Failed to save messages" }, { status: 500 });
  }
}
