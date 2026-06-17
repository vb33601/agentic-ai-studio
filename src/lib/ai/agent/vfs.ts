/**
 * VirtualFileSystem — the in-memory working tree the agentic edit loop mutates.
 *
 * Seeded from a template (a complete, runnable app), then evolved by the edit
 * tools (write/edit/delete/rename). It is the single source of truth for "what
 * the app currently is" — the loop serializes it into the prompt each turn (so
 * the model always knows every file), and the final snapshot is what we ship.
 *
 * Edits are EXACT-MATCH (opencode's model): an edit must match a unique substring
 * or it errors, so the model can't silently corrupt a file. Errors are returned
 * to the tool layer (not thrown out of the loop) so the model can self-correct.
 */

export interface VFile {
  path: string;
  content: string;
}

/** Thrown by edit() on a non-unique / missing match; caught by the tool layer. */
export class EditError extends Error {}

const normalize = (p: string): string =>
  p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();

export class VirtualFileSystem {
  private files = new Map<string, string>();
  /** Paths touched since construction (created/edited/renamed targets). */
  readonly changed = new Set<string>();
  /** Paths deleted since construction. */
  readonly deleted = new Set<string>();

  constructor(seed: Record<string, string> | VFile[] = {}) {
    const entries = Array.isArray(seed)
      ? seed.map((f) => [f.path, f.content] as const)
      : Object.entries(seed);
    for (const [p, c] of entries) this.files.set(normalize(p), c);
  }

  has(path: string): boolean {
    return this.files.has(normalize(path));
  }

  read(path: string): string | undefined {
    return this.files.get(normalize(path));
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  snapshot(): VFile[] {
    return this.paths().map((path) => ({ path, content: this.files.get(path)! }));
  }

  /** Create or overwrite a file with complete content. */
  write(path: string, content: string): void {
    const p = normalize(path);
    if (!p) throw new EditError("empty path");
    this.files.set(p, content);
    this.changed.add(p);
    this.deleted.delete(p);
  }

  /**
   * Replace an exact substring. Errors when `oldString` is absent or (without
   * replaceAll) matches more than once — forcing the model to give unique
   * context, exactly like opencode's edit tool.
   */
  edit(path: string, oldString: string, newString: string, replaceAll = false): number {
    const p = normalize(path);
    const cur = this.files.get(p);
    if (cur === undefined) throw new EditError(`file not found: ${p}`);
    if (oldString === newString) throw new EditError("oldString and newString are identical");
    const count = cur.split(oldString).length - 1;
    if (count === 0) throw new EditError("oldString not found — it must match the file exactly, including whitespace and indentation");
    if (count > 1 && !replaceAll) throw new EditError(`oldString matched ${count} times — add surrounding context to make it unique, or set replaceAll`);
    const next = replaceAll ? cur.split(oldString).join(newString) : cur.replace(oldString, newString);
    this.files.set(p, next);
    this.changed.add(p);
    return replaceAll ? count : 1;
  }

  remove(path: string): void {
    const p = normalize(path);
    if (!this.files.has(p)) throw new EditError(`file not found: ${p}`);
    this.files.delete(p);
    this.changed.delete(p);
    this.deleted.add(p);
  }

  rename(from: string, to: string): void {
    const f = normalize(from);
    const t = normalize(to);
    const content = this.files.get(f);
    if (content === undefined) throw new EditError(`file not found: ${f}`);
    if (!t) throw new EditError("empty target path");
    this.files.delete(f);
    this.files.set(t, content);
    this.deleted.add(f);
    this.changed.delete(f);
    this.changed.add(t);
  }

  /** Just the file paths, as an indented tree — cheap context for every turn. */
  treePaths(): string {
    return this.paths().map((p) => `  ${p}`).join("\n");
  }

  /**
   * Full codebase serialization (paths + contents) for the prompt — dyad's
   * `extractCodebase` analogue. `maxBytes` budgets large trees: files beyond the
   * budget are listed by path only so the model still knows they exist.
   */
  serialize(maxBytes = 60_000): string {
    const out: string[] = [];
    let used = 0;
    const omitted: string[] = [];
    for (const path of this.paths()) {
      const content = this.files.get(path)!;
      const block = `--- ${path} ---\n${content}\n`;
      if (used + block.length > maxBytes && used > 0) {
        omitted.push(path);
        continue;
      }
      out.push(block);
      used += block.length;
    }
    let s = out.join("\n");
    if (omitted.length) s += `\n(omitted for length — still present, read with read_file):\n${omitted.map((p) => `  ${p}`).join("\n")}\n`;
    return s;
  }
}
