import { prisma } from "@/lib/prisma";
import type { UIMessage } from "ai";
import type { MessageRole } from "@prisma/client";

/**
 * Server-side data access for chats and messages.
 *
 * Identity model: this is a local-first platform with no login UI, so each
 * browser carries a stable client-generated user id (see the chat store). We
 * upsert a User row for it on first use. All queries are scoped by userId so
 * different browsers/people get isolated histories.
 */

export async function ensureUser(userId: string) {
  return prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, email: `local-${userId}@aiplatform.local`, name: "Local User" },
  });
}

export async function listChats(userId: string) {
  return prisma.chat.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      model: true,
      provider: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
}

export async function createChat(
  userId: string,
  data: { id?: string; title?: string; model?: string; provider?: string }
) {
  await ensureUser(userId);
  return prisma.chat.create({
    data: {
      id: data.id,
      userId,
      title: data.title?.slice(0, 200) || "New Chat",
      model: data.model || "openai/gpt-4o",
      provider: data.provider || "openrouter",
    },
  });
}

export async function getChatWithMessages(userId: string, chatId: string) {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!chat) return null;
  // Reconstruct the original UIMessage objects we stored in metadata so the
  // client gets full fidelity (text + tool parts + images).
  const messages: UIMessage[] = chat.messages.map((m) => m.metadata as unknown as UIMessage);
  return { chat, messages };
}

export async function renameChat(userId: string, chatId: string, title: string) {
  const res = await prisma.chat.updateMany({
    where: { id: chatId, userId },
    data: { title: title.slice(0, 200) },
  });
  return res.count > 0;
}

export async function deleteChat(userId: string, chatId: string) {
  const res = await prisma.chat.deleteMany({ where: { id: chatId, userId } });
  return res.count > 0;
}

function roleToEnum(role: string): MessageRole {
  switch (role) {
    case "assistant":
      return "ASSISTANT";
    case "system":
      return "SYSTEM";
    case "tool":
      return "TOOL";
    default:
      return "USER";
  }
}

function textOf(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p ? (p as { text: string }).text : ""))
    .join("");
}

/**
 * Persist the full message list for a chat. We replace rather than diff:
 * the client always sends the complete, authoritative conversation.
 */
export async function saveMessages(userId: string, chatId: string, messages: UIMessage[]) {
  const owned = await prisma.chat.findFirst({ where: { id: chatId, userId }, select: { id: true } });
  if (!owned) return false;

  await prisma.$transaction([
    prisma.message.deleteMany({ where: { chatId } }),
    prisma.message.createMany({
      data: messages.map((m) => ({
        chatId,
        role: roleToEnum(m.role),
        content: textOf(m),
        // Store the whole UIMessage so parts/tools/images survive a reload.
        metadata: m as unknown as object,
      })),
    }),
    prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }),
  ]);
  return true;
}
