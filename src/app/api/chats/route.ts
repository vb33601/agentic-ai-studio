import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/db/user";
import { listChats, createChat } from "@/lib/db/repo";
import { dbUnavailable } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  try {
    const chats = await listChats(userId);
    return NextResponse.json({ chats });
  } catch (error) {
    // DB down → show an empty history rather than 500-ing the whole app shell.
    if (dbUnavailable(error)) {
      console.warn("[chats:list] database unavailable — returning empty list");
      return NextResponse.json({ chats: [] });
    }
    console.error("[chats:list]", error);
    return NextResponse.json({ error: "Failed to load chats" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  try {
    const body = await req.json().catch(() => ({}));
    const chat = await createChat(userId, body);
    return NextResponse.json({ chat }, { status: 201 });
  } catch (error) {
    // DB down → the client falls back to a local chat id, so chatting still works.
    // Report softly (200, chat:null) so it isn't logged as a server error.
    if (dbUnavailable(error)) {
      console.warn("[chats:create] database unavailable — client will use a local id");
      return NextResponse.json({ chat: null, offline: true });
    }
    console.error("[chats:create]", error);
    return NextResponse.json({ error: "Failed to create chat" }, { status: 500 });
  }
}
