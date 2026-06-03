import { NextResponse } from "next/server";
import { MODEL_OPTIONS } from "@/lib/ai/providers";

export async function GET() {
  return NextResponse.json({ models: MODEL_OPTIONS });
}
