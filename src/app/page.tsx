"use client";

import dynamic from "next/dynamic";
import { Providers } from "./providers";

const WorkspaceLayout = dynamic(
  () => import("@/components/workspace/workspace-layout").then((m) => m.WorkspaceLayout),
  { ssr: false, loading: () => <AppLoader /> }
);

function AppLoader() {
  return (
    <div className="h-screen bg-zinc-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-zinc-600 border-t-white rounded-full animate-spin" />
        <p className="text-sm text-zinc-400">Loading AI Platform...</p>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Providers>
      <div className="h-screen overflow-hidden dark bg-zinc-950 text-zinc-50">
        <WorkspaceLayout />
      </div>
    </Providers>
  );
}
