/**
 * Detect npm packages imported by source files, so we can install / declare any
 * that a generated package.json forgot — the cause of "Failed to resolve import"
 * in the WebContainer preview AND of failed Vercel builds.
 */

export interface SourceFile {
  path: string;
  content: string;
}

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "http", "https", "crypto", "stream", "util", "events", "url",
  "child_process", "buffer", "process", "assert", "zlib", "net", "tls", "dns", "querystring",
]);

/** Map an import specifier to its installable npm package name (or null). */
export function packageName(spec: string): string | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) return null;
  if (spec.startsWith("node:")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  const name = spec.split("/")[0];
  if (!name || NODE_BUILTINS.has(name)) return null;
  return name;
}

const IMPORT_RE = /(?:import[^'"]*?from\s*|import\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

/** Unique npm package names imported across all JS/TS source files. */
export function detectImportedPackages(files: SourceFile[]): string[] {
  const found = new Set<string>();
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.path)) continue;
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(f.content)) !== null) {
      const name = packageName(m[1]);
      if (name) found.add(name);
    }
  }
  return [...found];
}

/**
 * Return a copy of `files` whose package.json declares every imported package
 * (missing ones added to dependencies as "latest"). No-op if there is no
 * package.json or nothing is missing.
 */
export function augmentPackageJson(files: SourceFile[]): SourceFile[] {
  const idx = files.findIndex((f) => f.path === "package.json" || f.path.endsWith("/package.json"));
  if (idx === -1) return files;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(files[idx].content);
  } catch {
    return files;
  }
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const missing = detectImportedPackages(files).filter((p) => !declared.has(p));
  if (missing.length === 0) return files;
  pkg.dependencies = pkg.dependencies || {};
  for (const m of missing) pkg.dependencies[m] = "latest";
  const next = files.slice();
  next[idx] = { ...files[idx], content: JSON.stringify(pkg, null, 2) };
  return next;
}
