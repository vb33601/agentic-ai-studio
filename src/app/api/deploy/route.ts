import { NextRequest, NextResponse } from "next/server";
import { deployToVercel, getDeploymentStatus } from "@/lib/deploy/vercel";
import { prepareForDeploy } from "@/lib/deploy/prepare";
import type { WorkspaceFile } from "@/store/workspace";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { provider = "vercel", files, name } = (await req.json()) as {
      provider?: string;
      files: WorkspaceFile[];
      name?: string;
    };

    if (provider !== "vercel") {
      return NextResponse.json(
        { error: `Provider "${provider}" is not configured. Vercel is currently wired up.` },
        { status: 400 }
      );
    }
    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files to deploy." }, { status: 400 });
    }

    // Normalize the project (complete manifest, forgiving build, inject config)
    // so Vercel's build is robust across stacks.
    const prep = prepareForDeploy(files);
    const result = await deployToVercel(prep.files as WorkspaceFile[], {
      name,
      framework: prep.framework,
      buildCommand: prep.buildCommand,
      outputDirectory: prep.outputDirectory,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[deploy]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// Poll deployment status: /api/deploy?id=<deploymentId>
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const status = await getDeploymentStatus(id);
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
