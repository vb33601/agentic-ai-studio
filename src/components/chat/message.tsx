"use client";

import { useState } from "react";
import { UIMessage } from "ai";
import { Bot, User, Copy, Check, ChevronDown, ChevronUp, Wrench, Sparkles, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getToolParts, NormalizedToolPart } from "@/lib/ai/tool-parts";
import { GeneratedImage } from "./generated-image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  const [magicOpen, setMagicOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const textContent = message.parts
    ?.filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("") || "";

  // Tools arrive as either `tool-<name>` (typed) or `dynamic-tool` parts.
  const toolParts = getToolParts(message);

  // Quality-engine stream parts: the "magic prompt" + the implementation plan.
  const magicPrompt = (message.parts ?? []).find((p) => p.type === "data-magicPrompt") as
    | { data?: { original?: string; enhanced?: string; rewritten?: boolean; source?: string } }
    | undefined;
  const implPlan = (message.parts ?? []).find((p) => p.type === "data-plan") as
    | { data?: { plan?: string } }
    | undefined;

  const generatedImages = toolParts
    // Only once the tool call has settled — during input streaming the prompt
    // arrives char-by-char, which would otherwise restart generation repeatedly.
    .filter((p) => p.toolName === "generateImage" && (p.state === "output-available" || p.state === "output-error"))
    .map((p) => {
      const inp = (p.input ?? {}) as { prompt?: string };
      const out = (p.output ?? {}) as { url?: string; prompt?: string };
      return { prompt: out.prompt || inp.prompt || "", url: out.url };
    })
    .filter((g) => g.prompt || g.url);

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
    <div className={cn("group flex gap-2 sm:gap-3 py-4 px-3 sm:px-4", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted border"
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      <div className={cn("flex min-w-0 flex-col gap-2 max-w-[85%]", isUser && "items-end")}>
        {magicPrompt?.data && (
          <div className="w-full">
            <button
              onClick={() => setMagicOpen(!magicOpen)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Sparkles className="h-3 w-3 text-violet-500" />
              <span>Magic prompt{magicPrompt.data.source ? ` · ${magicPrompt.data.source}` : ""}</span>
              {magicOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {magicOpen && (
              <div className="mt-1 rounded-md border bg-muted/40 p-2 text-xs text-foreground whitespace-pre-wrap">
                {magicPrompt.data.enhanced || magicPrompt.data.original}
              </div>
            )}
          </div>
        )}
        {implPlan?.data?.plan && (
          <div className="w-full">
            <button
              onClick={() => setPlanOpen(!planOpen)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ListChecks className="h-3 w-3 text-emerald-500" />
              <span>Implementation plan</span>
              {planOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {planOpen && (
              <div className="mt-1 rounded-md border bg-muted/40 p-2 text-xs">
                <MessageContent content={implPlan.data.plan} />
              </div>
            )}
          </div>
        )}
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
            {generatedImages.map((img, i) =>
              img.prompt ? (
                <GeneratedImage key={i} prompt={img.prompt} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={img.url} alt="generated image" className="rounded-2xl max-w-sm object-contain border bg-muted" />
              )
            )}
          </div>
        )}

        {textContent && (
          <div
            className={cn(
              "min-w-0 max-w-full rounded-2xl px-4 py-3 text-sm leading-relaxed",
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

// Full markdown rendering (headings, paragraphs, lists, tables, links, code) —
// the same kind of formatting ChatGPT/Claude show.
function MessageContent({ content }: { content: string }) {
  return (
    <div className="min-w-0 space-y-2 text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-bold mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground">{children}</blockquote>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          hr: () => <hr className="my-3 border-border" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="w-full text-xs border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold bg-muted/50">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
          img: ({ src, alt }) =>
            typeof src === "string" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={alt || "image"} className="rounded-xl max-w-sm object-contain border bg-muted my-2" />
            ) : null,
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className || "");
            const text = String(children).replace(/\n$/, "");
            // Fenced block (has a language) or multiline → styled code block.
            if (match || text.includes("\n")) {
              return <CodeBlock code={text} language={match?.[1] || ""} />;
            }
            return <code className="px-1 py-0.5 rounded bg-black/20 dark:bg-white/10 text-[0.85em] font-mono break-all">{children}</code>;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
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
    <div className="my-2 rounded-lg border overflow-hidden bg-muted">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/60 border-b">
        <span className="text-xs text-muted-foreground font-mono">{language || "code"}</span>
        <button onClick={copy} className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-xs text-foreground leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
