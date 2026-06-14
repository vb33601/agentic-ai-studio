"use client";

import dynamic from "next/dynamic";
import { Providers } from "./providers";

const WorkspaceLayout = dynamic(
  () => import("@/components/workspace/workspace-layout").then((m) => m.WorkspaceLayout),
  { ssr: false, loading: () => <AppLoader /> }
);

function AppLoader() {
  return (
    <div className="h-dvh bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-muted-foreground/40 border-t-foreground rounded-full animate-spin" />
        <p className="text-sm text-muted-foreground">Loading AI Platform...</p>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Providers>
      <div className="h-dvh overflow-hidden bg-background text-foreground">
        <WorkspaceLayout />
      </div>
    </Providers>
  );
}
