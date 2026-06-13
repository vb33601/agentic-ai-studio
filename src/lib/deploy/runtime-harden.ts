import type { RepoFile } from "./github";
import type { StackPlan } from "./dockerfile";

/**
 * Cross-stack runtime readiness: make a generated app RUN, not just build.
 *
 * The dominant cause of "deploys green then 500s / crashes on first request" is
 * the same shape across every language: a dependency is USED in the code but
 * never declared in the manifest. The build/install step only fetches what the
 * manifest lists, so the missing package explodes at import/require time —
 *   Python   ModuleNotFoundError: No module named 'jwt'
 *   Node     Error: Cannot find module 'cors'
 *   Go       build: cannot find module providing package …
 *   Ruby     LoadError: cannot load such file -- jwt
 * — exactly the .NET "Unable to resolve service" class, one layer down.
 *
 * This pass reconciles imports against the manifest per stack and adds what's
 * missing. It is deliberately CONSERVATIVE: a wrong addition (a stdlib name, a
 * local module, a path alias) would break the very build we're protecting, so we
 * exclude standard-library modules, first-party/local modules, and relative/alias
 * imports, and map the well-known import≠package-name cases.
 */

export interface HardenResult {
  files: RepoFile[];
  dockerfile: string;
  notes: string[];
}

export function hardenRuntime(plan: StackPlan, files: RepoFile[], dockerfile: string): HardenResult {
  const notes: string[] = [];
  let out = files;
  let df = dockerfile;

  if (plan.stack === "python") {
    const r = reconcilePython(out);
    out = r.files;
    notes.push(...r.notes);
  } else if (plan.stack === "node" || plan.stack === "bun" || plan.stack === "deno") {
    const r = reconcileNode(out);
    out = r.files;
    notes.push(...r.notes);
  } else if (plan.stack === "ruby") {
    const r = reconcileRuby(out);
    out = r.files;
    notes.push(...r.notes);
  } else if (plan.stack === "go") {
    // Go's build fails on undeclared imports; `go mod tidy` resolves them from
    // source before the build, turning a hard failure into a self-heal.
    const r = ensureGoModTidy(df);
    df = r.dockerfile;
    notes.push(...r.notes);
  }

  return { files: out, dockerfile: df, notes };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/** Top-level standard-library modules — never add these to requirements. */
const PY_STDLIB = new Set(
  ("abc aifc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib imp importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder multiprocessing netrc nis nntplib numbers operator os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__ __main__")
    .split(" "),
);

/** import name → PyPI package name, for the cases where they differ. */
const PY_IMPORT_TO_PKG: Record<string, string> = {
  cv2: "opencv-python", PIL: "Pillow", sklearn: "scikit-learn", yaml: "PyYAML",
  bs4: "beautifulsoup4", jwt: "PyJWT", dotenv: "python-dotenv", dateutil: "python-dateutil",
  attr: "attrs", OpenSSL: "pyOpenSSL", serial: "pyserial", Crypto: "pycryptodome",
  psycopg2: "psycopg2-binary", MySQLdb: "mysqlclient", win32api: "pywin32", magic: "python-magic",
  docx: "python-docx", pptx: "python-pptx", fitz: "PyMuPDF", skimage: "scikit-image",
  slugify: "python-slugify", jose: "python-jose", multipart: "python-multipart", redis: "redis",
};

function reconcilePython(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const py = files.filter((f) => /\.py$/.test(f.path));
  if (py.length === 0) return { files, notes: [] };

  // First-party modules: top-level package dirs and root-level .py module names.
  const local = new Set<string>();
  for (const f of files) {
    const top = f.path.split("/")[0];
    if (/\.py$/.test(f.path) && !f.path.includes("/")) local.add(f.path.replace(/\.py$/, ""));
    if (f.path.endsWith("/__init__.py")) local.add(f.path.split("/")[0]);
    if (top && files.some((g) => g.path.startsWith(`${top}/`))) local.add(top);
  }

  const imported = new Set<string>();
  const importRe = /^[ \t]*(?:from\s+([.\w]+)|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/gm;
  for (const f of py) {
    for (const m of f.content.matchAll(importRe)) {
      const from = m[1];
      if (from) {
        if (from.startsWith(".")) continue; // relative import
        imported.add(from.split(".")[0]);
      }
      if (m[2]) for (const part of m[2].split(",")) imported.add(part.trim().split(".")[0].split(" ")[0]);
    }
  }

  const reqIdx = files.findIndex((f) => f.path === "requirements.txt");
  const existing = reqIdx === -1 ? "" : files[reqIdx].content;
  const declared = new Set(
    existing
      .split("\n")
      .map((l) => l.trim().split(/[<>=!~ ;\[]/)[0].toLowerCase().replace(/_/g, "-"))
      .filter(Boolean),
  );

  const toAdd: string[] = [];
  for (const mod of imported) {
    if (!mod || PY_STDLIB.has(mod) || local.has(mod)) continue;
    const pkg = PY_IMPORT_TO_PKG[mod] ?? mod;
    const norm = pkg.toLowerCase().replace(/_/g, "-");
    if (declared.has(norm) || declared.has(mod.toLowerCase().replace(/_/g, "-"))) continue;
    if (!toAdd.includes(pkg)) toAdd.push(pkg);
  }
  if (toAdd.length === 0) return { files, notes: [] };

  const block = (existing.replace(/\s*$/, "") + "\n" + toAdd.join("\n") + "\n").replace(/^\n/, "");
  const out = [...files];
  if (reqIdx === -1) out.push({ path: "requirements.txt", content: toAdd.join("\n") + "\n" });
  else out[reqIdx] = { path: "requirements.txt", content: block };
  return {
    files: out,
    notes: [`Python: added ${toAdd.length} missing dependency(ies) to requirements.txt (${toAdd.join(", ")}) — imported in code but undeclared (would crash with ModuleNotFoundError).`],
  };
}

// ---------------------------------------------------------------------------
// Node / Bun / Deno
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set(
  ("assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib")
    .split(" "),
);

function nodePkgName(spec: string): string | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null; // relative/absolute
  if (spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#")) return null; // path alias / subpath import
  if (spec.startsWith("node:")) return null;
  if (/^https?:|^npm:|^jsr:/.test(spec)) return null; // Deno URL/specifier imports resolve themselves
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (NODE_BUILTINS.has(name)) return null;
  return name;
}

function reconcileNode(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const pkgIdx = files.findIndex((f) => f.path === "package.json");
  if (pkgIdx === -1) return { files, notes: [] }; // no manifest (e.g. Deno) — nothing to reconcile
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(files[pkgIdx].content);
  } catch {
    return { files, notes: [] };
  }
  const declared = new Set(
    Object.keys({
      ...((pkg.dependencies as Record<string, string>) || {}),
      ...((pkg.devDependencies as Record<string, string>) || {}),
      ...((pkg.peerDependencies as Record<string, string>) || {}),
      ...((pkg.optionalDependencies as Record<string, string>) || {}),
    }),
  );

  const SRC = /\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/;
  const IMPORT = /(?:import\s+(?:[\w*${},\s]+\s+from\s+)?|export\s+[\w*{},\s]+\s+from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;
  const used = new Set<string>();
  for (const f of files) {
    if (!SRC.test(f.path)) continue;
    for (const m of f.content.matchAll(IMPORT)) {
      const name = nodePkgName(m[1]);
      if (name) used.add(name);
    }
  }

  const toAdd = [...used].filter((n) => !declared.has(n) && !n.startsWith("@types/"));
  if (toAdd.length === 0) return { files, notes: [] };

  const deps = { ...((pkg.dependencies as Record<string, string>) || {}) };
  for (const n of toAdd) deps[n] = "latest";
  pkg.dependencies = Object.fromEntries(Object.entries(deps).sort());
  const out = [...files];
  out[pkgIdx] = { path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" };
  return {
    files: out,
    notes: [`Node: added ${toAdd.length} missing dependency(ies) to package.json (${toAdd.join(", ")}) — imported but undeclared (would crash with "Cannot find module").`],
  };
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

const RUBY_STDLIB = new Set(
  ("json yaml csv set date time uri net base64 digest openssl securerandom logger fileutils pathname tempfile stringio erb cgi singleton forwardable ostruct benchmark socket timeout thread monitor pp pstore zlib English")
    .split(" "),
);

function reconcileRuby(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const gemIdx = files.findIndex((f) => f.path === "Gemfile");
  if (gemIdx === -1) return { files, notes: [] };
  const declared = new Set(
    [...files[gemIdx].content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]),
  );
  const used = new Set<string>();
  for (const f of files) {
    if (!/\.(rb|ru)$/.test(f.path)) continue;
    for (const m of f.content.matchAll(/^\s*require\s+["']([^"'\/]+)["']/gm)) {
      const name = m[1];
      if (!RUBY_STDLIB.has(name)) used.add(name);
    }
  }
  // Only add requires that look like gems (avoid local requires, which use require_relative).
  const toAdd = [...used].filter((n) => !declared.has(n) && !/^(application|config|boot|environment)$/.test(n));
  if (toAdd.length === 0) return { files, notes: [] };
  const block = files[gemIdx].content.replace(/\s*$/, "\n") + toAdd.map((g) => `gem "${g}"`).join("\n") + "\n";
  const out = [...files];
  out[gemIdx] = { path: "Gemfile", content: block };
  return {
    files: out,
    notes: [`Ruby: added ${toAdd.length} missing gem(s) to Gemfile (${toAdd.join(", ")}) — required but undeclared.`],
  };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function ensureGoModTidy(dockerfile: string): { dockerfile: string; notes: string[] } {
  if (/go mod tidy/.test(dockerfile)) return { dockerfile, notes: [] };
  // Run tidy after the source is copied so undeclared imports get resolved into
  // go.mod/go.sum before `go build`, instead of failing the build outright.
  const replaced = dockerfile.replace(
    /(\nRUN go mod download[^\n]*\n)/,
    "$1RUN go mod tidy 2>/dev/null || true\n",
  );
  if (replaced === dockerfile) return { dockerfile, notes: [] };
  return {
    dockerfile: replaced,
    notes: ["Go: added `go mod tidy` before build so imports missing from go.mod self-resolve instead of failing the build."],
  };
}
