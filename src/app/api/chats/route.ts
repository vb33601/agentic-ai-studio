import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/db/user";
import { listChats, createChat } from "@/lib/db/repo";

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  try {
    const chats = await listChats(userId);
    return NextResponse.json({ chats });
  } catch (error) {
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
    console.error("[chats:create]", error);
    return NextResponse.json({ error: "Failed to create chat" }, { status: 500 });
  }
}
