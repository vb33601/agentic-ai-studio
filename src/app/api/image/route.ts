import { NextRequest, NextResponse } from "next/server";

// Map DALL-E size strings to width/height for the Pollinations fallback.
function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split("x").map((n) => parseInt(n, 10));
  return {
    width: Number.isFinite(w) ? w : 1024,
    height: Number.isFinite(h) ? h : 1024,
  };
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, size = "1024x1024", quality = "standard" } = await req.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "A text prompt is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    // Use DALL-E 3 when an OpenAI key is configured...
    if (apiKey) {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: "dall-e-3", prompt, size, quality, n: 1 }),
      });

      const data = await res.json();
      if (!res.ok) {
        return NextResponse.json(
          { error: data.error?.message || "Image generation failed" },
          { status: res.status }
        );
      }
      return NextResponse.json({ url: data.data?.[0]?.url, prompt, provider: "dall-e-3" });
    }

    // ...otherwise fall back to the keyless Pollinations service.
    const { width, height } = parseSize(size);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      prompt
    )}?width=${width}&height=${height}&nologo=true&enhance=true`;
    return NextResponse.json({ url, prompt, provider: "pollinations" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
