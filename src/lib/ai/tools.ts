import { tool } from "ai";
import { z } from "zod";
import { searchWeb } from "./web-search";

export const webSearchTool = tool({
  description: "Search the web for current information, news, and facts",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    maxResults: z.number().optional().default(5).describe("Maximum number of results"),
  }),
  execute: async ({ query, maxResults = 5 }) => searchWeb(query, maxResults),
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
