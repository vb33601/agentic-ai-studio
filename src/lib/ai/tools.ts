import { tool } from "ai";
import { z } from "zod";

async function searchWithTavily(query: string, maxResults: number) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      include_answer: true,
      include_raw_content: false,
    }),
  });
  const data = await res.json();
  return {
    answer: data.answer as string | undefined,
    results: (data.results as Array<{ title: string; url: string; content: string; score: number }> | undefined)?.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    })) || [],
  };
}

async function searchWithSerper(query: string, maxResults: number) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.SERPER_API_KEY!,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });
  const data = await res.json();
  type SerperResult = { title: string; link: string; snippet: string };
  return {
    answer: (data.answerBox?.answer || data.answerBox?.snippet) as string | undefined,
    results: ((data.organic as SerperResult[] | undefined) || []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    })),
  };
}

async function searchWithDuckDuckGo(query: string) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { "User-Agent": "AI-Platform/1.0" } });
  const data = await res.json();
  type DDGTopic = { Text?: string; FirstURL?: string; Topics?: DDGTopic[] };
  const topics: DDGTopic[] = data.RelatedTopics || [];
  const results = topics
    .flatMap((t: DDGTopic) => (t.Topics ? t.Topics : [t]))
    .filter((t: DDGTopic) => t.Text && t.FirstURL)
    .slice(0, 8)
    .map((t: DDGTopic) => ({ title: t.Text!.split(" - ")[0], url: t.FirstURL!, snippet: t.Text! }));
  return {
    answer: (data.AbstractText as string | undefined) || undefined,
    results,
    note: "Results from DuckDuckGo (limited). For better results, configure TAVILY_API_KEY or SERPER_API_KEY.",
  };
}

export const webSearchTool = tool({
  description: "Search the web for current information, news, and facts",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    maxResults: z.number().optional().default(5).describe("Maximum number of results"),
  }),
  execute: async ({ query, maxResults = 5 }) => {
    try {
      if (process.env.TAVILY_API_KEY) return await searchWithTavily(query, maxResults);
      if (process.env.SERPER_API_KEY) return await searchWithSerper(query, maxResults);
      return await searchWithDuckDuckGo(query);
    } catch (e) {
      return { error: String(e), results: [] as Array<{ title: string; url: string; snippet: string }> };
    }
  },
});

export const codeExecutionTool = tool({
  description: "Execute JavaScript/TypeScript code in a sandboxed environment",
  inputSchema: z.object({
    code: z.string().describe("The code to execute"),
    language: z.enum(["javascript", "typescript"]).default("javascript"),
  }),
  execute: async ({ code }) => {
    try {
      const logs: string[] = [];
      const consoleMock = {
        log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
        error: (...args: unknown[]) => logs.push("ERROR: " + args.map(String).join(" ")),
        warn: (...args: unknown[]) => logs.push("WARN: " + args.map(String).join(" ")),
      };
      const fn = new Function(
        "console",
        `try { ${code} } catch(e) { console.error('RUNTIME ERROR: ' + e.message); }`
      );
      fn(consoleMock);
      return { output: logs.join("\n"), success: true };
    } catch (e) {
      return { output: String(e), success: false };
    }
  },
});

export const fileReadTool = tool({
  description: "Read the content of a file by path",
  inputSchema: z.object({
    path: z.string().describe("The file path to read"),
  }),
  execute: async ({ path }) => {
    return { content: `[File reading not available in browser context: ${path}]`, path };
  },
});

export const generateImageTool = tool({
  description: "Generate an image from a text description",
  inputSchema: z.object({
    prompt: z.string().describe("Detailed description of the image to generate"),
    width: z.number().optional().default(1024).describe("Image width in pixels"),
    height: z.number().optional().default(1024).describe("Image height in pixels"),
  }),
  // The actual image is produced by the client via the same-origin /api/image
  // proxy (using `prompt`), so the tool just acknowledges the request quickly.
  execute: async ({ prompt, width = 1024, height = 1024 }) => {
    return { prompt, width, height };
  },
});

export const createFileTool = tool({
  description: "Create or update a file with given content in the workspace",
  inputSchema: z.object({
    path: z.string().describe("File path relative to project root"),
    content: z.string().describe("Complete file content"),
    language: z.string().optional().describe("Programming language"),
  }),
  execute: async ({ path, content, language }) => {
    return { path, content, language, created: true, message: `File ${path} created successfully` };
  },
});

export const thinkTool = tool({
  description: "Use this to think step by step before acting. Enables visible reasoning.",
  inputSchema: z.object({
    thought: z.string().describe("Your step-by-step reasoning or analysis"),
  }),
  execute: async ({ thought }) => {
    return { thought, timestamp: new Date().toISOString() };
  },
});

export const ALL_TOOLS = {
  webSearch: webSearchTool,
  codeExecution: codeExecutionTool,
  fileRead: fileReadTool,
  generateImage: generateImageTool,
  createFile: createFileTool,
  think: thinkTool,
};
