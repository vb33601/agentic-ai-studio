"use client";

import { useState } from "react";
import { UIMessage } from "ai";
import { Bot, User, Copy, Check, ChevronDown, ChevronUp, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getToolParts, NormalizedToolPart } from "@/lib/ai/tool-parts";

interface MessageProps {
  message: UIMessage;
  isStreaming?: boolean;
}

function isImageOutput(output: unknown): output is { url: string; prompt?: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    "url" in output &&
    typeof (output as { url: unknown }).url === "string" &&
    (output as { url: string }).url.startsWith("http")
  );
}

export function ChatMessage({ message, isStreaming }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const textContent = message.parts
    ?.filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("") || "";

  // Tools arrive as either `tool-<name>` (typed) or `dynamic-tool` parts.
  const toolParts = getToolParts(message);

  const generatedImages = toolParts
    .filter((p) => p.toolName === "generateImage" && p.state === "output-available" && isImageOutput(p.output))
    .map((p) => p.output as { url: string; prompt?: string });

  // User-attached images arrive as file parts (multimodal input).
  const attachedImages = (message.parts ?? [])
    .filter((p) => {
      const part = p as { type: string; mediaType?: string; url?: string };
      return part.type === "file" && typeof part.url === "string" && part.mediaType?.startsWith("image/");
    })
    .map((p) => p as unknown as { url: string; filename?: string });

  const copyContent = () => {
    navigator.clipboard.writeText(textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("group flex gap-3 py-4 px-4", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted border"
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      <div className={cn("flex flex-col gap-2 max-w-[85%]", isUser && "items-end")}>
        {toolParts.length > 0 && (
          <div className="w-full">
            <button
              onClick={() => setToolsOpen(!toolsOpen)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Wrench className="h-3 w-3" />
              <span>{toolParts.length} tool call{toolParts.length > 1 ? "s" : ""}</span>
              {toolsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {toolsOpen && (
              <div className="mt-1 space-y-1">
                {toolParts.map((part, i) => (
                  <ToolCall key={i} part={part} />
                ))}
              </div>
            )}
          </div>
        )}

        {attachedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-end">
            {attachedImages.map((img, i) => (
              <img
                key={`att-${i}`}
                src={img.url}
                alt={img.filename ?? "attachment"}
                className="rounded-xl max-w-[200px] max-h-48 object-contain border bg-muted"
              />
            ))}
          </div>
        )}

        {generatedImages.length > 0 && (
          <div className="flex flex-col gap-2">
            {generatedImages.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt={img.prompt ?? "generated image"}
                className="rounded-2xl max-w-sm object-contain border bg-muted"
              />
            ))}
          </div>
        )}

        {textContent && (
          <div
            className={cn(
              "rounded-2xl px-4 py-3 text-sm leading-relaxed",
              isUser
                ? "bg-primary text-primary-foreground rounded-tr-sm"
                : "bg-muted rounded-tl-sm"
            )}
          >
            <MessageContent content={textContent} />
            {isStreaming && isAssistant && (
              <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-1 rounded-sm" />
            )}
          </div>
        )}

        {isAssistant && !isStreaming && textContent && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={copyContent}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
        )}
      </div>
    </div>
  );
}

function ToolCall({ part }: { part: NormalizedToolPart }) {
  const [open, setOpen] = useState(false);
  const isDone = part.state === "output-available" || part.state === "output-error";

  return (
    <div className="rounded-lg border bg-muted/30 text-xs overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Badge variant={isDone ? "success" : "secondary"} className="text-[10px] py-0">
            {isDone ? "Done" : "Running"}
          </Badge>
          <span className="font-mono font-medium">{part.toolName}</span>
        </div>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <div className="border-t px-3 py-2 space-y-2">
          <div>
            <div className="text-muted-foreground mb-1">Input</div>
            <pre className="text-xs bg-background rounded p-2 overflow-x-auto">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          </div>
          {part.state === "output-available" && part.output !== undefined && (
            <div>
              <div className="text-muted-foreground mb-1">Result</div>
              {isImageOutput(part.output) ? (
                <img
                  src={part.output.url}
                  alt={part.output.prompt ?? "generated image"}
                  className="rounded-lg max-w-full max-h-64 object-contain bg-muted"
                />
              ) : (
                <pre className="text-xs bg-background rounded p-2 overflow-x-auto max-h-32">
                  {typeof part.output === "string"
                    ? part.output
                    : JSON.stringify(part.output, null, 2)}
                </pre>
              )}
            </div>
          )}
          {part.state === "output-error" && (
            <div className="text-destructive text-xs">{part.errorText}</div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.split("\n");
          const lang = lines[0].replace("```", "").trim();
          const code = lines.slice(1, -1).join("\n");
          return <CodeBlock key={i} code={code} language={lang} />;
        }
        return <span key={i} className="whitespace-pre-wrap">{part}</span>;
      })}
    </>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2 rounded-lg border overflow-hidden bg-zinc-950">
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800">
        <span className="text-xs text-zinc-400 font-mono">{language || "code"}</span>
        <button onClick={copy} className="text-xs text-zinc-400 hover:text-white transition-colors flex items-center gap-1">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-xs text-zinc-100 leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
