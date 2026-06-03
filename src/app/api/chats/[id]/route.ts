import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/db/user";
import { getChatWithMessages, renameChat, deleteChat } from "@/lib/db/repo";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  const { id } = await params;
  try {
    const result = await getChatWithMessages(userId, id);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ chat: result.chat, messages: result.messages });
  } catch (error) {
    console.error("[chat:get]", error);
    return NextResponse.json({ error: "Failed to load chat" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  const { id } = await params;
  try {
    const { title } = await req.json();
    if (typeof title !== "string") return NextResponse.json({ error: "title required" }, { status: 400 });
    const ok = await renameChat(userId, id, title);
    return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    console.error("[chat:rename]", error);
    return NextResponse.json({ error: "Failed to rename chat" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  const { id } = await params;
  try {
    const ok = await deleteChat(userId, id);
    return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    console.error("[chat:delete]", error);
    return NextResponse.json({ error: "Failed to delete chat" }, { status: 500 });
  }
}
