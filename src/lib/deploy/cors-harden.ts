import type { RepoFile } from "./github";
import type { StackPlan } from "./dockerfile";

/**
 * Cross-stack CORS hardening for split frontend/backend deploys.
 *
 * When the frontend (Vercel) and backend (Fly/Render) live on different origins,
 * the browser makes cross-origin API calls. A backend with no CORS policy blocks
 * them all ("Access-Control-Allow-Origin: none → Failed to fetch") — login/
 * register die in the browser even though the API works via curl. The frontend
 * origin can't be known at backend-build time (the backend deploys first), so
 * every framework gets a reflect-any-origin policy, which (unlike a literal `*`)
 * stays valid alongside credentials.
 *
 * Each framework uses its OWN idiomatic mechanism — injected only when the app
 * has no CORS of its own. Frameworks without a safe, well-defined injection point
 * fall back to the same-origin Vercel proxy that frontend-prepare already adds.
 */

export interface CorsResult {
  files: RepoFile[];
  notes: string[];
}

export function hardenCors(plan: StackPlan, files: RepoFile[]): CorsResult {
  switch (plan.framework) {
    case "fastapi": return fastapiCors(files);
    case "flask": return flaskCors(files);
    case "django": return djangoCors(files);
    case "express": return expressCors(files);
    default: return { files, notes: [] }; // .NET handled in dotnet.ts; others use the Vercel proxy
  }
}

/** Replace the file at `path` (matched by predicate) with transformed content. */
function patch(files: RepoFile[], pred: (f: RepoFile) => boolean, fn: (c: string) => string): { files: RepoFile[]; changed: boolean } {
  let changed = false;
  const out = files.map((f) => {
    if (!pred(f)) return f;
    const c = fn(f.content);
    if (c !== f.content) changed = true;
    return c === f.content ? f : { path: f.path, content: c };
  });
  return { files: out, changed };
}

// --- FastAPI: app.add_middleware(CORSMiddleware, allow_origin_regex=".*", …) ---
function fastapiCors(files: RepoFile[]): CorsResult {
  if (files.some((f) => /\.py$/.test(f.path) && /CORSMiddleware/.test(f.content))) return { files, notes: [] };
  const { files: out, changed } = patch(
    files,
    (f) => /\.py$/.test(f.path) && /=\s*FastAPI\s*\(/.test(f.content),
    (c) => {
      const imp = "from fastapi.middleware.cors import CORSMiddleware\n";
      const withImp = c.includes(imp) ? c : imp + c;
      // Insert add_middleware right after the `<var> = FastAPI(...)` line.
      return withImp.replace(
        /^(\s*(\w+)\s*=\s*FastAPI\s*\([^\n]*\)\s*\n)/m,
        `$1$2.add_middleware(CORSMiddleware, allow_origin_regex=".*", allow_credentials=True, allow_methods=["*"], allow_headers=["*"])\n`,
      );
    },
  );
  return changed
    ? { files: out, notes: ["FastAPI: added CORSMiddleware (reflect-any-origin + credentials) so the split-deployed frontend can call the API."] }
    : { files, notes: [] };
}

// --- Flask: flask-cors CORS(app, …) + flask-cors in requirements ---
function flaskCors(files: RepoFile[]): CorsResult {
  if (files.some((f) => /\.py$/.test(f.path) && /flask_cors|CORS\s*\(/.test(f.content))) return { files, notes: [] };
  const { files: patched, changed } = patch(
    files,
    (f) => /\.py$/.test(f.path) && /=\s*Flask\s*\(/.test(f.content),
    (c) => {
      const imp = "from flask_cors import CORS\n";
      const withImp = c.includes(imp) ? c : imp + c;
      return withImp.replace(
        /^(\s*(\w+)\s*=\s*Flask\s*\([^\n]*\)\s*\n)/m,
        `$1CORS($2, supports_credentials=True)\n`,
      );
    },
  );
  if (!changed) return { files, notes: [] };
  // Ensure flask-cors is installed.
  const reqIdx = patched.findIndex((f) => f.path === "requirements.txt");
  let out = patched;
  if (reqIdx === -1) out = [...patched, { path: "requirements.txt", content: "flask-cors\n" }];
  else if (!/flask[-_]cors/i.test(patched[reqIdx].content)) {
    out = [...patched];
    out[reqIdx] = { path: "requirements.txt", content: patched[reqIdx].content.replace(/\s*$/, "\n") + "flask-cors\n" };
  }
  return { files: out, notes: ["Flask: enabled flask-cors CORS(app, supports_credentials=True) and added flask-cors to requirements so the frontend can call the API."] };
}

// --- Django: django-cors-headers (app + middleware at top + allow-all) ---
function djangoCors(files: RepoFile[]): CorsResult {
  const sIdx = files.findIndex((f) => /settings\.py$/.test(f.path) && /INSTALLED_APPS/.test(f.content) && /MIDDLEWARE/.test(f.content));
  if (sIdx === -1) return { files, notes: [] };
  let s = files[sIdx].content;
  if (/corsheaders/.test(s)) return { files, notes: [] };

  s = s.replace(/(INSTALLED_APPS\s*=\s*\[)/, `$1\n    "corsheaders",`);
  // CorsMiddleware must sit as high as possible — right after the opening bracket.
  s = s.replace(/(MIDDLEWARE\s*=\s*\[)/, `$1\n    "corsheaders.middleware.CorsMiddleware",`);
  s = s.replace(/\s*$/, "\n\nCORS_ALLOW_ALL_ORIGINS = True\nCORS_ALLOW_CREDENTIALS = True\n");

  const out = [...files];
  out[sIdx] = { path: files[sIdx].path, content: s };
  // Ensure the package is installed.
  const reqIdx = out.findIndex((f) => f.path === "requirements.txt");
  if (reqIdx === -1) out.push({ path: "requirements.txt", content: "django-cors-headers\n" });
  else if (!/django-cors-headers/.test(out[reqIdx].content)) {
    out[reqIdx] = { path: "requirements.txt", content: out[reqIdx].content.replace(/\s*$/, "\n") + "django-cors-headers\n" };
  }
  return { files: out, notes: ["Django: added django-cors-headers (CorsMiddleware + CORS_ALLOW_ALL_ORIGINS) so the frontend can call the API."] };
}

// --- Express: cors() middleware + cors in package.json ---
function expressCors(files: RepoFile[]): CorsResult {
  if (files.some((f) => /\.([cm]?[jt]s)$/.test(f.path) && /require\(['"]cors['"]\)|from\s+['"]cors['"]/.test(f.content))) {
    return { files, notes: [] };
  }
  const { files: patched, changed } = patch(
    files,
    (f) => /\.([cm]?[jt]s)$/.test(f.path) && /=\s*express\s*\(\s*\)/.test(f.content),
    (c) => {
      const esm = /\bimport\s+express\b/.test(c);
      const imp = esm ? "import cors from 'cors';\n" : "const cors = require('cors');\n";
      const withImp = c.includes("'cors'") ? c : imp + c;
      // app.use(cors(...)) right after `const app = express()`.
      return withImp.replace(
        /^(\s*(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(\s*\)\s*;?\s*\n)/m,
        `$1$2.use(cors({ origin: true, credentials: true }));\n`,
      );
    },
  );
  if (!changed) return { files, notes: [] };
  const pkgIdx = patched.findIndex((f) => f.path === "package.json");
  let out = patched;
  if (pkgIdx !== -1) {
    try {
      const pkg = JSON.parse(patched[pkgIdx].content);
      pkg.dependencies = { ...(pkg.dependencies || {}), cors: pkg.dependencies?.cors ?? "latest" };
      out = [...patched];
      out[pkgIdx] = { path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" };
    } catch { /* leave manifest as-is */ }
  }
  return { files: out, notes: ["Express: added cors() middleware (reflect-origin + credentials) and the cors dependency so the frontend can call the API."] };
}
