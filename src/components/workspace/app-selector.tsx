"use client";

import { useMemo } from "react";
import { Boxes } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useWorkspaceStore } from "@/store/workspace";
import { detectAppGroups, resolveAppRoot } from "@/lib/workspace/apps";

// Radix Select disallows an empty-string item value, so the root ("" = whole
// project) is represented by this sentinel inside the dropdown only.
const ROOT = "∕"; // division slash — unlikely to collide with a folder name

/**
 * Folder picker for preview/deploy. Lists "Whole project" + every package.json
 * folder (e.g. frontend, backend) so the user can choose exactly what to run or
 * ship. Renders nothing for a single-target workspace.
 */
export function AppSelector() {
  const { files, selectedAppDir, setSelectedAppDir } = useWorkspaceStore();
  const groups = useMemo(() => detectAppGroups(files), [files]);
  if (groups.length === 0) return null;

  const current = resolveAppRoot(groups, selectedAppDir);

  return (
    <div className="flex items-center gap-1.5">
      <Boxes className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <Select
        value={current || ROOT}
        onValueChange={(v) => setSelectedAppDir(v === ROOT ? "" : v)}
      >
        <SelectTrigger className="h-7 text-xs w-auto min-w-[8rem] gap-1.5">
          <SelectValue placeholder="Select folder" />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectItem key={g.root || ROOT} value={g.root || ROOT} className="text-xs">
              {g.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
