import { NextRequest } from "next/server";
import { generateImage } from "@/lib/ai/image-gen";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

// Same-origin image proxy: the browser loads /api/image?prompt=... so there is
// never any CORS, and provider API keys stay server-side. Returns image bytes.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const prompt = sp.get("prompt")?.trim();
  if (!prompt) return new Response("prompt required", { status: 400 });

  const seed = parseInt(sp.get("seed") || "0", 10) || 0;
  const width = Math.min(parseInt(sp.get("w") || "1024", 10) || 1024, 1024);
  const height = Math.min(parseInt(sp.get("h") || "1024", 10) || 1024, 1024);

  try {
    const result = await generateImage(prompt, width, height, seed);
    if (!result) {
      return new Response(JSON.stringify({ error: "All image providers failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Image-Provider": result.provider,
      },
    });
  } catch (error) {
    console.error("[api/image]", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
