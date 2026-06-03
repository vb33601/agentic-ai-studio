"use client";

import { useRef, useCallback, Dispatch, SetStateAction } from "react";
import { Send, Paperclip, Cpu, StopCircle, X, FileText, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat";
import { isImage } from "@/lib/attachments";

interface ChatInputProps {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  handleSubmit: () => void;
  isLoading: boolean;
  stop: () => void;
  attachments: File[];
  setAttachments: Dispatch<SetStateAction<File[]>>;
}

const ACCEPT = "image/*,.pdf,.docx,.xlsx,.xls,.csv,.tsv,.txt,.md,.json,.yaml,.yml,.js,.ts,.jsx,.tsx,.py,.html,.css";

const SUGGESTIONS = [
  "Build a full-stack SaaS CRM platform",
  "Research the latest AI developments in 2025",
  "Create a responsive e-commerce website",
  "Build a browser-based 2D platformer game",
  "Design a modern dashboard UI with dark mode",
  "Generate a REST API with JWT authentication",
];

export function ChatInput({
  input, setInput, handleSubmit, isLoading, stop, attachments, setAttachments,
}: ChatInputProps) {
  const { enableTools, setEnableTools, selectedModel } = useChatStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSubmit = (input.trim().length > 0 || attachments.length > 0) && !isLoading;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if ((input.trim() || attachments.length > 0) && !isLoading) {
          handleSubmit();
        }
      }
    },
    [input, attachments.length, isLoading, handleSubmit]
  );

  const onFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length) setAttachments((prev) => [...prev, ...picked]);
    e.target.value = "";
  };

  const removeAttachment = (idx: number) =>
    setAttachments((prev) => prev.filter((_, i) => i !== idx));

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  return (
    <div className="w-full space-y-3">
      {!input && !isLoading && (
        <div className="flex flex-wrap gap-2 justify-center px-4">
          {SUGGESTIONS.slice(0, 3).map((s) => (
            <button
              key={s}
              onClick={() => setInput(s)}
              className="text-xs px-3 py-1.5 rounded-full border border-border/60 hover:border-primary/60 hover:bg-primary/5 transition-all text-muted-foreground hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {attachments.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              className="flex items-center gap-1.5 text-xs bg-muted rounded-lg pl-2 pr-1 py-1 border"
            >
              {isImage(file) ? <ImageIcon className="h-3 w-3 text-primary" /> : <FileText className="h-3 w-3 text-primary" />}
              <span className="max-w-[160px] truncate font-mono">{file.name}</span>
              <button
                onClick={() => removeAttachment(i)}
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative flex items-end gap-2 rounded-2xl border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring/30 p-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={onFilesPicked}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
          title="Attach files (images, PDF, DOCX, spreadsheets, code…)"
        >
          <Paperclip className="h-4 w-4" />
        </Button>

        <Textarea
          ref={textareaRef}
          value={input}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything — chat, build apps, research, write code..."
          className="min-h-[40px] max-h-[200px] resize-none border-none shadow-none focus-visible:ring-0 p-0 text-sm leading-relaxed"
          rows={1}
        />

        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-8 w-8 text-muted-foreground hover:text-foreground",
              enableTools && selectedModel.supportsTools && "text-primary hover:text-primary"
            )}
            onClick={() => setEnableTools(!enableTools)}
            title={enableTools ? "Disable tools" : "Enable tools (requires tool-capable model)"}
          >
            <Cpu className="h-4 w-4" />
          </Button>

          {isLoading ? (
            <Button size="icon" variant="destructive" className="h-8 w-8" onClick={stop}>
              <StopCircle className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-8 w-8"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <p className="text-center text-[11px] text-muted-foreground">
        {selectedModel.name} · {enableTools && selectedModel.supportsTools ? "Tools enabled" : "No tools"} · Enter to send, Shift+Enter for newline
      </p>
    </div>
  );
}
