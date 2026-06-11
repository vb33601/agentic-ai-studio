/**
 * Shared web-search + page-fetch helpers, used by BOTH the chat web-search tool
 * and the build/deploy auto-fix loop ([[auto-fix]]). Provider order is
 * Tavily → Serper → DuckDuckGo (whichever key is configured), so known-issue
 * lookups work wherever the platform is hosted. Pure server utilities — no React,
 * no AI SDK — so they're safe to call from API routes and tools alike.
 */

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  answer?: string;
  results: WebResult[];
  note?: string;
}

async function searchWithTavily(query: string, maxResults: number): Promise<WebSearchResult> {
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
    results:
      (data.results as Array<{ title: string; url: string; content: string }> | undefined)?.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      })) || [],
  };
}

async function searchWithSerper(query: string, maxResults: number): Promise<WebSearchResult> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": process.env.SERPER_API_KEY! },
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

async function searchWithDuckDuckGo(query: string): Promise<WebSearchResult> {
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
    note: "Results from DuckDuckGo (limited). Configure TAVILY_API_KEY or SERPER_API_KEY for better coverage.",
  };
}

/** Search the web via the best configured provider. Never throws — returns []. */
export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult> {
  try {
    if (process.env.TAVILY_API_KEY) return await searchWithTavily(query, maxResults);
    if (process.env.SERPER_API_KEY) return await searchWithSerper(query, maxResults);
    return await searchWithDuckDuckGo(query);
  } catch (e) {
    return { results: [], note: `search failed: ${String(e)}` };
  }
}

/**
 * Fetch a page and return readable-ish text (tags/scripts stripped), capped at
 * `maxChars`. Used to go DEEPER than snippets — read the accepted Stack Overflow
 * answer or GitHub issue resolution in full. Never throws; "" on any failure.
 */
export async function fetchPageText(url: string, maxChars = 4000): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-Platform/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    if (!/text|html|json|xml/.test(ct)) return "";
    const body = await res.text();
    return body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
  } catch {
    return "";
  }
}
