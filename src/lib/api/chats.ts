import type { UIMessage } from "ai";
import { getLocalUserId } from "@/lib/user-id";

export interface ApiChat {
  id: string;
  title: string;
  model: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
}

function headers(): HeadersInit {
  return { "Content-Type": "application/json", "x-user-id": getLocalUserId() };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiListChats(): Promise<ApiChat[]> {
  const data = await json<{ chats: ApiChat[] }>(await fetch("/api/chats", { headers: headers() }));
  return data.chats;
}

export async function apiCreateChat(input: {
  id?: string;
  title?: string;
  model?: string;
  provider?: string;
}): Promise<ApiChat> {
  const data = await json<{ chat: ApiChat }>(
    await fetch("/api/chats", { method: "POST", headers: headers(), body: JSON.stringify(input) })
  );
  return data.chat;
}

export async function apiGetChatMessages(id: string): Promise<UIMessage[]> {
  const res = await fetch(`/api/chats/${id}`, { headers: headers() });
  if (res.status === 404) return [];
  const data = await json<{ messages: UIMessage[] }>(res);
  return data.messages ?? [];
}

export async function apiRenameChat(id: string, title: string): Promise<void> {
  await fetch(`/api/chats/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ title }) });
}

export async function apiDeleteChat(id: string): Promise<void> {
  await fetch(`/api/chats/${id}`, { method: "DELETE", headers: headers() });
}

export async function apiSaveMessages(id: string, messages: UIMessage[]): Promise<void> {
  await fetch(`/api/chats/${id}/messages`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ messages }),
  });
}
