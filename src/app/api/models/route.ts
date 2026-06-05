import { NextRequest, NextResponse } from "next/server";
import { MODEL_OPTIONS } from "@/lib/ai/providers";
import { getModelCatalog, searchHuggingFace } from "@/lib/ai/models-catalog";

export const maxDuration = 30;

// GET /api/models            -> full catalogue (OpenRouter + AIML), curated fallback
// GET /api/models?hf=<query> -> on-demand Hugging Face Hub search (100k+ models)
export async function GET(req: NextRequest) {
  const hf = req.nextUrl.searchParams.get("hf");
  if (hf) {
    const models = await searchHuggingFace(hf);
    return NextResponse.json({ models });
  }
  try {
    const models = await getModelCatalog();
    // Fall back to the curated list if the upstream catalogues are unreachable.
    return NextResponse.json({ models: models.length ? models : MODEL_OPTIONS });
  } catch {
    return NextResponse.json({ models: MODEL_OPTIONS });
  }
}
