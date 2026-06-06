"use client";

import { useMemo } from "react";
import { Boxes } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useWorkspaceStore } from "@/store/workspace";
import { detectAppGroups, resolveAppRoot } from "@/lib/workspace/apps";

/**
 * App picker shown when a chat contains multiple independent apps. Preview and
 * Deploy both act on the selected app's folder. Renders nothing for a
 * single-app workspace.
 */
export function AppSelector() {
  const { files, selectedAppDir, setSelectedAppDir } = useWorkspaceStore();
  const groups = useMemo(() => detectAppGroups(files), [files]);
  if (groups.length === 0) return null;

  const current = resolveAppRoot(groups, selectedAppDir);

  return (
    <div className="flex items-center gap-1.5">
      <Boxes className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <Select value={current} onValueChange={setSelectedAppDir}>
        <SelectTrigger className="h-7 text-xs w-auto min-w-[8rem] gap-1.5">
          <SelectValue placeholder="Select app" />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectItem key={g.root} value={g.root} className="text-xs">
              {g.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
