/**
 * Scaffold-tier executor — runs a stack's OFFICIAL generator (create-vite,
 * create-next-app, django-admin, dotnet new, rails new, cargo, …) inside the
 * sandbox and reads the produced project back as a file set. "100% working" is
 * certified by the official tool itself; the agentic edit loop then edits the
 * result into the requested app.
 *
 * The SandboxFactory is injectable, so this is unit-testable offline. Fail-open:
 * any error returns [] and the caller falls back to a seed/curated template.
 */
import type { SandboxFactory } from "@/lib/deploy/sandbox-verify";
import type { ScaffoldSpec } from "./matrix";
import type { VFile } from "../agent/vfs";

// Delimiters used by the read-back dump (kept unlikely to collide with source).
const F = "===AIP_FILE::";
const E = "===AIP_ENDFILE===";

/** Shell that dumps every text source file under the scaffold dir, path-tagged. */
function dumpScript(dir: string): string {
  return (
    `cd ${dir} 2>/dev/null && ` +
    `find . -type f ` +
    `-not -path './node_modules/*' -not -path './.git/*' -not -path './target/*' ` +
    `-not -path './build/*' -not -path './dist/*' -not -path './.next/*' -not -path './vendor/*' ` +
    `-not -path '*/__pycache__/*' -size -262144c -print0 | ` +
    `while IFS= read -r -d '' f; do echo "${F}\${f#./}"; cat "$f"; echo ""; echo "${E}"; done`
  );
}

/** Parse the path-tagged dump back into files. */
export function parseProjectDump(stdout: string): VFile[] {
  const out: VFile[] = [];
  const parts = stdout.split(F).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl === -1) continue;
    const path = part.slice(0, nl).trim();
    let content = part.slice(nl + 1);
    const end = content.lastIndexOf(E);
    if (end !== -1) content = content.slice(0, end);
    // Trim the single trailing newline our `echo ""` added before the end marker.
    if (content.endsWith("\n")) content = content.slice(0, -1);
    if (path) out.push({ path, content });
  }
  return out;
}

export interface ScaffoldRunOpts {
  factory: SandboxFactory;
  /** Sandbox runtime image (default node24 — most generators are node/curl based). */
  runtime?: string;
  timeoutMs?: number;
  name?: string;
}

/**
 * Run a scaffold spec and return the produced files. The command's `{name}`
 * placeholder is substituted; the generator runs into a fresh subdir which is then
 * dumped back. Returns [] on any failure (caller falls back to a seed).
 */
export async function runScaffolder(spec: ScaffoldSpec, opts: ScaffoldRunOpts): Promise<VFile[]> {
  const name = opts.name || "app";
  const command = spec.command.replaceAll("{name}", name);
  const post = (spec.post || []).map((p) => p.replaceAll("{name}", name));
  const sb = await opts.factory({ runtime: opts.runtime || "node24", timeoutMs: opts.timeoutMs || 240_000 });
  try {
    const gen = await sb.run("sh", ["-c", `mkdir -p ${name} 2>/dev/null; ${command}`], { timeoutMs: opts.timeoutMs || 240_000 });
    if (gen.exitCode !== 0) return [];
    for (const p of post) {
      await sb.run("sh", ["-c", `cd ${name} && ${p}`], { timeoutMs: opts.timeoutMs || 240_000 }).catch(() => {});
    }
    const dump = await sb.run("sh", ["-c", dumpScript(name)], { timeoutMs: 60_000 });
    if (dump.exitCode !== 0) return [];
    return parseProjectDump(dump.stdout);
  } catch {
    return [];
  } finally {
    await sb.stop().catch(() => {});
  }
}
