import { getLanguageFromPath } from "@/lib/utils";

export interface ExtractedFile {
  path: string;
  content: string;
  language: string;
}

// Map a markdown code-fence language tag to a file extension.
const EXT_BY_LANG: Record<string, string> = {
  html: "html", htm: "html", xml: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  javascript: "js", js: "js", node: "js", mjs: "mjs", cjs: "cjs",
  jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx",
  json: "json", json5: "json", py: "py", python: "py",
  java: "java", go: "go", golang: "go", rust: "rs", rs: "rs",
  c: "c", "c++": "cpp", cpp: "cpp", cxx: "cpp", cs: "cs", csharp: "cs",
  php: "php", ruby: "rb", rb: "rb", sql: "sql", yaml: "yaml", yml: "yaml",
  markdown: "md", md: "md", vue: "vue", svelte: "svelte", toml: "toml",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", dockerfile: "dockerfile",
};

// Sensible default base names per extension when no filename is given.
const DEFAULT_BASE: Record<string, string> = {
  html: "index", css: "styles", js: "script", jsx: "App", ts: "main",
  tsx: "App", json: "data", py: "main", java: "Main", go: "main",
  rs: "main", c: "main", cpp: "main", cs: "Program", php: "index",
  rb: "main", sql: "query", yaml: "config", md: "README", vue: "App",
  svelte: "App", sh: "script", scss: "styles", less: "styles",
  toml: "config", xml: "data", dockerfile: "Dockerfile",
};

// Language tags that are usually inline examples, not files to save.
const NON_FILE_LANGS = new Set(["console", "text", "plaintext", "txt", "output", "log", "diff", "bash", "sh", "shell", "zsh", ""]);

// Recognized filename pattern (basename or path ending in a known-ish extension).
const FILE_RE =
  /\.(html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|json5?|py|java|go|rs|c|cc|cpp|cxx|h|hpp|cs|php|rb|sql|ya?ml|toml|md|markdown|vue|svelte|sh|xml|txt|env)$/i;

// A filename comment on the first code line, e.g. "// app.js", "# main.py",
// "-- query.sql", or an HTML/CSS comment wrapping the name.
const FIRST_LINE_FILE_RE =
  /^\s*(?:\/\/|#|--|;|\/\*|<!--)\s*([\w.\-\/]+\.[a-zA-Z0-9]{1,6})\s*(?:\*\/|-->)?\s*$/;

function isFilename(token: string): boolean {
  return FILE_RE.test(token) && !/\s/.test(token);
}

/** Find the closest filename mentioned in the prose just before a code block. */
function filenameFromContext(pre: string): string | null {
  // The pattern only captures filename-safe chars, so matches need no cleanup.
  const matches = pre.match(/[\w.\-\/]+\.[a-zA-Z0-9]{1,6}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (isFilename(matches[i])) return matches[i];
  }
  return null;
}

/**
 * Extract files from an assistant markdown message. Handles fenced code blocks
 * with an info string that may carry a language and/or filename, a filename
 * comment on the first code line, or a filename mentioned in the preceding
 * prose. Falls back to language-based default names (index.html, styles.css,
 * script.js, …) so multi-file answers still populate the workspace.
 */
export function extractFilesFromMarkdown(content: string): ExtractedFile[] {
  const out: ExtractedFile[] = [];
  const usedPaths = new Set<string>();
  const langCounts: Record<string, number> = {};

  // Built from a string to avoid a regex-literal scanner ambiguity with the
  // leading backticks. Matches a fenced block: ```info\n…code…```
  const fence = new RegExp("```([^\\n]*)\\n([\\s\\S]*?)```", "g");
  let m: RegExpExecArray | null;

  while ((m = fence.exec(content)) !== null) {
    const info = m[1].trim();
    let code = m[2];
    const pre = content.slice(Math.max(0, m.index - 220), m.index);

    // Parse the info string into a language tag and an optional filename.
    const tokens = info.split(/\s+/).map((t) => t.replace(/^\/+/, "")).filter(Boolean);
    let langTag = "";
    let filename: string | null = null;
    for (const tok of tokens) {
      if (!filename && isFilename(tok)) filename = tok;
      else if (!langTag && /^[a-z0-9+#.-]+$/i.test(tok)) langTag = tok.toLowerCase();
    }

    // A filename comment on the first line wins, and gets stripped from output.
    const firstLineEnd = code.indexOf("\n");
    const firstLine = firstLineEnd === -1 ? code : code.slice(0, firstLineEnd);
    const fl = firstLine.match(FIRST_LINE_FILE_RE);
    if (fl) {
      filename = fl[1];
      code = firstLineEnd === -1 ? "" : code.slice(firstLineEnd + 1);
    }

    // Otherwise look at the surrounding prose.
    if (!filename) filename = filenameFromContext(pre);

    const codeTrimmed = code.trim();

    if (!filename) {
      const ext = EXT_BY_LANG[langTag];
      // No name + not a recognized file language, or a trivial snippet → skip.
      if (!ext || NON_FILE_LANGS.has(langTag)) continue;
      if (codeTrimmed.length < 40 && codeTrimmed.split("\n").length < 2) continue;
      const base = DEFAULT_BASE[ext] || "file";
      langCounts[ext] = (langCounts[ext] || 0) + 1;
      const n = langCounts[ext];
      filename = ext === "dockerfile" ? "Dockerfile" : n === 1 ? `${base}.${ext}` : `${base}${n}.${ext}`;
    }

    if (!codeTrimmed || usedPaths.has(filename)) continue;
    usedPaths.add(filename);
    out.push({
      path: filename,
      content: codeTrimmed,
      language: getLanguageFromPath(filename) || EXT_BY_LANG[langTag] || langTag || "text",
    });
  }

  return out;
}
