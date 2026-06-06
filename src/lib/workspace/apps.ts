import type { WorkspaceFile } from "@/store/workspace";

/**
 * Multi-app / multi-folder workspace helpers.
 *
 * A chat can produce several apps, or a full-stack app split into
 * `frontend/` + `backend/`. The preview/deploy UI offers a dropdown of
 * selectable folders so the user picks exactly what to run or ship:
 *  - "Whole project" (root) — run/deploy everything together (full-stack).
 *  - each folder that contains its own package.json (e.g. frontend, backend).
 *
 * Pure module (no @webcontainer/api import) so it's safe in client UI and
 * server deploy code.
 */

export interface AppGroup {
  /** Folder to act on ("" = whole project / workspace root). */
  root: string;
  /** Display label for the selector. */
  name: string;
}

/** Directory part of a path ("frontend/package.json" -> "frontend"). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * List the selectable folders for preview/deploy. Returns an EMPTY array when
 * the workspace has a single obvious target (no dropdown needed); otherwise a
 * "Whole project" option followed by one entry per package.json folder.
 */
export function detectAppGroups(files: WorkspaceFile[]): AppGroup[] {
  const pkgDirs = new Set<string>();
  for (const f of files) {
    if (f.path === "package.json" || f.path.endsWith("/package.json")) pkgDirs.add(dirOf(f.path));
  }

  const dirs = [...pkgDirs];
  // 0 or 1 package.json folder => a single obvious target, so no dropdown.
  if (dirs.length < 2) return [];

  const sorted = dirs.sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  const groups: AppGroup[] = sorted.map((d) => ({ root: d, name: d || "Whole project" }));
  // Ensure a "Whole project" (root) option exists for full-stack runs.
  if (!groups.some((g) => g.root === "")) {
    groups.unshift({ root: "", name: "Whole project" });
  }
  return groups;
}

/**
 * Scope the workspace to one folder, re-rooted so its files sit at the top
 * (e.g. `frontend/package.json` -> `package.json`). An empty root returns every
 * file unchanged (the whole project).
 */
export function filesForApp(files: WorkspaceFile[], root: string): WorkspaceFile[] {
  if (!root) return files;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
}

/**
 * Resolve which folder to act on: the stored selection if it still exists, else
 * the first group, else "" (the whole project).
 */
export function resolveAppRoot(groups: AppGroup[], selected: string | null): string {
  if (selected !== null && groups.some((g) => g.root === selected)) return selected;
  return groups[0]?.root ?? "";
}
