import type { WorkspaceFile } from "@/store/workspace";

/**
 * Multi-app workspace helpers.
 *
 * A single chat can produce several independent apps. To keep their files from
 * mixing — and to let preview/deploy target ONE app — we group the flat file
 * list by top-level folder. Folders with "part" names (frontend/backend/…) are
 * treated as pieces of ONE app, not separate apps, so a full-stack split stays
 * a single selectable app.
 *
 * Pure module (no @webcontainer/api import) so it's safe in both client UI and
 * server deploy code.
 */

export interface AppGroup {
  /** Top-level folder of the app ("" = workspace root). */
  root: string;
  /** Display label for the selector. */
  name: string;
}

/** Folder names that are PARTS of one app, never a separate app. */
const PART_NAMES = new Set([
  "frontend", "backend", "client", "server", "web", "api", "mobile", "desktop",
  "shared", "common", "packages", "src", "public", "static", "assets", "dist",
  "build", "node_modules", "components", "lib", "styles", "images", "scripts",
]);

function topSegment(path: string): string | null {
  const i = path.indexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

/**
 * Group the workspace into selectable apps by top-level folder. Returns an
 * EMPTY array when the whole workspace is a single app (no selector needed);
 * otherwise one entry per distinct top-level app folder.
 */
export function detectAppGroups(files: WorkspaceFile[]): AppGroup[] {
  const topDirs = new Set<string>();
  for (const f of files) {
    const top = topSegment(f.path);
    if (top) topDirs.add(top);
  }
  const appDirs = [...topDirs].filter((d) => !PART_NAMES.has(d.toLowerCase()));
  // Only a genuine multi-app workspace (2+ distinct app folders) gets a selector.
  // 0–1 app folders → treat the whole workspace as one app and run it as-is.
  if (appDirs.length < 2) return [];
  return appDirs.sort((a, b) => a.localeCompare(b)).map((d) => ({ root: d, name: d }));
}

/**
 * Scope the workspace to one app, re-rooted so the app's files sit at the top
 * (e.g. `todo/package.json` -> `package.json`). An empty root returns every
 * file unchanged (single-app workspace).
 */
export function filesForApp(files: WorkspaceFile[], root: string): WorkspaceFile[] {
  if (!root) return files;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
}

/**
 * Resolve which app root to act on: the stored selection if it still exists,
 * else the first group, else "" (the whole workspace).
 */
export function resolveAppRoot(groups: AppGroup[], selected: string | null): string {
  if (selected && groups.some((g) => g.root === selected)) return selected;
  return groups[0]?.root ?? "";
}
