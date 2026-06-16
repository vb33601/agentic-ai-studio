/**
 * Persist a finished generated app to the LOCAL filesystem so it survives outside
 * the browser workspace and can be opened/run directly.
 *
 * Target dir: `GENERATED_APPS_DIR` if set, else `~/ai-platform-apps` when running
 * locally (NODE_ENV !== "production"). On a production/container host the disk is
 * ephemeral and not the user's machine, so it is skipped unless GENERATED_APPS_DIR
 * is explicitly provided. Never throws — a save failure can't break a generation.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Artifact } from "./prompt-pipeline";

function targetDir(): string | null {
  if (process.env.GENERATED_APPS_DIR) return process.env.GENERATED_APPS_DIR;
  if (process.env.NODE_ENV !== "production") return join(homedir(), "ai-platform-apps");
  return null;
}

/** The single top-level folder shared by every file, if any (e.g. "crm-app"). */
function commonTopFolder(artifacts: Artifact[]): string | null {
  const tops = new Set(artifacts.map((a) => a.path.split("/")[0]).filter(Boolean));
  return tops.size === 1 ? [...tops][0] : null;
}

/** Write the app's files under <dir>/<appFolder>/. Returns the path, or null. */
export function saveGeneratedApp(artifacts: Artifact[]): string | null {
  if (!artifacts.length) return null;
  const dir = targetDir();
  if (!dir) return null;
  try {
    const top = commonTopFolder(artifacts);
    // If all files already share a top folder, mirror their paths under <dir>.
    // Otherwise nest everything under a timestamped app folder so apps never mix.
    const appFolder = top ?? `app-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const root = top ? dir : join(dir, appFolder);
    for (const a of artifacts) {
      const full = join(root, a.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, a.content ?? "");
    }
    return join(dir, appFolder);
  } catch {
    return null; // local save is best-effort
  }
}
