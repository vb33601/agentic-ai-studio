"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import { nanoid } from "nanoid";
import { Bot, Sparkles } from "lucide-react";
import { ChatMessage } from "./message";
import { ChatInput } from "./chat-input";
import { ModelSelector } from "./model-selector";
import { AgentSelector } from "./agent-selector";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChatStore } from "@/store/chat";
import { useWorkspaceStore } from "@/store/workspace";
import { getLanguageFromPath } from "@/lib/utils";
import { getToolParts } from "@/lib/ai/tool-parts";
import { extractFilesFromMarkdown } from "@/lib/ai/extract-files";
import { apiCreateChat, apiGetChatMessages, apiSaveMessages } from "@/lib/api/chats";
import { isImage, imageToFilePart, parseDocument, buildDocContext } from "@/lib/attachments";

export function ChatWindow() {
  const {
    selectedModel,
    addSession, updateSession, activeChatId, setActiveChatId,
  } = useChatStore();
  const { addFile, setActiveTab } = useWorkspaceStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const sessionIdRef = useRef<string | null>(activeChatId);
  // Tracks which session's messages are currently loaded into useChat so the
  // load effect doesn't clobber an in-progress conversation. Starts null so a
  // persisted activeChatId is actually loaded on first mount (after reload).
  const loadedIdRef = useRef<string | null>(null);
  // Mirror of the live messages so onFinish can build the full conversation.
  const messagesRef = useRef<UIMessage[]>([]);

  // --- file extraction helpers ---

  const extractFilesFromText = useCallback((content: string) => {
    // Pull fenced code blocks out of assistant prose (handles the common case
    // where a model writes code in markdown instead of calling createFile).
    for (const f of extractFilesFromMarkdown(content)) {
      addFile({
        id: nanoid(),
        name: f.path.split("/").pop() || f.path,
        path: f.path,
        content: f.content,
        language: f.language,
        isDirty: false,
      });
    }
  }, [addFile]);

  // Scan a finished assistant message for createFile tool outputs and markdown
  // code blocks. addFile deduplicates by path so calling this multiple times
  // on the same message is safe.
  const extractFilesFromMessage = useCallback((message: UIMessage) => {
    // Markdown code blocks across all text parts of the message.
    const fullText = (message.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? (p as { text: string }).text : ""))
      .join("\n");
    if (fullText) extractFilesFromText(fullText);

    // createFile tool outputs (parts are `tool-createFile` or `dynamic-tool`).
    const toolParts = getToolParts(message);

    let filesAdded = false;
    for (const part of toolParts) {
      // Generated images: save the URL into the workspace as an image file.
      if (part.toolName === "generateImage") {
        const img = (part.output ?? part.input) as { url?: string; prompt?: string } | undefined;
        if (img?.url) {
          const slug = (img.prompt || "image").replace(/[^a-z0-9]+/gi, "-").slice(0, 32).replace(/^-|-$/g, "") || "image";
          const path = `images/${slug}.png`;
          addFile({ id: nanoid(), name: `${slug}.png`, path, content: img.url, language: "image", isDirty: false });
          filesAdded = true;
        }
        continue;
      }
      if (part.toolName !== "createFile") continue;
      // Prefer the tool output, but fall back to the input: persisted messages
      // can carry the file data on `input` with a non-final state, and the
      // input already holds the full {path, content}.
      const data = (part.output ?? part.input) as
        | { path?: string; content?: string; language?: string }
        | undefined;
      if (data?.path && data.content !== undefined && data.content !== "") {
        addFile({
          id: nanoid(),
          name: data.path.split("/").pop() || data.path,
          path: data.path,
          content: data.content,
          language: data.language || getLanguageFromPath(data.path) || "text",
          isDirty: false,
        });
        filesAdded = true;
      }
    }
    if (filesAdded) setActiveTab("files");
  }, [addFile, setActiveTab, extractFilesFromText]);

  // --- chat ---

  const { messages, sendMessage, stop, status, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // Read request params lazily from the store so model/agent/tool changes
      // always take effect on the next send without re-creating the transport.
      body: () => {
        const s = useChatStore.getState();
        return {
          modelId: s.selectedModel.id,
          agentType: s.agentType,
          enableTools: s.enableTools && s.selectedModel.supportsTools,
          temperature: s.temperature,
        };
      },
    }),
    onFinish: ({ message }: { message: UIMessage }) => {
      extractFilesFromMessage(message);
      // Save the FINALIZED message (tool parts are output-available with their
      // outputs here, unlike the streaming snapshot the render loop sees).
      const id = sessionIdRef.current;
      if (id) {
        const all = [...messagesRef.current.filter((m) => m.id !== message.id), message];
        apiSaveMessages(id, all).catch(() => {});
        updateSession(id, { messages: all.length });
      }
    },
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Load a session's history from the DB when the active chat changes (sidebar
  // click / new chat). loadedIdRef guards against wiping a freshly-started chat
  // and against a stale fetch landing after another switch.
  useEffect(() => {
    if (activeChatId === loadedIdRef.current) return;
    loadedIdRef.current = activeChatId;
    sessionIdRef.current = activeChatId;
    // Reset the workspace; files repopulate from the loaded chat's messages
    // via the re-scan effect below.
    useWorkspaceStore.getState().setFiles([]);
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    apiGetChatMessages(activeChatId)
      .then((msgs) => {
        if (loadedIdRef.current === activeChatId) setMessages(msgs);
      })
      .catch(() => {});
  }, [activeChatId, setMessages]);

  // Keep a live mirror of messages for onFinish to persist the full thread.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Safety net: re-scan all assistant messages the moment streaming stops.
  // This catches cases where onFinish fired before dynamic-tool parts were
  // fully hydrated. addFile is idempotent (deduplicates by path).
  useEffect(() => {
    if (isLoading) return;
    for (const msg of messages) {
      if (msg.role === "assistant") extractFilesFromMessage(msg);
    }
  }, [isLoading, messages, extractFilesFromMessage]);

  // --- submit ---

  const handleSubmit = useCallback(async () => {
    if ((!inputText.trim() && attachments.length === 0) || isLoading) return;

    const pending = attachments;
    setAttachments([]);

    if (messages.length === 0) {
      const titleSeed = inputText.trim() || pending[0]?.name || "New Chat";
      const title = titleSeed.slice(0, 60) + (titleSeed.length > 60 ? "…" : "");
      let id = nanoid();
      try {
        // Create the chat row first so the post-stream save has somewhere to go.
        const chat = await apiCreateChat({ title, model: selectedModel.id, provider: "openrouter" });
        id = chat.id;
      } catch {
        // DB unreachable — fall back to a local id so chatting still works.
      }
      addSession({
        id,
        title,
        model: selectedModel.name,
        provider: "openrouter",
        createdAt: new Date().toISOString(),
        messages: 1,
      });
      setActiveChatId(id);
      sessionIdRef.current = id;
      // Mark as loaded so the activeChatId effect doesn't reset the new chat.
      loadedIdRef.current = id;
      // Fresh chat starts with a clean workspace.
      useWorkspaceStore.getState().setFiles([]);
    }

    // Split attachments: images go as multimodal parts, documents get parsed
    // to text and appended to the prompt so any model can reason over them.
    let text = inputText;
    const images = pending.filter(isImage);
    const docs = pending.filter((f) => !isImage(f));

    if (docs.length > 0) {
      const parsed = await Promise.allSettled(docs.map(parseDocument));
      const ok = parsed.filter((p) => p.status === "fulfilled").map((p) => (p as PromiseFulfilledResult<Awaited<ReturnType<typeof parseDocument>>>).value);
      text += buildDocContext(ok);
      const failed = parsed.length - ok.length;
      if (failed > 0) text += `\n\n[${failed} attachment(s) could not be read]`;
      if (!text.trim()) text = "Analyze the attached document(s).";
    }

    const fileParts = await Promise.all(images.map(imageToFilePart));
    if (fileParts.length > 0 && !text.trim()) text = "Describe / analyze the attached image(s).";

    sendMessage(fileParts.length > 0 ? { text, files: fileParts } : { text });
    setInputText("");
  }, [inputText, attachments, isLoading, messages.length, addSession, selectedModel.id, selectedModel.name, setActiveChatId, sendMessage]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">AI Assistant</span>
        </div>
        <div className="flex items-center gap-2">
          <AgentSelector />
          <ModelSelector />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="pb-4">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((msg, i) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                isStreaming={isLoading && i === messages.length - 1 && msg.role === "assistant"}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="p-4 border-t bg-background/80 backdrop-blur-sm">
        <ChatInput
          input={inputText}
          setInput={setInputText}
          handleSubmit={handleSubmit}
          isLoading={isLoading}
          stop={stop}
          attachments={attachments}
          setAttachments={setAttachments}
        />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center p-8">
      <div className="rounded-2xl bg-primary/10 p-4 mb-4">
        <Bot className="h-10 w-10 text-primary" />
      </div>
      <h2 className="text-xl font-bold mb-2">What can I build for you?</h2>
      <p className="text-muted-foreground text-sm max-w-md leading-relaxed">
        I can chat, write and debug code, build complete applications, research topics,
        create games, design UIs, and much more. Select a model and agent type above to get started.
      </p>
    </div>
  );
}
