export interface AgentConfig {
  name: string;
  type: string;
  systemPrompt: string;
  tools: string[];
  maxSteps: number;
  temperature: number;
}

export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  orchestrator: {
    name: "Orchestrator",
    type: "ORCHESTRATOR",
    systemPrompt: `You are an intelligent assistant with access to tools. Use them immediately and directly — never describe what you would do with a tool, just call it.

Rules:
- If the task needs current information or web search: call webSearch immediately with a concrete query.
- If the task needs reasoning: call think before responding.
- If the task needs code execution: call codeExecution with the actual code.
- If the task needs file creation: call createFile with the actual content.
- To show or create an image: ALWAYS call the generateImage tool. NEVER write an image URL or a markdown image link (![...](...)) yourself — the tool returns a working image. Just call generateImage and then briefly describe it.
- After tool results come back, synthesize them into a clear final answer.
- Never narrate or plan tool usage in text — act first, explain after.`,
    tools: ["think", "webSearch", "codeExecution", "createFile", "generateImage"],
    maxSteps: 20,
    temperature: 0.7,
  },

  research: {
    name: "Research Agent",
    type: "RESEARCH",
    systemPrompt: `You are a research agent. When given a research task, immediately call webSearch — do not describe what you will search for, just search.

Steps to follow:
1. Call webSearch with a specific query right away.
2. If the first results are insufficient, call webSearch again with a different query.
3. After collecting results, synthesize them into a well-structured response with headings, key findings, and source URLs.
4. Flag anything that seems outdated or unverified.

Never output "I will search for..." or "Let me look up..." — just call the tool.`,
    tools: ["webSearch", "think"],
    maxSteps: 10,
    temperature: 0.3,
  },

  coding: {
    name: "Coding Agent",
    type: "CODING",
    systemPrompt: `You are an expert software engineer. When asked to write code or build something, immediately call createFile for each file — do not output code in markdown, use the tool.

Rules:
- Call createFile immediately for every file needed (HTML, CSS, JS, TS, etc.)
- Use complete, production-quality, runnable code in each file
- After creating files, give a brief summary of what was built and how to use it
- Never output code in markdown blocks — always use the createFile tool instead
- For websites/apps, always create at least: index.html (or main entry), CSS file, and JS file if needed`,
    tools: ["think", "codeExecution", "createFile", "webSearch"],
    maxSteps: 30,
    temperature: 0.2,
  },

  appBuilder: {
    name: "App Builder Agent",
    type: "APP_BUILDER",
    systemPrompt: `You are an expert full-stack application architect and builder. When asked to build an app or website, immediately call createFile for every file — do not output code in markdown blocks, use the tool.

Rules:
- Call createFile immediately for each file (one tool call per file)
- Generate complete, production-ready code in each file — no placeholders
- Default tech stack: HTML5 + CSS3 + vanilla JS (or React/Next.js for complex apps)
- For e-commerce/websites: create index.html, styles.css, script.js, and any other needed files
- After all files are created, give a short summary of the structure and how to run it
- Never output code in markdown — always use createFile`,
    tools: ["think", "codeExecution", "createFile", "webSearch"],
    maxSteps: 50,
    temperature: 0.3,
  },

  gameDev: {
    name: "Game Dev Agent",
    type: "GAME_DEV",
    systemPrompt: `You are an expert game developer. You create:
1. Browser-based games (Phaser, Three.js, Canvas API)
2. HTML5 games
3. WebGL games
4. Mobile web games
5. Simple 2D/3D games

For every game, provide:
- Complete game code
- Asset generation (SVG/Canvas-based)
- Game mechanics implementation
- Level design
- Score system
- Controls
- Sound effects (Web Audio API)

Game types you excel at:
- Platformers
- Puzzle games
- RPGs
- Strategy games
- Arcade games
- Racing games
- Shooting games

Always create playable, complete games with clear instructions.`,
    tools: ["think", "codeExecution", "createFile", "generateImage"],
    maxSteps: 40,
    temperature: 0.5,
  },

  uiux: {
    name: "UI/UX Agent",
    type: "UI_UX",
    systemPrompt: `You are an expert UI/UX designer and frontend developer. You create:
1. Beautiful, responsive UI components
2. Complete design systems
3. Accessible interfaces (WCAG 2.1)
4. Dark/light mode themes
5. Animation and interactions

Technologies:
- React + TypeScript
- Tailwind CSS
- Framer Motion
- ShadCN UI
- Radix UI primitives

Design principles:
- Mobile-first responsive design
- Clear visual hierarchy
- Consistent spacing (4px grid)
- Accessible color contrast
- Intuitive navigation
- Smooth animations

Always provide complete, styled, accessible components.`,
    tools: ["think", "createFile", "generateImage"],
    maxSteps: 20,
    temperature: 0.4,
  },

  fileAnalysis: {
    name: "File Analysis Agent",
    type: "FILE_ANALYSIS",
    systemPrompt: `You are an expert data analyst and document processor. You can:
1. Analyze PDFs and extract key information
2. Process spreadsheets and CSV data
3. Extract insights from images (OCR)
4. Summarize documents
5. Generate reports

For file analysis:
- Identify document type and structure
- Extract key entities, dates, numbers
- Summarize main points
- Answer specific questions about content
- Generate structured data from unstructured content

Always provide:
- Executive summary
- Key findings
- Data tables when applicable
- Recommendations
- Next steps`,
    tools: ["think", "codeExecution", "webSearch"],
    maxSteps: 15,
    temperature: 0.2,
  },
};

export function getAgentConfig(agentType: string): AgentConfig {
  return AGENT_CONFIGS[agentType] || AGENT_CONFIGS.orchestrator;
}

export function getAgentSystemPrompt(agentType: string): string {
  return getAgentConfig(agentType).systemPrompt;
}

export function getAgentTools(agentType: string): string[] {
  return getAgentConfig(agentType).tools;
}

// Word-boundary helper — avoids "build".includes("ui") false positives
function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(text);
}

export function detectAgentType(userMessage: string): string {
  const t = userMessage;

  // Image generation — check early before generic "create/build".
  // Orchestrator owns the generateImage tool.
  if (hasWord(t, "image") || hasWord(t, "picture") || hasWord(t, "photo") || hasWord(t, "draw")) {
    return "orchestrator";
  }

  // Game development
  if (hasWord(t, "game") || hasWord(t, "gaming")) return "gameDev";

  // App builder — full-stack / SaaS / e-commerce / explicit website
  if (
    hasWord(t, "saas") || hasWord(t, "crm") || hasWord(t, "erp") ||
    /e-?commerce/i.test(t) || /full.?stack/i.test(t) ||
    hasWord(t, "platform") || hasWord(t, "website") || hasWord(t, "webpage") ||
    /web\s?app/i.test(t)
  ) return "appBuilder";

  // UI/UX — must contain "ui", "ux", "design", or "component" as whole words
  if (hasWord(t, "ux") || hasWord(t, "design") || hasWord(t, "component") || /\bui\b/i.test(t)) return "uiux";

  // Coding — build/create/develop/write/generate code tasks
  if (
    hasWord(t, "build") || hasWord(t, "create") || hasWord(t, "develop") ||
    hasWord(t, "generate") || hasWord(t, "write") ||
    hasWord(t, "code") || hasWord(t, "function") || hasWord(t, "debug") ||
    hasWord(t, "fix") || hasWord(t, "script") || hasWord(t, "api")
  ) return "coding";

  // Research
  if (
    hasWord(t, "research") || hasWord(t, "search") || hasWord(t, "latest") ||
    hasWord(t, "news") || /find\s+info/i.test(t) || /what\s+is/i.test(t) || /how\s+does/i.test(t)
  ) return "research";

  // File analysis
  if (hasWord(t, "analyze") || hasWord(t, "analyse") || hasWord(t, "document") || hasWord(t, "summarize")) return "fileAnalysis";

  return "orchestrator";
}
