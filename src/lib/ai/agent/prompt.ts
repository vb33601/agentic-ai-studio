/**
 * System + context prompts for the agentic edit loop. The model is told it is
 * EDITING an app that already builds and boots (the template), via the edit
 * tools, and is given the live file tree every turn — so it never reinvents
 * boilerplate, never forgets what exists, and never streams a giant blob.
 */
import type { Template } from "../templates/registry";
import type { VirtualFileSystem } from "./vfs";

export const AGENT_SYSTEM = `You are an expert full-stack engineer building an application by EDITING an existing project that already installs, builds and runs.

You change the project ONLY by calling the edit tools:
- write_file(path, content) — create a file or fully rewrite one (COMPLETE content, no placeholders).
- edit_file(path, oldString, newString) — replace an exact, unique substring.
- read_file(path) / list_files() — inspect the current project.
- delete_file(path) / rename_file(from, to) — restructure.

Rules:
- The project starts from a working template. KEEP it runnable at every step — do not remove its entry/config files unless you replace them with equivalents.
- Write COMPLETE, production-quality code. Never leave TODOs, placeholders, stubs, or "rest of the code here" comments.
- Implement EVERY feature the user asked for. Build small, focused files and wire them together (imports, routes, entry points).
- Do not invent imports to files you have not created — if a file imports a sibling, create that sibling.
- Prefer edit_file for small changes; use write_file for new files or large rewrites.
- When the app is complete and would build and run, stop calling tools and give a one-paragraph summary of what you built.
- Do NOT output code in markdown blocks — all code MUST go through the edit tools.`;

/** A short brief describing the chosen template + runtime so the model knows the
 *  conventions it is working within. */
export function templateBrief(template: Template): string {
  return [
    `# Project template: ${template.label}`,
    template.description,
    `Stack: ${template.stack}/${template.framework}. Dev: \`${template.runtime.dev}\`${
      template.runtime.build ? `, Build: \`${template.runtime.build}\`` : " (no build step)"
    }, serves on port ${template.runtime.port}.`,
  ].join("\n");
}

/** The current working tree, serialized for the prompt (dyad-style codebase
 *  context). Call each turn so the model always sees the real state. */
export function codebaseContext(vfs: VirtualFileSystem, maxBytes = 60_000): string {
  return `# Current project files\n\n${vfs.serialize(maxBytes)}`;
}

/** Build the full system prompt for a run: role + template brief + live tree. */
export function buildAgentSystem(template: Template, vfs: VirtualFileSystem, maxBytes = 60_000): string {
  return `${AGENT_SYSTEM}\n\n${templateBrief(template)}\n\n${codebaseContext(vfs, maxBytes)}`;
}
