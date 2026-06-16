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
import { findAppGaps } from "@/lib/ai/incomplete-files";
import { apiCreateChat, apiGetChatMessages, apiSaveMessages } from "@/lib/api/chats";
import { isImage, imageToFilePart, parseDocument, buildDocContext } from "@/lib/attachments";

export function ChatWindow() {
  const {
    selectedModel,
    addSession, updateSession, activeChatId, setActiveChatId,
  } = useChatStore();
  const { addFile, setActiveTab } = useWorkspaceStore();
  const viewportRef = useRef<HTMLDivElement>(null);
  // Whether the view is "pinned" to the bottom. While true we follow new
  // content; if the user scrolls up to read, it flips false and we stop
  // yanking them back down until they return to the bottom.
  const pinnedRef = useRef(true);
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
  const extractFilesFromMessage = useCallback((message: UIMessage, switchToFiles = false) => {
    // Markdown code blocks across all text parts of the message.
    const fullText = (message.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? (p as { text: string }).text : ""))
      .join("\n");
    if (fullText) extractFilesFromText(fullText);

    // Capture the implementation plan (streamed by the prompt engine) so the
    // deploy flow can verify the app end-to-end against it.
    const planPart = (message.parts ?? []).find((p) => p.type === "data-plan") as
      | { data?: { plan?: string } }
      | undefined;
    if (planPart?.data?.plan) {
      useWorkspaceStore.getState().setImplementationPlan(planPart.data.plan);
    }

    // createFile tool outputs (parts are `tool-createFile` or `dynamic-tool`).
    const toolParts = getToolParts(message);

    let filesAdded = false;
    for (const part of toolParts) {
      // Generated images are handled by the <GeneratedImage> component, which
      // resolves them via Puter and saves the final image to the workspace.
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
    // Only jump to the Files tab for a fresh generation — never when
    // re-scanning history on load (that would yank the user off the chat).
    if (filesAdded && switchToFiles) setActiveTab("files");
  }, [addFile, setActiveTab, extractFilesFromText]);

  // --- chat ---

  const { messages, sendMessage, stop, status, setMessages, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // No client-side timeout. A build can stream for up to the server's 60-min
      // budget (slow free models produce ~1MB+ over many minutes). We forward to
      // the global fetch unchanged except for cache:"no-store" (never buffer/cache
      // the stream), so the request is only ever cancelled by the user's Stop
      // button (the AbortSignal useChat passes in init) — never by an implicit
      // timeout. This + the server's anti-buffering headers + keep-alive heartbeat
      // is what stops a long generation being truncated (it was being cut to
      // ~100KB in production by proxy buffering / idle drops).
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store" }),
      // Read request params lazily from the store so model/agent/tool changes
      // always take effect on the next send without re-creating the transport.
      body: () => {
        const s = useChatStore.getState();
        return {
          modelId: s.selectedModel.id,
          provider: s.selectedModel.provider,
          agentType: s.agentType,
          enableTools: s.enableTools && s.selectedModel.supportsTools,
          temperature: s.temperature,
          enhancePrompt: s.enhancePrompt,
          refineOutput: s.refineOutput,
        };
      },
    }),
    onFinish: ({ message }: { message: UIMessage }) => {
      // DEBUG_STREAM probe: how much actually REACHED the browser. Toggle in
      // devtools with `localStorage.DEBUG_STREAM = "1"`. Compare with the server's
      // `[DEBUG_STREAM] server produced …` log: if the server total is MBs but this
      // is KBs, the stream is being severed in transit; if both are small, the
      // generation itself came up short (gap detection / resume should catch it).
      if (typeof window !== "undefined" && window.localStorage?.getItem("DEBUG_STREAM") === "1") {
        const parts = message.parts ?? [];
        let textChars = 0;
        let toolChars = 0;
        for (const p of parts) {
          if (p.type === "text" && "text" in p) textChars += (p as { text: string }).text.length;
          const io = (p as { output?: unknown; input?: unknown }).output ?? (p as { input?: unknown }).input;
          if (io != null) toolChars += (typeof io === "string" ? io : JSON.stringify(io)).length;
        }
        const total = textChars + toolChars;
        // eslint-disable-next-line no-console
        console.log(`[DEBUG_STREAM] client received parts=${parts.length} textChars=${textChars} toolChars=${toolChars} total=${total} (~${(total / 1024).toFixed(1)}KB)`);
      }
      extractFilesFromMessage(message, true);
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
    // A freshly loaded/created chat should snap to the bottom even if the user
    // had scrolled up in the previous session.
    pinnedRef.current = true;
    // Reset the workspace; files repopulate from the loaded chat's messages
    // via the re-scan effect below (which also re-captures the plan).
    useWorkspaceStore.getState().setFiles([]);
    useWorkspaceStore.getState().setImplementationPlan(null);
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

  // Track whether the user is pinned to the bottom. Reading scroll position on
  // a passive listener (not in the render path) avoids fighting the stream.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      // 64px slack so being "almost" at the bottom still counts as pinned.
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow streaming output by scrolling the viewport itself (not
  // scrollIntoView, which can bubble up and shift the whole page on mobile).
  // Instant jumps — never "smooth" — so per-token updates don't stack
  // overlapping animations that make the view bounce up and down.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
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

  // AUTO-RESUME. When a streaming generation STOPS (for any reason — a clean
  // finish, an upstream free-model drop, a network/proxy cut), check whether the
  // produced app is actually complete. If a file was left cut off mid-content
  // (e.g. the model dropped while writing ClaimsList.jsx) or the server's
  // end-to-end verdict says it's incomplete, automatically send a continuation
  // request that picks up from the leftover — re-emitting the truncated files and
  // adding any missing ones — until it's complete or a bounded number of attempts
  // is reached. Each resume is a fresh request, so it survives any mid-generation
  // cut. Reset per new user message in handleSubmit.
  const MAX_AUTO_RESUME = 6;
  const autoResumeRef = useRef(0);
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    const justStopped = wasLoadingRef.current && !isLoading;
    wasLoadingRef.current = isLoading;
    if (!justStopped) return;

    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const files = useWorkspaceStore.getState().files;
    if (files.length === 0) { autoResumeRef.current = 0; return; }

    // The original request drives the stack-agnostic missing-component check.
    const firstUser = messages.find((m) => m.role === "user");
    const requestText = (firstUser?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? (p as { text: string }).text : ""))
      .join(" ");

    // The SERVER's post-generation verdict is authoritative: it ran every
    // deterministic structural check over the COMPLETE artifact set (and the LLM
    // judge when funded). So:
    //   - verdict ok=true  → the build is structurally complete; do NOT resume,
    //     even if the client's own thinner check disagrees. (This is what stops the
    //     catastrophic stacking on slow free models: each resume is a fresh multi-
    //     minute generation, and trusting an ok=true verdict prevents 3-6 of them.)
    //   - verdict ok=false → resume on the server's hard gaps.
    //   - NO verdict (stream cut before the server could emit one) → fall back to
    //     the client's own gap check so a truly-cut generation still recovers.
    const verdict = (last.parts ?? []).find((p) => p.type === "data-verification") as
      | { data?: { ok?: boolean; gaps?: string[] } } | undefined;
    let allGaps: string[];
    if (verdict?.data?.ok === true) {
      allGaps = [];
    } else if (verdict?.data?.ok === false) {
      allGaps = verdict.data?.gaps?.length ? verdict.data.gaps : ["the build is incomplete"];
    } else {
      allGaps = findAppGaps(files, requestText); // no server verdict → client check
    }

    if (allGaps.length > 0 && autoResumeRef.current < MAX_AUTO_RESUME) {
      autoResumeRef.current += 1;
      sendMessage({
        text:
          `The previous build was cut off mid-generation and is incomplete. Issues: ${allGaps.slice(0, 8).join("; ")}. ` +
          `Continue from where it stopped: re-output the COMPLETE version of each truncated file (same path), and create any missing files (backend, frontend, entry point, imports, config) so the app builds and runs end-to-end. Do NOT repeat files that are already complete.`,
      });
    } else {
      autoResumeRef.current = 0;
    }
    // sendMessage is stable; depend on isLoading/messages to fire on each stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, messages]);

  // --- submit ---

  const handleSubmit = useCallback(async () => {
    if ((!inputText.trim() && attachments.length === 0) || isLoading) return;

    autoResumeRef.current = 0; // a fresh user request resets the auto-resume budget
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
      useWorkspaceStore.getState().setImplementationPlan(null);
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
      <div className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2 border-b bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-2 shrink-0">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium hidden sm:inline">AI Assistant</span>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <AgentSelector />
          <ModelSelector />
        </div>
      </div>

      <ScrollArea className="flex-1" viewportRef={viewportRef}>
        <div className="pb-4 mx-auto w-full max-w-3xl xl:max-w-4xl 2xl:max-w-5xl">
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
          {error && <GenerationError message={error.message} />}
        </div>
      </ScrollArea>

      <div className="p-3 sm:p-4 border-t bg-background/80 backdrop-blur-sm">
        <div className="mx-auto w-full max-w-3xl xl:max-w-4xl 2xl:max-w-5xl">
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
    </div>
  );
}

// Turn a raw model/provider error into a clear, actionable message. The credit
// case is the common one and needs a top-up link, since no retry/fallback can
// fix an empty account balance.
function GenerationError({ message }: { message?: string }) {
  const msg = message || "";
  const isCredits = /requires more credits|can only afford|insufficient.*credit|\b402\b|max_tokens/i.test(msg);
  const isRate = /rate.?limit|\b429\b|quota/i.test(msg);

  let title = "Generation failed";
  let body = msg || "The model returned an error. Try another model.";
  let link: { href: string; text: string } | null = null;

  if (isCredits) {
    title = "Out of model credits";
    body = "Your OpenRouter balance is too low to finish this generation (it reserves credits for the whole response up front), so the app generated only partially. Add credits and try again.";
    link = { href: "https://openrouter.ai/settings/credits", text: "Add OpenRouter credits →" };
  } else if (isRate) {
    title = "Model rate-limited";
    body = "The model is temporarily rate-limited. Wait a moment and retry, or pick another model.";
  }

  return (
    <div className="mx-4 my-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span className="font-medium">{title}:</span> {body}
      {link && (
        <a href={link.href} target="_blank" rel="noreferrer" className="mt-1 block font-medium underline underline-offset-2">
          {link.text}
        </a>
      )}
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
