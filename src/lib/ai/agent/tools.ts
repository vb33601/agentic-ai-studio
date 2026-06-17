/**
 * Edit tools bound to a VirtualFileSystem — the model's ONLY way to change the
 * app. Each is a discrete, addressable, individually-validated operation, so a
 * dropped stream loses at most ONE file (which the bounded loop re-attempts)
 * instead of corrupting the whole build. This is the structural replacement for
 * the old "stream the entire app as one blob" approach.
 *
 * Tool executors NEVER throw out of the loop: on a bad edit they return an
 * `{ error }` payload so the model sees the failure and self-corrects on the next
 * step (opencode's pattern).
 */
import { tool } from "ai";
import { z } from "zod";
import { VirtualFileSystem, EditError } from "./vfs";

export interface EditToolEvents {
  /** Fired after a successful mutation — drives per-file UI status in Phase 3. */
  onChange?: (op: "write" | "edit" | "delete" | "rename", path: string) => void;
}

const errMsg = (e: unknown) => (e instanceof EditError ? e.message : e instanceof Error ? e.message : String(e));

export function makeEditTools(vfs: VirtualFileSystem, events: EditToolEvents = {}) {
  const fire = events.onChange ?? (() => {});

  const write_file = tool({
    description:
      "Create a new file or completely overwrite an existing one with COMPLETE content. Always write the entire file — never partial snippets or placeholders. Use for new files or large rewrites.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the project root, e.g. src/components/Header.jsx"),
      content: z.string().describe("The COMPLETE file content."),
    }),
    execute: async ({ path, content }) => {
      try {
        vfs.write(path, content);
        fire("write", path);
        return { ok: true, path, bytes: content.length };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  });

  const edit_file = tool({
    description:
      "Make a targeted edit to an existing file by replacing an EXACT substring. `oldString` must match the file exactly (including whitespace) and be unique unless replaceAll is set. Prefer this over rewriting a whole file for small changes.",
    inputSchema: z.object({
      path: z.string().describe("File path to edit."),
      oldString: z.string().describe("Exact text to replace (must be unique in the file)."),
      newString: z.string().describe("Replacement text (must differ from oldString)."),
      replaceAll: z.boolean().optional().describe("Replace every occurrence (default false)."),
    }),
    execute: async ({ path, oldString, newString, replaceAll }) => {
      try {
        const n = vfs.edit(path, oldString, newString, replaceAll ?? false);
        fire("edit", path);
        return { ok: true, path, replacements: n };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  });

  const read_file = tool({
    description: "Read the current content of a file in the project. Use before editing if you are unsure of exact contents.",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      const content = vfs.read(path);
      return content === undefined ? { ok: false, error: `file not found: ${path}` } : { ok: true, path, content };
    },
  });

  const list_files = tool({
    description: "List every file path currently in the project.",
    inputSchema: z.object({}),
    execute: async () => ({ ok: true, files: vfs.paths() }),
  });

  const delete_file = tool({
    description: "Delete a file from the project.",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      try {
        vfs.remove(path);
        fire("delete", path);
        return { ok: true, path };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  });

  const rename_file = tool({
    description: "Rename or move a file, preserving its content.",
    inputSchema: z.object({ from: z.string(), to: z.string() }),
    execute: async ({ from, to }) => {
      try {
        vfs.rename(from, to);
        fire("rename", to);
        return { ok: true, from, to };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  });

  return { write_file, edit_file, read_file, list_files, delete_file, rename_file };
}

export type EditTools = ReturnType<typeof makeEditTools>;
