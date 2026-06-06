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

/** Depth used for ordering ("" = root = 0, "a" = 1, "a/b" = 2). */
function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

/** A dir plus all of its ancestor dirs, excluding root ("a/b" -> ["a","a/b"]). */
function ancestorsOf(dir: string): string[] {
  if (!dir) return [];
  const segs = dir.split("/");
  return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}

/**
 * List the selectable folders for preview/deploy: every package.json folder AND
 * its parent app folders (so a `flickr-clone/` with `frontend`+`backend`
 * subfolders offers flickr-clone, flickr-clone/frontend, flickr-clone/backend),
 * plus a "Whole project" root option when the workspace holds several apps.
 * Returns [] when there's a single obvious target (no dropdown needed).
 */
export function detectAppGroups(files: WorkspaceFile[]): AppGroup[] {
  const pkgDirs = new Set<string>();
  for (const f of files) {
    if (f.path === "package.json" || f.path.endsWith("/package.json")) pkgDirs.add(dirOf(f.path));
  }
  if (pkgDirs.size === 0) return [];

  const dirs = new Set<string>();
  const topSegments = new Set<string>();
  let hasRootPkg = false;
  for (const d of pkgDirs) {
    if (d === "") { hasRootPkg = true; continue; }
    for (const a of ancestorsOf(d)) dirs.add(a);
    topSegments.add(d.split("/")[0]);
  }
  // Offer the project root when apps span multiple top-level folders (or there's
  // a root package.json) — otherwise the single top folder IS the whole project.
  if (hasRootPkg || topSegments.size >= 2) dirs.add("");

  if (dirs.size < 2) return [];
  return [...dirs]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .map((d) => ({ root: d, name: d || "Whole project" }));
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
