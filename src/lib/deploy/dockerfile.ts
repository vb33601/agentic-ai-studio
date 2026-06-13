/**
 * Universal, framework-aware build planner.
 *
 * Detects a project's language AND web framework, then emits a *correct,
 * production-ish* Dockerfile that binds to the platform's `$PORT` and runs the
 * right server (gunicorn/uvicorn/puma/java -jar/…) — not a guessed `app.py`.
 * The same Dockerfile runs on ANY container host (Render Docker runtime,
 * Railway, Fly.io, Cloud Run, Railway, plain Docker), so a single engine backs
 * every container-based deploy provider and the ZIP download.
 *
 * Pure functions over {path, content} — safe on client and server.
 *
 * Design notes:
 *  - Every web service must bind 0.0.0.0:$PORT (Render injects PORT=10000;
 *    Railway/Fly inject their own). Templates default a port when $PORT is unset
 *    so they also run locally.
 *  - DB migrations / static collection run at START (entrypoint), not build —
 *    the database isn't reachable at image-build time.
 *  - Build steps that are commonly flaky on generated code use `|| true` so a
 *    best-effort step never blocks an otherwise-deployable app.
 */

export type Stack =
  | "node" | "python" | "go" | "rust" | "php" | "java" | "dotnet" | "ruby" | "elixir" | "cpp" | "static"
  // JVM family (Kotlin/Scala/Groovy) is handled inside the "java" planner.
  | "deno" | "bun" | "swift" | "dart" | "haskell" | "clojure" | "crystal" | "nim" | "perl" | "r" | "julia" | "ocaml" | "zig"
  | "erlang" | "gleam" | "lua" | "d" | "vlang"
  | "raku" | "lisp" | "racket" | "pascal" | "tcl" | "ballerina" | "prolog" | "powershell" | "hack" | "ada" | "haxe";

/** What part of an app a project represents — drives provider routing. */
export type AppRole = "frontend" | "backend" | "fullstack" | "static";

export interface DockSourceFile {
  path: string;
  content: string;
}

export interface StackPlan {
  stack: Stack;
  /** Specific framework slug, e.g. "django", "fastapi", "rails", "spring", "express". */
  framework: string;
  label: string;
  role: AppRole;
  /** Full Dockerfile content, already bound to $PORT. */
  dockerfile: string;
  /** Recommended .dockerignore. */
  dockerignore: string;
  /** Port the container listens on when $PORT is unset (also EXPOSEd). */
  port: number;
  /** A relational DB driver was detected → deploy should wire DATABASE_URL. */
  needsDatabase: boolean;
  /** The container runs DB migrations on start. */
  runsMigrations: boolean;
  /** Non-fatal advisories to surface in the deploy log. */
  notes: string[];
  /**
   * Source files to REPLACE in the repo before deploy (path must match an input
   * file). Used to inject a guaranteed `/health` liveness route so post-deploy
   * verification is deterministic instead of inferring "up" from a tolerated 404.
   */
  sourcePatches?: DockSourceFile[];
}

/**
 * A guarded, idempotent `/health` -> 200 route appended to a Flask/FastAPI entry
 * module. Wrapped in try/except so it can NEVER break the app: if the app object
 * isn't named as detected, or registration fails for any reason, the original app
 * runs exactly as before (back to the tolerated-404 behavior). Skipped when the
 * marker is already present so re-preparing the same source doesn't stack blocks.
 */
const HEALTH_MARKER = "deploy liveness probe (auto-added";

function withFlaskHealth(entry: DockSourceFile, appVar: string): DockSourceFile {
  if (entry.content.includes(HEALTH_MARKER)) return entry;
  const snippet = `

# --- ${HEALTH_MARKER}; safe no-op if it can't register) ---
try:
    if "/health" not in {str(_r.rule) for _r in ${appVar}.url_map.iter_rules()}:
        @${appVar}.route("/health")
        def _deploy_health():
            return {"status": "ok"}, 200
except Exception:
    pass
`;
  return { path: entry.path, content: entry.content.replace(/\s*$/, "\n") + snippet };
}

function withFastapiHealth(entry: DockSourceFile, appVar: string): DockSourceFile {
  if (entry.content.includes(HEALTH_MARKER)) return entry;
  const snippet = `

# --- ${HEALTH_MARKER}; safe no-op if it can't register) ---
try:
    if not any(getattr(_r, "path", None) == "/health" for _r in ${appVar}.routes):
        ${appVar}.add_api_route("/health", lambda: {"status": "ok"}, methods=["GET"])
except Exception:
    pass
`;
  return { path: entry.path, content: entry.content.replace(/\s*$/, "\n") + snippet };
}

const FILE_LABELS: Record<Stack, string> = {
  node: "Node.js", python: "Python", go: "Go", rust: "Rust", php: "PHP",
  java: "Java", dotnet: ".NET", ruby: "Ruby", elixir: "Elixir", cpp: "C/C++", static: "Static site",
  deno: "Deno", bun: "Bun", swift: "Swift", dart: "Dart", haskell: "Haskell", clojure: "Clojure",
  crystal: "Crystal", nim: "Nim", perl: "Perl", r: "R", julia: "Julia", ocaml: "OCaml", zig: "Zig",
  erlang: "Erlang", gleam: "Gleam", lua: "Lua", d: "D", vlang: "V",
  raku: "Raku", lisp: "Common Lisp", racket: "Racket", pascal: "Pascal", tcl: "Tcl",
  ballerina: "Ballerina", prolog: "Prolog", powershell: "PowerShell", hack: "Hack", ada: "Ada", haxe: "Haxe",
};

export function stackLabel(s: Stack): string {
  return FILE_LABELS[s];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const has = (files: DockSourceFile[], re: RegExp) => files.some((f) => re.test(f.path));
const find = (files: DockSourceFile[], re: RegExp) => files.find((f) => re.test(f.path));
const anyContent = (files: DockSourceFile[], pathRe: RegExp, contentRe: RegExp) =>
  files.some((f) => pathRe.test(f.path) && contentRe.test(f.content));

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Module path → dotted Python module ("api/main.py" → "api.main"). */
function pyModule(path: string): string {
  return path.replace(/\.py$/, "").replace(/\//g, ".");
}

const DEFAULT_DOCKERIGNORE = `.git
node_modules
**/__pycache__
*.pyc
.venv
venv
target
.next
dist
build
.env
.env.*
*.log
.DS_Store
`;

// ---------------------------------------------------------------------------
// Language detection (broad strokes; framework detection refines within)
// ---------------------------------------------------------------------------

export function detectStack(files: DockSourceFile[]): Stack {
  // .NET family: C#, F#, VB.
  if (has(files, /\.(csproj|fsproj|vbproj)$/) || has(files, /\.sln$/) || has(files, /(^|\/)Program\.cs$/) || has(files, /\.(cs|fs|vb)$/)) return "dotnet";
  if (has(files, /(^|\/)mix\.exs$/) || has(files, /\.exs?$/)) return "elixir";
  if (has(files, /(^|\/)go\.mod$/) || has(files, /\.go$/)) return "go";
  if (has(files, /(^|\/)Cargo\.toml$/) || has(files, /\.rs$/)) return "rust";
  // Hack/HHVM before PHP: .hack/.hh sources, an .hhconfig, or PHP-syntax files with a <?hh header.
  if (has(files, /(^|\/)\.hhconfig$/) || has(files, /\.(hack|hh)$/) || anyContent(files, /\.php$/, /^\s*<\?hh\b/m)) return "hack";
  if (has(files, /(^|\/)composer\.json$/) || has(files, /\.php$/)) return "php";
  // JVM family: Java, Kotlin, Scala, Groovy.
  if (has(files, /(^|\/)pom\.xml$/) || has(files, /(^|\/)build\.(gradle(\.kts)?|sbt)$/) || has(files, /\.(java|kt|kts|scala|groovy)$/)) return "java";
  if (has(files, /(^|\/)Gemfile$/) || has(files, /\.rb$/)) return "ruby";
  if (has(files, /(^|\/)requirements\.txt$/) || has(files, /(^|\/)pyproject\.toml$/) || has(files, /(^|\/)Pipfile$/) || has(files, /(^|\/)manage\.py$/) || has(files, /\.py$/)) return "python";
  if (has(files, /(^|\/)CMakeLists\.txt$/) || has(files, /\.(c|cc|cpp|cxx)$/)) return "cpp";

  // --- Additional languages (config-file signals first; checked before the
  // generic package.json→node fallback so Deno/Bun aren't mis-detected as Node). ---
  if (has(files, /(^|\/)Package\.swift$/) || has(files, /\.swift$/)) return "swift";
  if (has(files, /(^|\/)pubspec\.(yaml|yml)$/) && (has(files, /(^|\/)bin\/.*\.dart$/) || has(files, /(^|\/)routes\//) || /dart_frog|shelf/.test(depsBlob(files, /(^|\/)pubspec\.(yaml|yml)$/)))) return "dart";
  if (has(files, /(\.cabal|(^|\/)(stack\.yaml|package\.yaml))$/) || has(files, /\.hs$/)) return "haskell";
  if (has(files, /(^|\/)(project\.clj|deps\.edn|build\.boot)$/) || has(files, /\.cljs?$/)) return "clojure";
  if (has(files, /(^|\/)shard\.(yml|yaml)$/) || has(files, /\.cr$/)) return "crystal";
  if (has(files, /\.nimble$/) || has(files, /\.nim$/)) return "nim";
  // Raku (Perl 6): distinct extensions/manifest — checked before Perl (which owns .pl/.pm).
  if (has(files, /(^|\/)META6\.json$/) || has(files, /\.(raku|rakumod|rakudoc|p6|pm6|pl6)$/)) return "raku";
  // Prolog: .pro/.plt, or .pl/.P carrying Prolog directives (guarded so Perl .pl scripts don't match).
  if (has(files, /\.(pro|plt)$/) || anyContent(files, /\.(pl|P)$/, /:-\s*(module|initialization|use_module|dynamic|discontiguous)\b|(^|\n)\s*:-\s/)) return "prolog";
  if (has(files, /(^|\/)(cpanfile|Makefile\.PL|cpanfile\.snapshot)$/) || has(files, /\.p[lm]$/) || has(files, /\.psgi$/)) return "perl";
  if (has(files, /(^|\/)(dune-project)$/) || has(files, /\.opam$/) || has(files, /\.mli?$/)) return "ocaml";
  if (has(files, /(^|\/)build\.zig$/) || has(files, /\.zig$/)) return "zig";
  if (has(files, /(^|\/)Project\.toml$/) || has(files, /\.jl$/)) return "julia";
  if (has(files, /(^|\/)(plumber\.R|DESCRIPTION|renv\.lock)$/i) || has(files, /\.[rR]$/)) return "r";
  // BEAM family: Gleam first (its build shipment also emits Erlang), then Erlang.
  if (has(files, /(^|\/)gleam\.toml$/) || has(files, /\.gleam$/)) return "gleam";
  if (has(files, /(^|\/)(rebar\.config|rebar\.lock|erlang\.mk)$/) || has(files, /\.app\.src$/) || has(files, /\.erl$/)) return "erlang";
  if (has(files, /\.rockspec$/) || has(files, /\.lua$/)) return "lua";
  // D: cpp is matched earlier, so a gcc `.d` depfile next to C/C++ never lands here.
  if (has(files, /(^|\/)dub\.(json|sdl)$/) || has(files, /\.d$/)) return "d";
  // V: `.v` is shared with Coq/Verilog, so require v.mod or a V-shaped source signal.
  if (has(files, /(^|\/)v\.mod$/) || anyContent(files, /\.v$/, /\bfn\s+main\b|import\s+veb\b|import\s+vweb\b/)) return "vlang";
  if (has(files, /(^|\/)Ballerina\.toml$/) || has(files, /\.bal$/)) return "ballerina";
  if (has(files, /(^|\/)info\.rkt$/) || has(files, /\.rkt$/)) return "racket";
  // Common Lisp: ASDF system defs / .lisp sources (Clojure's .clj* is matched earlier).
  if (has(files, /\.asd$/) || has(files, /\.lisp$/) || anyContent(files, /\.cl$/, /\(defpackage|\(defun|\(in-package/)) return "lisp";
  if (has(files, /(^|\/)alire\.toml$/) || has(files, /\.(gpr|adb|ads)$/)) return "ada";
  if (has(files, /\.(hx|hxml)$/) || has(files, /(^|\/)haxelib\.json$/)) return "haxe";
  if (has(files, /\.(ps1|psm1|psd1)$/)) return "powershell";
  if (has(files, /(^|\/)pkgIndex\.tcl$/) || has(files, /\.tcl$/)) return "tcl";
  // Free Pascal / Delphi (Object Pascal). `.pp` is also Puppet, but Puppet isn't a deploy stack.
  if (has(files, /\.(pas|pp|lpr|lpi|dpr|dproj)$/)) return "pascal";
  // Deno: explicit config, or TS that uses the Deno runtime/URL imports (no package.json).
  if (has(files, /(^|\/)deno\.(json|jsonc|lock)$/) ||
      (!has(files, /(^|\/)package\.json$/) && anyContent(files, /\.(ts|tsx|js)$/, /Deno\.|from\s+["']https?:\/\/deno\.land|["']jsr:|["']npm:/))) return "deno";
  // Bun: its lockfile/config sits next to a package.json — check before "node".
  if (has(files, /(^|\/)(bun\.lockb?|bunfig\.toml)$/)) return "bun";

  if (has(files, /(^|\/)package\.json$/)) return "node";
  return "static";
}

/** All dependency-ish text for a language, lowercased, for cheap framework sniffing. */
function depsBlob(files: DockSourceFile[], pathRe: RegExp): string {
  return files.filter((f) => pathRe.test(f.path)).map((f) => f.content).join("\n").toLowerCase();
}

/**
 * True when the app declares SQLite and NO server DB driver — it manages its own
 * embedded file database and must NOT have a managed Postgres wired into it. Wiring
 * one injects a Postgres connection string that an embedded-DB app feeds to its
 * SQLite driver and CRASHES at startup — proven for .NET:
 *   UseSqlite("Host=…;Port=5432;…") → ArgumentException: keyword 'host' not supported
 * → the process exits, the Fly/Render health check fails, and the deploy "fails".
 * The same trap hits Rails (sqlite3 gem, no pg) and any framework that consumes the
 * injected DATABASE_URL/connection string. (blob must be lowercased — depsBlob is.)
 */
function embeddedSqlite(blob: string): boolean {
  return /sqlite/.test(blob) &&
    !/npgsql|psycopg|asyncpg|pg8000|postgres|pgsql|mysql|mariadb|sqlclient|pomelo|cockroach|mssql|mongo/.test(blob);
}

/**
 * Resolve a runtime version from a project's conventional version files so the base
 * image MATCHES what the app targets. A hardcoded base image is the single biggest
 * build-failure cause across stacks (the same class as ".NET net9 app on sdk:8.0":
 * a Go 1.22 `go.mod` on golang:1.23 is fine, but a Java 17 app on JDK21, a Python
 * 3.11-only app on 3.12, or a Node-20-pinned native dep on node:22 all break). Returns
 * the first capture of the first matching source, or `fallback`. `allow`, when given,
 * restricts the result to known-good image tags (else `fallback`) — used where a
 * language's official images only exist for specific (LTS) versions.
 */
function pickVersion(
  files: DockSourceFile[],
  sources: Array<[path: RegExp, version: RegExp]>,
  fallback: string,
  allow?: string[],
): string {
  for (const [pathRe, verRe] of sources) {
    for (const f of files) {
      if (!pathRe.test(f.path)) continue;
      const m = verRe.exec(f.content);
      if (m?.[1]) return allow && !allow.includes(m[1]) ? fallback : m[1];
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Per-language framework planners. Each returns a partial StackPlan.
// ---------------------------------------------------------------------------

type Partial = Omit<StackPlan, "stack" | "label" | "dockerignore">;

function planPython(files: DockSourceFile[]): Partial {
  const reqs = depsBlob(files, /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/);
  const pyVersion = pickVersion(files, [
    [/(^|\/)runtime\.txt$/, /python-(\d+\.\d+)/i],
    [/(^|\/)\.python-version$/, /(\d+\.\d+)/],
    [/(^|\/)(pyproject\.toml|setup\.cfg)$/, /requires[-_]python\s*=?\s*["']?[>=~ ]*(\d+\.\d+)/i],
  ], "3.12");
  const pip = "RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || (pip install --no-cache-dir . 2>/dev/null || true)";
  const needsDatabase = /psycopg|asyncpg|dj-database-url|databases\[|sqlalchemy|django|tortoise/.test(reqs) && !embeddedSqlite(reqs);
  // The managed database we wire in is Postgres, but generated requirements often
  // omit the driver — so a Postgres DATABASE_URL crashes the app at boot (e.g.
  // SQLAlchemy's psycopg2 dialect → ModuleNotFoundError). Install psycopg2-binary
  // when a DB is used and no Postgres driver is already declared. (asyncpg apps
  // declare their own driver, so we skip those.)
  const pgDriver = needsDatabase && !/psycopg|asyncpg|pg8000/.test(reqs)
    ? "\nRUN pip install --no-cache-dir psycopg2-binary" : "";

  // Django — the project package is the dir containing wsgi.py / settings.py.
  if (has(files, /(^|\/)manage\.py$/) || /django/.test(reqs)) {
    const wsgi = find(files, /(^|\/)wsgi\.py$/) || find(files, /(^|\/)settings\.py$/) || find(files, /(^|\/)asgi\.py$/);
    const proj = wsgi ? dirOf(wsgi.path).split("/").pop() || "config" : "config";
    const dockerfile = `# Django app
FROM python:${pyVersion}-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements*.txt ./
${pip}${pgDriver}
RUN pip install --no-cache-dir gunicorn whitenoise
COPY . .
# collectstatic needs no DB; migrate runs at start once DATABASE_URL is reachable.
RUN python manage.py collectstatic --noinput 2>/dev/null || true
EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate --noinput || true; gunicorn ${proj}.wsgi:application --bind 0.0.0.0:\${PORT:-8000} --workers 3"]
`;
    return { framework: "django", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: true,
      notes: [`Django detected (project module "${proj}"). Migrations run on start; static files served via WhiteNoise. If DB env differs, set DATABASE_URL.`] };
  }

  // FastAPI — uvicorn on the module exposing `app`.
  if (/fastapi/.test(reqs) || anyContent(files, /\.py$/, /from\s+fastapi\s+import|FastAPI\(/)) {
    const entry = find(files, /(^|\/)(main|app|api|server)\.py$/) || find(files, /\.py$/);
    const mod = entry ? pyModule(entry.path) : "main";
    const dockerfile = `# FastAPI app
FROM python:${pyVersion}-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements*.txt ./
${pip}${pgDriver}
RUN pip install --no-cache-dir "uvicorn[standard]" gunicorn
COPY . .
EXPOSE 8000
CMD ["sh", "-c", "uvicorn ${mod}:app --host 0.0.0.0 --port \${PORT:-8000}"]
`;
    return { framework: "fastapi", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false,
      notes: [`FastAPI detected (ASGI app at ${mod}:app). If your app object isn't named "app", adjust the start command.`],
      sourcePatches: entry ? [withFastapiHealth(entry, "app")] : undefined };
  }

  // Flask — gunicorn on module:app.
  if (/flask/.test(reqs) || anyContent(files, /\.py$/, /from\s+flask\s+import|Flask\(__name__\)/)) {
    const entry = find(files, /(^|\/)(app|main|wsgi|server)\.py$/) || find(files, /\.py$/);
    const mod = entry ? pyModule(entry.path) : "app";
    const varName = entry && /(\w+)\s*=\s*Flask\(/.exec(entry.content)?.[1] || "app";
    const dockerfile = `# Flask app
FROM python:${pyVersion}-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements*.txt ./
${pip}${pgDriver}
RUN pip install --no-cache-dir gunicorn
COPY . .
EXPOSE 8000
CMD ["sh", "-c", "gunicorn ${mod}:${varName} --bind 0.0.0.0:\${PORT:-8000} --workers 3"]
`;
    return { framework: "flask", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false,
      notes: [`Flask detected (${mod}:${varName}).`],
      sourcePatches: entry ? [withFlaskHealth(entry, varName)] : undefined };
  }

  // Generic Python — run the obvious entrypoint.
  const entry = find(files, /(^|\/)(main|app|run|server|bot)\.py$/) || find(files, /\.py$/);
  const entryPath = entry?.path || "main.py";
  const dockerfile = `# Python app
FROM python:${pyVersion}-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements*.txt ./
${pip}${pgDriver}
COPY . .
EXPOSE 8000
CMD ["sh", "-c", "python ${entryPath}"]
`;
  return { framework: "python", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false,
    notes: [`Generic Python entrypoint ${entryPath}. If this is a web server, ensure it binds 0.0.0.0:$PORT.`] };
}

function planRuby(files: DockSourceFile[]): Partial {
  const gems = depsBlob(files, /(^|\/)Gemfile$/);
  const needsDatabase = /\bpg\b|postgres|activerecord|sequel|mysql2/.test(gems) && !embeddedSqlite(gems);
  const rb = pickVersion(files, [
    [/(^|\/)\.ruby-version$/, /(\d+\.\d+)/],
    [/(^|\/)Gemfile$/, /ruby\s+["'](\d+\.\d+)/],
  ], "3.3");

  // Rails — config/application.rb or the rails gem.
  if (has(files, /(^|\/)config\/application\.rb$/) || /['"]rails['"]/.test(gems)) {
    const dockerfile = `# Rails app
FROM ruby:${rb}-slim
ENV RAILS_ENV=production RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1 BUNDLE_WITHOUT=development:test
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential libpq-dev nodejs git && rm -rf /var/lib/apt/lists/*
COPY Gemfile* ./
RUN bundle install
COPY . .
# Precompile assets with a throwaway key; ignore if the app has no asset pipeline.
RUN SECRET_KEY_BASE=dummy bundle exec rails assets:precompile 2>/dev/null || true
EXPOSE 3000
CMD ["sh", "-c", "bundle exec rails db:prepare 2>/dev/null || true; bundle exec rails server -b 0.0.0.0 -p \${PORT:-3000}"]
`;
    return { framework: "rails", role: has(files, /(^|\/)app\/javascript\//) ? "fullstack" : "backend", dockerfile, port: 3000, needsDatabase, runsMigrations: true,
      notes: ["Rails detected. `db:prepare` runs migrations on start; set SECRET_KEY_BASE and DATABASE_URL in env."] };
  }

  // Sinatra / Rack.
  if (has(files, /(^|\/)config\.ru$/) || /sinatra/.test(gems)) {
    const dockerfile = `# Rack/Sinatra app
FROM ruby:${rb}-slim
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY Gemfile* ./
RUN bundle install
COPY . .
EXPOSE 9292
CMD ["sh", "-c", "bundle exec rackup -o 0.0.0.0 -p \${PORT:-9292}"]
`;
    return { framework: "sinatra", role: "backend", dockerfile, port: 9292, needsDatabase, runsMigrations: false, notes: ["Rack/Sinatra detected."] };
  }

  const entry = find(files, /(^|\/)(app|main|server)\.rb$/) || find(files, /\.rb$/);
  const dockerfile = `# Ruby app
FROM ruby:${rb}-slim
WORKDIR /app
COPY Gemfile* ./
RUN bundle install || true
COPY . .
CMD ["sh", "-c", "ruby ${entry?.path || "app.rb"}"]
`;
  return { framework: "ruby", role: "backend", dockerfile, port: 0, needsDatabase, runsMigrations: false, notes: [] };
}

function planPhp(files: DockSourceFile[]): Partial {
  const composer = depsBlob(files, /(^|\/)composer\.json$/);
  const needsDatabase = /pdo|postgres|pgsql|mysql|doctrine|eloquent|laravel/.test(composer) && !embeddedSqlite(composer);
  const php = pickVersion(files, [[/(^|\/)composer\.json$/, /"php"\s*:\s*"[^"]*?(\d+\.\d+)/]], "8.3");

  // Laravel — artisan present.
  if (has(files, /(^|\/)artisan$/) || /laravel\/framework/.test(composer)) {
    const dockerfile = `# Laravel app
FROM php:${php}-cli
RUN apt-get update && apt-get install -y --no-install-recommends git unzip libpq-dev libzip-dev \\
 && docker-php-ext-install pdo pdo_pgsql pdo_mysql zip bcmath \\
 && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY . .
RUN composer install --no-dev --optimize-autoloader --no-interaction || composer install --no-interaction || true
EXPOSE 8000
# Migrate (best effort) then serve. artisan serve is single-process but fine for app demos.
CMD ["sh", "-c", "php artisan migrate --force 2>/dev/null || true; php artisan config:cache 2>/dev/null || true; php -S 0.0.0.0:\${PORT:-8000} -t public public/index.php"]
`;
    return { framework: "laravel", role: has(files, /(^|\/)resources\/js\//) ? "fullstack" : "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: true,
      notes: ["Laravel detected. Set APP_KEY (php artisan key:generate) and DATABASE_URL/DB_* in env; migrations run on start."] };
  }

  // Symfony.
  if (/symfony\//.test(composer) || has(files, /(^|\/)bin\/console$/)) {
    const dockerfile = `# Symfony app
FROM php:${php}-cli
RUN apt-get update && apt-get install -y --no-install-recommends git unzip libpq-dev \\
 && docker-php-ext-install pdo pdo_pgsql && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY . .
RUN composer install --no-dev --optimize-autoloader --no-interaction || true
EXPOSE 8000
CMD ["sh", "-c", "php -S 0.0.0.0:\${PORT:-8000} -t public public/index.php"]
`;
    return { framework: "symfony", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false, notes: ["Symfony detected."] };
  }

  // Plain PHP — Apache serving the tree.
  const dockerfile = `# PHP app
FROM php:${php}-apache
RUN a2enmod rewrite
# Apache must listen on $PORT (Render/Railway inject it).
RUN sed -ri 's/^Listen 80$/Listen \${PORT:-80}/' /etc/apache2/ports.conf || true
ENV APACHE_RUN_DIR=/var/run/apache2
COPY . /var/www/html/
EXPOSE 80
CMD ["sh", "-c", "sed -ri \\"s/Listen 80/Listen \${PORT:-80}/\\" /etc/apache2/ports.conf; sed -ri \\"s/:80>/:\${PORT:-80}>/\\" /etc/apache2/sites-enabled/000-default.conf; apache2-foreground"]
`;
  return { framework: "php", role: "backend", dockerfile, port: 80, needsDatabase, runsMigrations: false, notes: ["Plain PHP served by Apache."] };
}

function planJava(files: DockSourceFile[]): Partial {
  // Scala via sbt: different build tool (sbt, not gradle/maven) and a fat jar.
  if (has(files, /(^|\/)build\.sbt$/)) {
    const sbtBlob = depsBlob(files, /(^|\/)(build\.sbt|project\/.+\.(sbt|scala|properties))$/);
    const needsDatabase = /postgres|slick|doobie|quill|jdbc|skunk/.test(sbtBlob) && !embeddedSqlite(sbtBlob);
    const dockerfile = `# Scala (sbt) app
FROM sbtscala/scala-sbt:eclipse-temurin-21.0.2_13_1.10.1_3.5.0 AS build
WORKDIR /src
COPY . .
# Prefer a fat jar (sbt-assembly); fall back to a packaged jar if assembly isn't set up.
RUN sbt -batch assembly 2>/dev/null || sbt -batch package
RUN cp "$(find target -name '*assembly*.jar' | head -n1)" /app.jar 2>/dev/null \\
 || cp "$(find target -name '*.jar' ! -name '*sources*' ! -name '*javadoc*' | head -n1)" /app.jar
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app.jar /app/app.jar
EXPOSE 8080
CMD ["sh", "-c", "java -jar /app/app.jar"]
`;
    return { framework: "scala", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
      notes: ["Scala/sbt detected; a fat jar (sbt-assembly) is preferred so deps are on the classpath. The app must read $PORT."] };
  }

  const isGradle = has(files, /(^|\/)build\.gradle(\.kts)?$/);
  const pom = depsBlob(files, /(^|\/)pom\.xml$/);
  const gradle = depsBlob(files, /(^|\/)build\.gradle(\.kts)?$/);
  const isSpring = /spring-boot/.test(pom + gradle);
  const needsDatabase = /postgresql|mysql|spring-data|jdbc|hibernate/.test(pom + gradle) && !embeddedSqlite(pom + gradle);
  // Build+run on the JDK the project targets. Clamp to LTS tags that exist across the
  // gradle/maven/temurin image families (a non-LTS like 22 has no gradle:8-jdk22).
  const javaVersion = pickVersion(files, [
    [/(^|\/)pom\.xml$/, /<(?:java\.version|maven\.compiler\.release|maven\.compiler\.target)>\s*(\d+)/],
    [/(^|\/)build\.gradle(\.kts)?$/, /JavaLanguageVersion\.of\((\d+)\)/],
    [/(^|\/)build\.gradle(\.kts)?$/, /VERSION_(\d+)/],
    [/(^|\/)build\.gradle(\.kts)?$/, /(?:source|target)Compatibility\s*=?\s*["']?(\d+)/],
  ], "21", ["11", "17", "21"]);

  const buildStage = isGradle
    ? `FROM gradle:8-jdk${javaVersion} AS build
WORKDIR /src
COPY . .
RUN gradle bootJar -x test --no-daemon 2>/dev/null || gradle build -x test --no-daemon || true`
    : `FROM maven:3.9-eclipse-temurin-${javaVersion} AS build
WORKDIR /src
COPY . .
RUN mvn -q -DskipTests package`;

  const jarGlob = isGradle ? "build/libs/*.jar" : "target/*.jar";
  // Spring reads server.port; pass $PORT explicitly so it binds correctly, and
  // server.address=:: so Tomcat listens on IPv6 dual-stack (it defaults to IPv4
  // 0.0.0.0, which Fly's IPv6 proxy can't reach — works on Render, empty reply on Fly).
  // (Plain string — ${PORT} is literal here and expanded by the shell at runtime.)
  const startArg = isSpring ? " --server.port=${PORT:-8080} --server.address=::" : "";
  const dockerfile = `# Java${isSpring ? " (Spring Boot)" : ""} app
${buildStage}
# Select the runnable jar. Prefer a fat/shadow jar (Kotlin/Ktor -all.jar, assembly);
# else the first jar that isn't Gradle's non-runnable <name>-plain.jar or sources/javadoc.
RUN jar="$(ls ${jarGlob} 2>/dev/null | grep -E -- '-(all|assembly|fat|shadow)\\.jar$' | head -n1)"; \\
    [ -n "$jar" ] || jar="$(ls ${jarGlob} 2>/dev/null | grep -vE -- '-(plain|sources|javadoc)\\.jar$' | head -n1)"; \\
    cp "$jar" /build-app.jar
FROM eclipse-temurin:${javaVersion}-jre
WORKDIR /app
COPY --from=build /build-app.jar /app/app.jar
EXPOSE 8080
CMD ["sh", "-c", "java -jar /app/app.jar${startArg}"]
`;
  return { framework: isSpring ? "spring" : "java", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [isSpring ? "Spring Boot detected; server.port=$PORT and server.address=:: (dual-stack for Fly)." : "Java detected; ensure the app reads $PORT."] };
}

function planGo(files: DockSourceFile[]): Partial {
  const mod = depsBlob(files, /(^|\/)go\.(mod|sum)$/);
  const fw = /gin-gonic/.test(mod) ? "gin" : /labstack\/echo/.test(mod) ? "echo" : /gofiber/.test(mod) ? "fiber" : "go";
  const needsDatabase = /pgx|lib\/pq|gorm|database\/sql|sqlx/.test(mod) && !embeddedSqlite(mod);
  // Build with the toolchain the module declares (`go 1.22`); newer modules won't
  // compile on an older SDK ("go.mod requires go >= 1.x").
  const goVersion = pickVersion(files, [[/(^|\/)go\.mod$/, /^go\s+(\d+\.\d+)/m]], "1.23");
  const dockerfile = `# Go app
FROM golang:${goVersion}-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download 2>/dev/null || true
COPY . .
# Build the main package wherever it lives: root first (the common case), then the
# first main package go-list finds (handles cmd/<app> layouts), then a last-resort
# whole-module build.
RUN CGO_ENABLED=0 go build -o /app/server . 2>/dev/null \\
 || CGO_ENABLED=0 go build -o /app/server "$(go list -f '{{if eq .Name "main"}}{{.Dir}}{{end}}' ./... 2>/dev/null | head -n1)" 2>/dev/null \\
 || CGO_ENABLED=0 go build -o /app/server ./...
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /app/server /server
EXPOSE 8080
CMD ["/server"]
`;
  return { framework: fw, role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Go binary built. The app must read the $PORT env var to bind correctly on the host."] };
}

function planRust(files: DockSourceFile[]): Partial {
  const cargo = files.find((f) => /(^|\/)Cargo\.toml$/.test(f.path));
  const cargoLc = cargo?.content?.toLowerCase() || "";
  const needsDatabase = /sqlx|diesel|tokio-postgres|sea-orm/.test(cargoLc) && !embeddedSqlite(cargoLc);
  // Honor a pinned toolchain (rust-toolchain.toml); default to the latest stable line.
  const rustVersion = pickVersion(files, [[/(^|\/)rust-toolchain(\.toml)?$/, /(?:channel\s*=\s*)?["']?(\d+\.\d+)/]], "1");
  const dockerfile = `# Rust app
FROM rust:${rustVersion}-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release
# Pick the compiled binary by inspecting the build output rather than guessing its
# name from Cargo.toml (handles renamed bins, [[bin]] targets, and workspaces).
RUN cp "$(find target/release -maxdepth 1 -type f -executable ! -name '*.d' | head -n1)" /build-bin
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /build-bin /usr/local/bin/app
EXPOSE 8080
CMD ["/usr/local/bin/app"]
`;
  return { framework: "rust", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Rust release binary built. Ensure the app reads $PORT."] };
}

function planDotnet(files: DockSourceFile[]): Partial {
  const csprojFiles = files.filter((f) => /\.csproj$/.test(f.path));
  const csproj = csprojFiles.map((f) => f.content).join("\n");
  const lc = csproj.toLowerCase();
  // A real SERVER driver, not bare "entityframework" — EF Core + Sqlite is the common
  // generated shape and must NOT get a managed Postgres wired (UseSqlite(<npgsql>) crash).
  const needsDatabase = /npgsql|sqlclient|pomelo|entityframeworkcore\.(postgresql|sqlserver|mysql)/.test(lc) && !embeddedSqlite(lc);

  // Match the SDK/runtime image tag to the project's TARGET FRAMEWORK. A net9.0/net10.0
  // app on a hardcoded sdk:8.0 image fails immediately at restore with NETSDK1045
  // ("The current .NET SDK does not support targeting .NET X"). Trust the declared TFM
  // (the matching mcr.microsoft.com/dotnet images exist per release); fall back to the
  // 8.0 LTS only when no <TargetFramework> is found.
  const ver = lc.match(/<targetframeworks?>\s*net(\d+\.\d+)/)?.[1] || "8.0";

  // Publish the WEB/entry project explicitly. A bare `dotnet publish` is ambiguous when
  // a solution holds multiple projects (MSB1011) and finds nothing when the project is
  // in a subdir (MSB1003); a class-library project would also publish a non-runnable
  // output. Prefer the Microsoft.NET.Sdk.Web project, else the first csproj.
  const webProj =
    csprojFiles.find((f) => /sdk\s*=\s*["']microsoft\.net\.sdk\.web["']/i.test(f.content)) ||
    csprojFiles[0];
  const projArg = webProj ? ` "${webProj.path}"` : "";

  // ASP.NET Core apps that bundle a JS SPA (SpaProxy/SpaServices: a ClientApp with a
  // package.json that `dotnet publish` builds via npm) need Node in the build image —
  // the dotnet SDK image ships none, so publish fails with "npm: command not found".
  // This is the classic ".NET + React deploy failed" cause. No-op for API-only projects.
  const hasSpa = has(files, /(^|\/)package\.json$/);
  const nodeSetup = hasSpa
    ? `# Node for the integrated SPA (npm install/build runs during dotnet publish).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \\
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
 && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*
`
    : "";
  const dockerfile = `# .NET app (net${ver})${hasSpa ? " + integrated SPA" : ""}
FROM mcr.microsoft.com/dotnet/sdk:${ver} AS build
${nodeSetup}WORKDIR /src
COPY . .
# Publish the web project explicitly so multi-project solutions and subdir layouts
# resolve their project references from the build context.
# NoWarn=NU1605 + TreatWarningsAsErrors=false keep the build alive through the
# NuGet version conflicts generated .csproj files routinely carry: a transitive
# dependency pins a package higher than a direct reference, which NuGet reports as
# the *error* NU1605 ("Detected package downgrade … Warning As Error") and aborts
# restore. Demoting it lets restore pick a coherent version and publish proceed —
# the single most common .NET deploy-build failure on generated code.
RUN dotnet publish${projArg} -c Release -o /app -p:NoWarn=NU1605 -p:TreatWarningsAsErrors=false
FROM mcr.microsoft.com/dotnet/aspnet:${ver}
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://[::]:8080
EXPOSE 8080
# ASP.NET reads ASPNETCORE_URLS; bind [::] (dual-stack — reachable on Fly's IPv6 proxy
# AND on Render/Railway) and rebind to $PORT when the host injects one. The entry
# assembly is the one with a <name>.runtimeconfig.json (publish also emits many
# dependency DLLs, so picking the first *.dll alphabetically runs the wrong one).
CMD ["sh", "-c", "export ASPNETCORE_URLS=http://[::]:\${PORT:-8080}; dll=$(ls *.runtimeconfig.json | head -n1); exec dotnet \\"\${dll%.runtimeconfig.json}.dll\\""]
`;
  return { framework: "aspnet", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [
      `.NET detected (target net${ver}); ASPNETCORE_URLS binds [::] on $PORT (dual-stack for Fly).`,
      ...(webProj && csprojFiles.length > 1 ? [`Publishing ${webProj.path} (the web project) of ${csprojFiles.length} projects.`] : []),
      ...(hasSpa ? ["Integrated SPA detected; Node installed in the build stage for the publish-time npm build."] : []),
    ] };
}

function planElixir(files: DockSourceFile[]): Partial {
  const mix = depsBlob(files, /(^|\/)mix\.exs$/);
  const isPhoenix = /phoenix/.test(mix);
  const needsDatabase = /postgrex|ecto/.test(mix) && !embeddedSqlite(mix);
  const elixirVersion = pickVersion(files, [
    [/(^|\/)\.tool-versions$/, /elixir\s+(\d+\.\d+)/],
    [/(^|\/)mix\.exs$/, /elixir:\s*["']\s*~?>?=?\s*(\d+\.\d+)/],
  ], "1.17");
  const dockerfile = `# Elixir${isPhoenix ? " (Phoenix)" : ""} app
FROM elixir:${elixirVersion}-slim
ENV MIX_ENV=prod
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git && rm -rf /var/lib/apt/lists/*
RUN mix local.hex --force && mix local.rebar --force
COPY . .
RUN mix deps.get --only prod && mix compile
${isPhoenix ? "RUN mix assets.deploy 2>/dev/null || true\n" : ""}EXPOSE 4000
CMD ["sh", "-c", "${isPhoenix ? "mix ecto.migrate 2>/dev/null || true; PORT=\\${PORT:-4000} mix phx.server" : "mix run --no-halt"}"]
`;
  return { framework: isPhoenix ? "phoenix" : "elixir", role: "backend", dockerfile, port: 4000, needsDatabase, runsMigrations: isPhoenix, notes: [isPhoenix ? "Phoenix detected; PORT honored." : "Elixir detected."] };
}

function planCpp(): Partial {
  const dockerfile = `# C/C++ app
FROM gcc:14 AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
COPY . .
# Prefer CMake; else compile the sources found via find (a bare *.cc/*.c glob would
# be passed literally to the compiler when nothing matches and break the build).
RUN if [ -f CMakeLists.txt ]; then \\
      cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build && \\
      cp "$(find build -maxdepth 3 -type f -executable ! -path '*/CMakeFiles/*' | head -n1)" /app; \\
    else \\
      src="$(find . -type f \\( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' \\))"; \\
      if [ -n "$src" ]; then g++ -O2 -o /app $src; \\
      else gcc -O2 -o /app $(find . -type f -name '*.c'); fi; \\
    fi
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
CMD ["/app"]
`;
  return { framework: "cpp", role: "backend", dockerfile, port: 0, needsDatabase: false, runsMigrations: false, notes: [] };
}

// ---------------------------------------------------------------------------
// Node (frontend / backend / fullstack)
// ---------------------------------------------------------------------------

function readPkg(files: DockSourceFile[]): { deps: Record<string, string>; scripts: Record<string, string> } {
  const pkg = files.find((f) => f.path === "package.json") || files.find((f) => f.path.endsWith("/package.json"));
  if (!pkg) return { deps: {}, scripts: {} };
  try {
    const p = JSON.parse(pkg.content);
    return { deps: { ...p.dependencies, ...p.devDependencies }, scripts: p.scripts || {} };
  } catch {
    return { deps: {}, scripts: {} };
  }
}

function planNode(files: DockSourceFile[]): Partial {
  const { deps, scripts } = readPkg(files);
  const d = (n: string) => n in deps;
  const isNext = d("next");
  const isServer = ["express", "fastify", "koa", "@nestjs/core", "hapi", "@hapi/hapi", "apollo-server"].some(d);
  const isFrontendFw = ["vite", "react-scripts", "@angular/core", "vue", "svelte", "@sveltejs/kit", "nuxt", "gatsby", "astro"].some(d);
  const hasBuild = !!scripts.build;
  const needsDatabase = ["pg", "mysql2", "@prisma/client", "prisma", "mongoose", "sequelize", "typeorm", "drizzle-orm"].some(d);

  const role: AppRole = isNext ? "fullstack" : isServer ? "backend" : isFrontendFw ? "frontend" : "backend";
  const start = scripts.start ? "npm start" : isNext ? "npm start" : "node index.js";
  // Match the Node major to .nvmrc/.node-version/engines.node (a native dep pinned to
  // an older line can fail to build on a newer default, and vice-versa).
  const nodeVersion = pickVersion(files, [
    [/(^|\/)\.nvmrc$/, /v?(\d{2})/],
    [/(^|\/)\.node-version$/, /v?(\d{2})/],
    [/(^|\/)package\.json$/, /"node"\s*:\s*"[^"]*?(\d{2})/],
  ], "22");

  const dockerfile = `# Node.js app
FROM node:${nodeVersion}-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install
COPY . .
${hasBuild ? "RUN npm run build || true\n" : ""}EXPOSE 3000
CMD ["sh", "-c", "${start}"]
`;
  return { framework: isNext ? "next" : isServer ? "express" : isFrontendFw ? "vite" : "node", role, dockerfile, port: 3000, needsDatabase, runsMigrations: false,
    notes: ["Node app. The server must read process.env.PORT to bind on the host."] };
}

function planStatic(): Partial {
  // Serve a static tree on $PORT. nginx:alpine auto-renders templates in
  // /etc/nginx/templates/*.template through envsubst on startup, so we drop a
  // template whose `listen` uses ${PORT} (defaulted in the env) and let the
  // stock entrypoint substitute and launch nginx.
  const dockerfile = `# Static site
FROM nginx:alpine
ENV PORT=80
COPY . /usr/share/nginx/html
RUN rm -f /etc/nginx/conf.d/default.conf && mkdir -p /etc/nginx/templates && printf 'server { listen \${PORT}; root /usr/share/nginx/html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/templates/default.conf.template
EXPOSE 80
`;
  return { framework: "static", role: "static", dockerfile, port: 80, needsDatabase: false, runsMigrations: false, notes: [] };
}

// ---------------------------------------------------------------------------
// Additional languages — researched canonical container setups. Each binds the
// host's $PORT (defaulting for local runs) and runs the framework's server.
// ---------------------------------------------------------------------------

function planDeno(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(^|\/)(deno\.jsonc?|import_map\.json)$/) + depsBlob(files, /\.ts$/);
  const needsDatabase = /postgres|deno-postgres|npm:pg|npm:postgres|neon|mysql|mongo/.test(blob);
  const entry = find(files, /(^|\/)(main|server|app|mod|index)\.(ts|tsx|js|mjs)$/) || find(files, /\.ts$/);
  const path = entry?.path || "main.ts";
  const dockerfile = `# Deno app
FROM denoland/deno:alpine
WORKDIR /app
COPY . .
RUN deno cache ${path} 2>/dev/null || true
EXPOSE 8000
# denoland/deno's ENTRYPOINT is \`deno\`, so CMD carries the subcommand. -A grants all
# perms (generated apps rarely ship a tight perm set); the app reads $PORT.
CMD ["run", "-A", "${path}"]
`;
  return { framework: "deno", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false,
    notes: [`Deno detected (entry ${path}). The server must read Deno.env.get("PORT") (Deno.serve defaults to 8000).`] };
}

function planBun(files: DockSourceFile[]): Partial {
  const { deps, scripts } = readPkg(files);
  const needsDatabase = ["pg", "postgres", "mysql2", "@prisma/client", "drizzle-orm", "mongoose"].some((n) => n in deps);
  const entry = find(files, /(^|\/)(index|server|app|main)\.(ts|tsx|js)$/);
  const cmd = scripts.start ? `["bun", "run", "start"]` : `["bun", "${entry?.path || "index.ts"}"]`;
  const dockerfile = `# Bun app
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN bun install || true
COPY . .
${scripts.build ? "RUN bun run build || true\n" : ""}EXPOSE 3000
CMD ${cmd}
`;
  return { framework: "bun", role: "backend", dockerfile, port: 3000, needsDatabase, runsMigrations: false,
    notes: ["Bun detected. The server must read process.env.PORT (Bun.serve defaults to 3000)."] };
}

function planSwift(files: DockSourceFile[]): Partial {
  const pkg = depsBlob(files, /(^|\/)Package\.(swift|resolved)$/);
  const isVapor = /vapor/.test(pkg);
  const needsDatabase = /postgres|fluent|mysql|mongo/.test(pkg);
  const run = isVapor
    ? `exec /app/app serve --env production --hostname 0.0.0.0 --port \${PORT:-8080}`
    : `exec /app/app`;
  const dockerfile = `# Swift app${isVapor ? " (Vapor)" : ""}
FROM swift:5.10 AS build
WORKDIR /src
COPY . .
RUN swift build -c release
# The product binary is the lone executable in .build/release (the rest are .swiftmodule,
# .build dirs, …), so select it by inspecting the output, not a hardcoded target name.
RUN cp "$(find .build/release -maxdepth 1 -type f -executable ! -name '*.*' | head -n1)" /build-bin
FROM swift:5.10-slim
WORKDIR /app
COPY --from=build /build-bin /app/app
EXPOSE 8080
CMD ["sh", "-c", "${run}"]
`;
  return { framework: isVapor ? "vapor" : "swift", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [isVapor ? "Vapor detected; serving on 0.0.0.0:$PORT." : "Server-side Swift detected; ensure the app reads $PORT."] };
}

function planDart(files: DockSourceFile[]): Partial {
  const pub = depsBlob(files, /(^|\/)pubspec\.(yaml|yml)$/);
  const isDartFrog = /dart_frog/.test(pub) || has(files, /(^|\/)routes\//);
  const needsDatabase = /postgres|mysql_client|mysql1|drift|mongo_dart/.test(pub);
  const build = isDartFrog
    ? `RUN dart pub global activate dart_frog_cli && dart pub get && dart_frog build && dart compile exe build/bin/server.dart -o /server`
    : `RUN dart pub get && dart compile exe bin/server.dart -o /server`;
  const dockerfile = `# Dart app${isDartFrog ? " (Dart Frog)" : ""}
FROM dart:stable AS build
WORKDIR /app
COPY . .
${build}
FROM scratch
COPY --from=build /runtime/ /
COPY --from=build /server /app/server
EXPOSE 8080
CMD ["/app/server"]
`;
  return { framework: isDartFrog ? "dart_frog" : "dart", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [isDartFrog ? "Dart Frog detected; reads PORT (default 8080)." : "Dart server detected (entry bin/server.dart); it must bind 0.0.0.0:$PORT."] };
}

function planHaskell(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(\.cabal|(^|\/)(package\.yaml|stack\.yaml))$/);
  const needsDatabase = /postgresql-simple|persistent|hasql|postgresql|beam-postgres|mysql/.test(blob);
  const build = has(files, /(^|\/)stack\.yaml$/)
    ? `RUN stack build --copy-bins --local-bin-path /out`
    : `RUN cabal update && cabal install --installdir=/out --install-method=copy`;
  const dockerfile = `# Haskell app
FROM haskell:9.6 AS build
WORKDIR /src
COPY . .
${build}
RUN cp "$(find /out -maxdepth 1 -type f -executable | head -n1)" /app-bin
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgmp10 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app-bin /usr/local/bin/app
EXPOSE 8080
CMD ["/usr/local/bin/app"]
`;
  return { framework: "haskell", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Haskell detected; the app must read the PORT env (e.g. Warp's getEnv \"PORT\")."] };
}

function planClojure(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(^|\/)(project\.clj|deps\.edn|build\.boot)$/);
  const needsDatabase = /postgres|next\.jdbc|org\.clojure\/java\.jdbc|hikari|honeysql|mysql/.test(blob);
  const build = has(files, /(^|\/)project\.clj$/)
    ? `RUN lein uberjar`
    : `RUN clojure -T:build uber 2>/dev/null || clojure -M:uberjar 2>/dev/null || clojure -X:uberjar`;
  const dockerfile = `# Clojure app
FROM clojure:temurin-21-tools-deps AS build
WORKDIR /src
COPY . .
${build}
# Prefer the standalone/uber jar (Leiningen also emits a non-runnable thin jar).
RUN cp "$(find . -name '*-standalone.jar' -o -name '*uber*.jar' | head -n1)" /app.jar 2>/dev/null \\
 || cp "$(find . -name '*.jar' ! -name '*sources*' | head -n1)" /app.jar
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app.jar /app/app.jar
EXPOSE 3000
CMD ["java", "-jar", "/app/app.jar"]
`;
  return { framework: "clojure", role: "backend", dockerfile, port: 3000, needsDatabase, runsMigrations: false,
    notes: ["Clojure detected; -main must read (System/getenv \"PORT\") and bind Jetty to host 0.0.0.0."] };
}

function planCrystal(files: DockSourceFile[]): Partial {
  const shard = depsBlob(files, /(^|\/)shard\.(yml|yaml)$/);
  const isKemal = /kemal/.test(shard);
  const needsDatabase = /crystal-pg|\bpg\b|postgres|mysql|granite|jennifer/.test(shard);
  const dockerfile = `# Crystal app${isKemal ? " (Kemal)" : ""}
FROM crystallang/crystal:latest-alpine AS build
WORKDIR /src
COPY . .
RUN shards install --production 2>/dev/null || true
# shards build emits to bin/; else compile the first src entrypoint statically.
RUN shards build --release --static 2>/dev/null || crystal build --release --static -o bin/app "$(ls src/*.cr | head -n1)"
RUN cp "$(find bin -maxdepth 1 -type f -perm -u+x | head -n1)" /app
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /app /app
EXPOSE 3000
CMD ["/app"]
`;
  return { framework: isKemal ? "kemal" : "crystal", role: "backend", dockerfile, port: 3000, needsDatabase, runsMigrations: false,
    notes: [isKemal ? "Kemal detected; set Kemal.config.host_binding=\"0.0.0.0\" and port from ENV[\"PORT\"]." : "Crystal detected; bind 0.0.0.0:$PORT."] };
}

function planNim(files: DockSourceFile[]): Partial {
  const nimble = depsBlob(files, /\.nimble$/);
  const isJester = /jester/.test(nimble);
  const needsDatabase = /db_postgres|postgres|allographer|norm|db_mysql/.test(nimble);
  const entry = find(files, /(^|\/)src\/[^/]+\.nim$/) || find(files, /[^/]+\.nim$/);
  const path = entry?.path || "src/main.nim";
  const dockerfile = `# Nim app${isJester ? " (Jester)" : ""}
FROM nimlang/nim:alpine AS build
WORKDIR /src
COPY . .
RUN nimble install -y --depsOnly 2>/dev/null || true
RUN nim c -d:release --opt:speed -o:/app ${path}
FROM alpine:3.20
RUN apk add --no-cache ca-certificates pcre
COPY --from=build /app /app
EXPOSE 5000
CMD ["/app"]
`;
  return { framework: isJester ? "jester" : "nim", role: "backend", dockerfile, port: 5000, needsDatabase, runsMigrations: false,
    notes: [isJester ? "Jester detected; read PORT via getEnv and set bindAddr=\"0.0.0.0\"." : "Nim detected; bind 0.0.0.0:$PORT."] };
}

function planPerl(files: DockSourceFile[]): Partial {
  const cpanfile = depsBlob(files, /(^|\/)cpanfile$/);
  const isMojo = /mojolicious/i.test(cpanfile) || anyContent(files, /\.p[lm]$/, /Mojolicious/);
  const isDancer = /dancer2?/i.test(cpanfile) || has(files, /\.psgi$/);
  const psgi = find(files, /\.psgi$/);
  const entry = find(files, /(^|\/)(app|script\/[^/]+|bin\/[^/]+)\.pl$/) || find(files, /\.pl$/);
  const path = entry?.path || "app.pl";
  const needsDatabase = /dbd::pg|dbix|postgres|mysql/i.test(cpanfile);
  const run = isMojo
    ? `exec perl ${path} daemon -l http://*:\${PORT:-3000}`
    : psgi
      ? `exec plackup -o 0.0.0.0 -p \${PORT:-3000} ${psgi.path}`
      : `exec perl ${path}`;
  const dockerfile = `# Perl app${isMojo ? " (Mojolicious)" : isDancer ? " (Dancer/PSGI)" : ""}
FROM perl:5.40
WORKDIR /app
COPY cpanfile* ./
RUN cpanm --installdeps --notest . 2>/dev/null || true
${psgi ? "RUN cpanm --notest Plack Starman 2>/dev/null || true\n" : ""}COPY . .
EXPOSE 3000
CMD ["sh", "-c", "${run}"]
`;
  return { framework: isMojo ? "mojolicious" : isDancer ? "dancer" : "perl", role: "backend", dockerfile, port: 3000, needsDatabase, runsMigrations: false,
    notes: ["Perl detected; the server binds 0.0.0.0:$PORT (Mojo: `daemon -l http://*:$PORT`)."] };
}

function planR(files: DockSourceFile[]): Partial {
  const entry = find(files, /(^|\/)(plumber|api|server|app)\.R$/i) || find(files, /\.R$/i);
  const path = entry?.path || "plumber.R";
  const needsDatabase = anyContent(files, /\.R$/i, /RPostgres|DBI|RMariaDB|pool/);
  const dockerfile = `# R (Plumber) app
FROM r-base:4.4.1
RUN R -e "install.packages('plumber', repos='https://cloud.r-project.org')"
# Install any extra packages the project pins via install.R.
RUN if [ -f install.R ]; then Rscript install.R; fi 2>/dev/null || true
WORKDIR /app
COPY . /app
EXPOSE 8000
# Bind to the host's $PORT (the stock rstudio/plumber image hardcodes 8000).
CMD ["sh", "-c", "R -e \\"plumber::pr_run(plumber::plumb('${path}'), host='0.0.0.0', port=as.integer(Sys.getenv('PORT','8000')))\\""]
`;
  return { framework: "plumber", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false,
    notes: [`R/Plumber detected (entry ${path}); served on 0.0.0.0:$PORT.`] };
}

function planJulia(files: DockSourceFile[]): Partial {
  const proj = depsBlob(files, /(^|\/)Project\.toml$/);
  const isGenie = /genie/i.test(proj);
  const needsDatabase = /libpq|postgres|mysql|sqlite|dbinterface/i.test(proj) && !embeddedSqlite(proj);
  const entry = find(files, /(^|\/)(app|main|server|bootstrap|routes)\.jl$/i) || find(files, /\.jl$/);
  const path = entry?.path || "app.jl";
  const dockerfile = `# Julia app${isGenie ? " (Genie)" : ""}
FROM julia:1.10
WORKDIR /app
COPY Project.toml Manifest.tom* ./
RUN julia -e "using Pkg; Pkg.activate(\\".\\"); Pkg.instantiate(); Pkg.precompile()"
COPY . .
ENV JULIA_PROJECT=@.
EXPOSE 8000
# Genie reads ENV["PORT"] and binds 0.0.0.0; generic Julia servers must do the same.
CMD ["sh", "-c", "julia --project=. ${path}"]
`;
  return { framework: isGenie ? "genie" : "julia", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false,
    notes: [`Julia detected (entry ${path}); the server must read ENV["PORT"] and host "0.0.0.0".`] };
}

function planOcaml(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(\.opam|(^|\/)dune-project)$/);
  const isDream = /dream/.test(blob);
  const needsDatabase = /caqti|postgres|pgx/.test(blob);
  const dockerfile = `# OCaml app${isDream ? " (Dream)" : ""}
FROM ocaml/opam:debian-ocaml-5.1 AS build
WORKDIR /src
COPY --chown=opam:opam . .
RUN opam install -y --deps-only . 2>/dev/null || true
RUN opam exec -- dune build --profile release
RUN cp "$(find _build/default -maxdepth 3 -type f -executable -name '*.exe' | head -n1)" /app 2>/dev/null \\
 || cp "$(find _build/default -maxdepth 3 -type f -executable ! -name '*.*' | head -n1)" /app
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libev4 libgmp10 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 8080
CMD ["/app"]
`;
  return { framework: isDream ? "dream" : "ocaml", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [isDream ? "Dream detected; pass ~port:(int_of_string (Sys.getenv \"PORT\"))." : "OCaml detected; the app must read $PORT."] };
}

function planZig(files: DockSourceFile[]): Partial {
  const needsDatabase = anyContent(files, /\.zig$/, /\bpg\b|postgres|pq/i);
  const dockerfile = `# Zig app
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates && rm -rf /var/lib/apt/lists/*
# Install a recent Zig toolchain (arch matches uname -m: x86_64 / aarch64).
RUN curl -fsSL https://ziglang.org/download/0.13.0/zig-linux-$(uname -m)-0.13.0.tar.xz | tar -xJ -C /opt \\
 && ln -s /opt/zig-linux-*/zig /usr/local/bin/zig
WORKDIR /src
COPY . .
RUN zig build -Doptimize=ReleaseFast
RUN cp "$(find zig-out/bin -maxdepth 1 -type f -executable | head -n1)" /app
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 8080
CMD ["/app"]
`;
  return { framework: "zig", role: "backend", dockerfile, port: 8080, needsDatabase: needsDatabase, runsMigrations: false,
    notes: ["Zig detected; the app must read the $PORT env and bind 0.0.0.0."] };
}

function planErlang(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(^|\/)(rebar\.config|.*\.app\.src)$/);
  const isCowboy = /cowboy/.test(blob);
  const needsDatabase = /epgsql|postgres|emysql|mysql|eredis/.test(blob);
  // rebar3 builds a self-contained prod release; the release name is unknown
  // generically, so the entrypoint discovers it under _build/prod/rel at runtime.
  const dockerfile = `# Erlang app${isCowboy ? " (Cowboy)" : ""}
FROM erlang:27 AS build
WORKDIR /src
COPY . .
RUN rebar3 as prod release
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 libncurses6 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/_build/prod/rel/ /app/rel/
EXPOSE 8080
# Boot the single generated release in the foreground; it must read os:getenv("PORT").
CMD ["sh", "-c", "REL=$(ls /app/rel | head -n1); exec \\"/app/rel/$REL/bin/$REL\\" foreground"]
`;
  return { framework: isCowboy ? "cowboy" : "erlang", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Erlang detected; rebar3 prod release runs in the foreground. The listener must read os:getenv(\"PORT\") and bind 0.0.0.0."] };
}

function planGleam(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(^|\/)gleam\.toml$/);
  const isMist = /\bmist\b/.test(blob);
  const isWisp = /\bwisp\b/.test(blob);
  const needsDatabase = /\bpog\b|gleam_pgo|postgres|gleam_sqlite|storail/.test(blob) && !embeddedSqlite(blob);
  // `gleam export erlang-shipment` produces a runnable bundle with entrypoint.sh.
  const dockerfile = `# Gleam app${isWisp ? " (Wisp)" : isMist ? " (Mist)" : ""}
FROM ghcr.io/gleam-lang/gleam:v1.6.1-erlang-alpine AS build
COPY . /build/
RUN cd /build && gleam export erlang-shipment
FROM erlang:27-alpine
RUN apk add --no-cache ca-certificates libstdc++ ncurses-libs openssl
COPY --from=build /build/build/erlang-shipment /app
WORKDIR /app
EXPOSE 8080
# The shipment's entrypoint runs the project's main; Mist must read PORT and bind 0.0.0.0.
CMD ["./entrypoint.sh", "run"]
`;
  return { framework: isWisp ? "wisp" : isMist ? "mist" : "gleam", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Gleam detected; built via `gleam export erlang-shipment`. The HTTP server (Mist/Wisp) must read the PORT env and bind 0.0.0.0."] };
}

function planLua(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /\.rockspec$/);
  const isLapis = /lapis/.test(blob) || has(files, /(^|\/)(config\.(lua|moon)|nginx\.conf\.etlua)$/) && anyContent(files, /\.(lua|moon)$/, /lapis/);
  const needsDatabase = /pgmoon|luasql|lua-resty-postgres|postgres|mysql/.test(blob);
  if (isLapis) {
    // Lapis runs on OpenResty (nginx + LuaJIT); `lapis server production` reads the port from config.
    const dockerfile = `# Lua app (Lapis / OpenResty)
FROM openresty/openresty:alpine
RUN apk add --no-cache gcc musl-dev openssl-dev luarocks \\
 && luarocks install lapis
WORKDIR /app
COPY . .
EXPOSE 8080
# Lapis reads the port from config.lua/config.moon ("production" env); bind to 0.0.0.0:$PORT there.
CMD ["sh", "-c", "lapis server production"]
`;
    return { framework: "lapis", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
      notes: ["Lapis detected; set the production port to $PORT and host 0.0.0.0 in config.lua/config.moon."] };
  }
  const entry = find(files, /(^|\/)(app|main|server|init)\.lua$/) || find(files, /\.lua$/);
  const path = entry?.path || "app.lua";
  const dockerfile = `# Lua app
FROM alpine:3.20
RUN apk add --no-cache lua5.4 lua5.4-dev luarocks5.4 build-base openssl-dev
WORKDIR /app
COPY . .
# Install rockspec deps if present (e.g. lua-http, copas).
RUN for r in *.rockspec; do [ -f "$r" ] && luarocks-5.4 install --only-deps "$r"; done 2>/dev/null || true
EXPOSE 8080
# The server must read os.getenv("PORT") and bind 0.0.0.0.
CMD ["sh", "-c", "exec lua5.4 ${path}"]
`;
  return { framework: "lua", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [`Lua detected (entry ${path}); the server must read os.getenv("PORT") and bind 0.0.0.0.`] };
}

function planD(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(^|\/)dub\.(json|sdl)$/);
  const isVibe = /vibe-d|vibe\.d|"vibe/.test(blob) || anyContent(files, /\.d$/, /import\s+vibe\./);
  const needsDatabase = /vibe-d:postgresql|dpq|ddbc|postgres|mysql-native/.test(blob);
  // Single stage on the ldc image so the Phobos/druntime shared libs are present at run time.
  const dockerfile = `# D app${isVibe ? " (vibe.d)" : ""}
FROM dlang2/ldc-ubuntu:latest
WORKDIR /app
COPY . .
RUN dub build --build=release --compiler=ldc2
EXPOSE 8080
# Run the produced binary (named after the dub package); vibe.d must listen on 0.0.0.0:$PORT.
CMD ["sh", "-c", "exec \\"$(find . -maxdepth 1 -type f -executable ! -name '*.*' | head -n1)\\""]
`;
  return { framework: isVibe ? "vibe.d" : "d", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["D detected; the server must read the PORT env and bind 0.0.0.0 (vibe.d: settings.bindAddresses/port)."] };
}

function planVlang(files: DockSourceFile[]): Partial {
  const isVeb = anyContent(files, /\.v$/, /import\s+veb\b|import\s+vweb\b/);
  const needsDatabase = anyContent(files, /\.v$/, /import\s+db\.(pg|mysql|sqlite)|\bpostgres\b/);
  const dockerfile = `# V app${isVeb ? " (veb/vweb)" : ""}
FROM thevlang/vlang:latest AS build
WORKDIR /src
COPY . .
RUN v -prod -o /app .
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 8080
# veb/vweb must read os.getenv("PORT") and bind to 0.0.0.0.
CMD ["/app"]
`;
  return { framework: isVeb ? "veb" : "v", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["V detected; the server must read os.getenv(\"PORT\") and bind 0.0.0.0."] };
}

function planRaku(files: DockSourceFile[]): Partial {
  const meta = depsBlob(files, /(^|\/)META6\.json$/);
  const isCro = /\bcro\b/.test(meta) || anyContent(files, /\.raku(mod)?$/, /use\s+Cro/);
  const needsDatabase = /db::pg|db-pg|postgres|db::mysql|red\b/.test(meta);
  const entry = find(files, /(^|\/)(service|server|app|main)\.raku$/) || find(files, /(^|\/)bin\/.*\.raku$/) || find(files, /\.raku$/);
  const path = entry?.path || "service.raku";
  const dockerfile = `# Raku app${isCro ? " (Cro)" : ""}
FROM rakudo-star:latest
WORKDIR /app
COPY . .
# Install declared deps from META6.json (zef ships in rakudo-star).
RUN zef install --deps-only . 2>/dev/null || true
EXPOSE 10000
# Cro reads host/port from %*ENV; bind 0.0.0.0 and honor the platform's PORT.
CMD ["sh", "-c", "exec raku ${path}"]
`;
  return { framework: isCro ? "cro" : "raku", role: "backend", dockerfile, port: 10000, needsDatabase, runsMigrations: false,
    notes: ["Raku detected; the Cro service must read its port from the env (e.g. %*ENV<PORT>) and bind 0.0.0.0."] };
}

function planLisp(files: DockSourceFile[]): Partial {
  const asd = depsBlob(files, /\.asd$/);
  const isClack = /clack|woo|hunchentoot|caveman|ningle/.test(asd) || anyContent(files, /\.lisp$/, /clack|hunchentoot/i);
  const needsDatabase = /postmodern|cl-dbi|mito|postgres|cl-postgres/.test(asd);
  const entry = find(files, /(^|\/)(run|start|server|main|app)\.lisp$/) || find(files, /\.lisp$/);
  const path = entry?.path || "run.lisp";
  const dockerfile = `# Common Lisp app${isClack ? " (Clack/Hunchentoot)" : ""}
FROM clfoundation/sbcl:latest
ENV QUICKLISP_ADD_TO_INIT_FILE=true
WORKDIR /app
COPY . .
# Quicklisp so the app's systems (Clack/Hunchentoot/Woo…) resolve at load time.
RUN install-quicklisp 2>/dev/null || true
EXPOSE 8080
# The entry script must start the server and read the PORT env (uiop:getenv "PORT"), bind 0.0.0.0.
CMD ["sh", "-c", "exec sbcl --non-interactive --load ${path}"]
`;
  return { framework: isClack ? "clack" : "lisp", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Common Lisp detected; the entry .lisp must start the web server, read (uiop:getenv \"PORT\"), and bind 0.0.0.0."] };
}

function planRacket(files: DockSourceFile[]): Partial {
  const isWebServer = anyContent(files, /\.rkt$/, /web-server|serve\/servlet|net\/http/);
  const needsDatabase = anyContent(files, /\.rkt$/, /\bdb\b|postgresql|require db/);
  const entry = find(files, /(^|\/)(main|server|app)\.rkt$/) || find(files, /\.rkt$/);
  const path = entry?.path || "main.rkt";
  const dockerfile = `# Racket app
FROM racket/racket:latest
WORKDIR /app
COPY . .
# Pull package deps if the project declares an info.rkt.
RUN if [ -f info.rkt ]; then raco pkg install --auto --batch --no-docs 2>/dev/null || true; fi
EXPOSE 8000
# The servlet must serve with #:listen-ip "0.0.0.0" and #:port (PORT).
CMD ["sh", "-c", "exec racket ${path}"]
`;
  return { framework: isWebServer ? "web-server" : "racket", role: "backend", dockerfile, port: 8000, needsDatabase, runsMigrations: false,
    notes: [`Racket detected (entry ${path}); serve with #:listen-ip "0.0.0.0" and #:port from the PORT env.`] };
}

function planPascal(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /\.(pas|pp|lpr|dpr)$/);
  const isBrook = /brook/i.test(blob);
  const needsDatabase = /sqldb|pqconnection|postgres|tpqconnection|zeos/i.test(blob);
  // Prefer a Lazarus/FPC program file (.lpr/.dpr), else a .pas/.pp containing `program`.
  const entry = find(files, /\.(lpr|dpr)$/) || files.find((f) => /\.(pas|pp)$/.test(f.path) && /\bprogram\b/i.test(f.content)) || find(files, /\.(pas|pp)$/);
  const path = entry?.path || "project.lpr";
  const dockerfile = `# Object Pascal app${isBrook ? " (Brook)" : " (fcl-web/fphttpserver)"}
FROM freepascal/fpc:latest AS build
WORKDIR /src
COPY . .
RUN fpc -O2 -o/app ${path}
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 8080
CMD ["/app"]
`;
  return { framework: isBrook ? "brook" : "fcl-web", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Pascal detected; the fphttpserver/Brook app must read the PORT env and bind 0.0.0.0."] };
}

function planTcl(files: DockSourceFile[]): Partial {
  const isWapp = has(files, /(^|\/)wapp\.tcl$/) || anyContent(files, /\.tcl$/, /\bwapp[- ]|package require wapp/);
  const needsDatabase = anyContent(files, /\.tcl$/, /package require (pgtcl|tdbc::postgres|mysqltcl)/i);
  const entry = find(files, /(^|\/)(app|server|main|web|start)\.tcl$/) || find(files, /\.tcl$/);
  const path = entry?.path || "app.tcl";
  const dockerfile = `# Tcl app${isWapp ? " (Wapp)" : " (tcllib httpd)"}
FROM tcl:latest
WORKDIR /app
COPY . .
EXPOSE 8080
# The server must read the PORT env (e.g. $env(PORT)) and bind 0.0.0.0.
CMD ["sh", "-c", "exec tclsh ${path}"]
`;
  return { framework: isWapp ? "wapp" : "tcl", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Tcl detected; the server must read the PORT env and bind 0.0.0.0."] };
}

function planBallerina(files: DockSourceFile[]): Partial {
  const blob = depsBlob(files, /(^|\/)(Ballerina|Dependencies)\.toml$/);
  const needsDatabase = /postgresql|mysql|jdbc|ballerinax\/(postgresql|mysql)/i.test(blob) || anyContent(files, /\.bal$/, /ballerinax\/(postgresql|mysql|java\.jdbc)/);
  const dockerfile = `# Ballerina app
FROM ballerina/ballerina:latest
WORKDIR /home/ballerina
COPY --chown=ballerina:ballerina . .
RUN bal build
EXPOSE 9090
# The http:Listener port comes from the service (default 9090) / Config.toml; expose $PORT there.
CMD ["sh", "-c", "exec bal run"]
`;
  return { framework: "ballerina", role: "backend", dockerfile, port: 9090, needsDatabase, runsMigrations: false,
    notes: ["Ballerina detected; set the http:Listener port to the platform's PORT (via Config.toml or a configurable) and bind 0.0.0.0."] };
}

function planProlog(files: DockSourceFile[]): Partial {
  const needsDatabase = anyContent(files, /\.(pl|pro|P)$/, /odbc|postgres|prosqlite|library\(persistency\)/i);
  const entry = find(files, /(^|\/)(server|app|main|run|http)\.(pl|pro|P)$/) || find(files, /\.(pl|pro|P)$/);
  const path = entry?.path || "server.pl";
  const dockerfile = `# SWI-Prolog app
FROM swipl:latest
WORKDIR /app
COPY . .
EXPOSE 8080
# The app must start http_server and bind the PORT env, e.g.
#   :- initialization(main). main :- getenv('PORT',P), ... http_server(http_dispatch,[port(P)]).
CMD ["sh", "-c", "exec swipl ${path}"]
`;
  return { framework: "swi-prolog", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Prolog detected; start http_server on the PORT env (getenv('PORT',P)) and keep the process alive (e.g. :- initialization(main))."] };
}

function planPowershell(files: DockSourceFile[]): Partial {
  const isPode = anyContent(files, /\.ps1$/, /Start-PodeServer|Add-PodeEndpoint|Import-Module Pode/i);
  const needsDatabase = anyContent(files, /\.ps1$/, /Npgsql|SimplySql|Invoke-SqlCmd|System\.Data/i);
  const entry = find(files, /(^|\/)(server|app|start|main)\.ps1$/) || find(files, /\.ps1$/);
  const path = entry?.path || "server.ps1";
  const dockerfile = `# PowerShell app${isPode ? " (Pode)" : ""}
FROM mcr.microsoft.com/powershell:latest
RUN pwsh -c "Install-Module Pode -Force -Scope AllUsers"
WORKDIR /app
COPY . .
EXPOSE 8080
# Pode: Add-PodeEndpoint -Address 0.0.0.0 -Port ($env:PORT ?? 8080) -Protocol Http
CMD ["pwsh", "-c", "./${path}"]
`;
  return { framework: isPode ? "pode" : "powershell", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["PowerShell detected; the Pode endpoint must bind 0.0.0.0 and the PORT env ($env:PORT)."] };
}

function planHack(files: DockSourceFile[]): Partial {
  const hasPublic = has(files, /(^|\/)public\/index\.php$/) || has(files, /(^|\/)public\/index\.hack$/);
  const root = hasPublic ? "/var/www/public" : "/var/www";
  const needsDatabase = anyContent(files, /\.(hack|hh|php)$/, /AsyncMysql|postgres|\bPDO\b/i);
  const dockerfile = `# Hack / HHVM app (Proxygen)
FROM hhvm/hhvm:latest
WORKDIR /var/www
COPY . /var/www
EXPOSE 8080
# HHVM's built-in Proxygen server, bound to the platform PORT.
CMD ["sh", "-c", "exec hhvm -m server -d hhvm.server.type=proxygen -d hhvm.server.ip=0.0.0.0 -d hhvm.server.port=\${PORT:-8080} -d hhvm.server.source_root=${root} -d hhvm.server.default_document=index.php"]
`;
  return { framework: "hhvm", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [`Hack detected; HHVM Proxygen serves ${root} on $PORT. Put web-facing files (index.php + assets) under that root.`] };
}

function planAda(files: DockSourceFile[]): Partial {
  const isAws = anyContent(files, /\.(adb|ads)$/, /\bAWS\.|with AWS/i) || /\baws\b/.test(depsBlob(files, /(^|\/)alire\.toml$/));
  const needsDatabase = /gnatcoll_postgres|postgres|gnade/i.test(depsBlob(files, /(^|\/)alire\.toml$/));
  const gpr = find(files, /\.gpr$/);
  const entry = find(files, /(^|\/)(main|server|app)\.adb$/) || find(files, /\.adb$/);
  const buildCmd = gpr ? `gprbuild -p -P "${gpr.path}"` : `gnatmake ${entry?.path || "main.adb"}`;
  const dockerfile = `# Ada app${isAws ? " (AWS — Ada Web Server)" : ""}
FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends gnat gprbuild libaws-dev ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN ${buildCmd}
EXPOSE 8080
# Run the built executable; the AWS server must read $PORT and listen on 0.0.0.0.
CMD ["sh", "-c", "exec \\"$(find . -maxdepth 3 -type f -executable ! -name '*.*' | head -n1)\\""]
`;
  return { framework: isAws ? "aws" : "ada", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Ada detected; the AWS server must read the PORT env and bind 0.0.0.0 (AWS.Server.Start with the configured port)."] };
}

function planHaxe(files: DockSourceFile[]): Partial {
  const hxml = depsBlob(files, /\.hxml$/);
  const isHashlink = /-hl\b/.test(hxml);
  const needsDatabase = anyContent(files, /\.hx$/, /sys\.db|postgres|Mysql/i);
  // Compile to Neko (bundled in the haxe image) unless the project's hxml drives the build.
  const buildCmd = has(files, /\.hxml$/)
    ? `haxe $(ls *.hxml | head -n1)`
    : `haxe -cp src -main Main -neko /app/app.n`;
  const dockerfile = `# Haxe app${isHashlink ? " (HashLink)" : " (Neko target)"}
FROM haxe:latest
WORKDIR /app
COPY . .
RUN ${buildCmd}
EXPOSE 8080
# Run the compiled output (Neko bytecode); the server must read the PORT env and bind 0.0.0.0.
CMD ["sh", "-c", "N=$(ls *.n 2>/dev/null | head -n1); exec neko \\"\${N:-app.n}\\""]
`;
  return { framework: isHashlink ? "hashlink" : "haxe", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Haxe detected; build targets Neko (bundled). The server must read the PORT env and bind 0.0.0.0; for a Node target, switch the base image + run command."] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PLANNERS: Record<Stack, (f: DockSourceFile[]) => Partial> = {
  python: planPython, ruby: planRuby, php: planPhp, java: planJava, go: planGo,
  rust: planRust, dotnet: planDotnet, elixir: planElixir, cpp: () => planCpp(), node: planNode, static: () => planStatic(),
  deno: planDeno, bun: planBun, swift: planSwift, dart: planDart, haskell: planHaskell,
  clojure: planClojure, crystal: planCrystal, nim: planNim, perl: planPerl, r: planR,
  julia: planJulia, ocaml: planOcaml, zig: planZig,
  erlang: planErlang, gleam: planGleam, lua: planLua, d: planD, vlang: planVlang,
  raku: planRaku, lisp: planLisp, racket: planRacket, pascal: planPascal, tcl: planTcl,
  ballerina: planBallerina, prolog: planProlog, powershell: planPowershell, hack: planHack,
  ada: planAda, haxe: planHaxe,
};

/** Detect language + framework and produce a full, $PORT-bound build plan. */
export function detectStackPlan(files: DockSourceFile[]): StackPlan {
  const stack = detectStack(files);
  const partial = PLANNERS[stack](files);
  return { stack, label: FILE_LABELS[stack], dockerignore: DEFAULT_DOCKERIGNORE, ...partial };
}

/** Back-compat: stack + Dockerfile (used by the ZIP download and older callers). */
export function generateDockerfile(files: DockSourceFile[]): { stack: Stack; dockerfile: string } {
  const plan = detectStackPlan(files);
  return { stack: plan.stack, dockerfile: plan.dockerfile };
}

/** A short, stack-tailored deploy guide bundled into the ZIP download. */
export function deployReadme(stack: Stack): string {
  return `# Deploying this app

Detected stack: **${FILE_LABELS[stack]}**

This project includes a \`Dockerfile\` that binds to \`$PORT\`, so it runs on any
container platform without changes.

## Run locally with Docker
\`\`\`bash
docker build -t my-app .
docker run -p 8080:8080 -e PORT=8080 my-app
\`\`\`

## One-click hosts
- **Render** — New > Web Service > Language: **Docker**
- **Railway** — \`railway up\` (auto-detects the Dockerfile or builds with Railpack)
- **Fly.io** — \`fly launch\` then \`fly deploy\`
- **Google Cloud Run / AWS App Runner / Azure Container Apps** — push the image and deploy

> JS frontends/static sites can also deploy straight to Vercel/Netlify from the Deploy tab.
> If your app uses a database, set \`DATABASE_URL\` (and any framework-specific keys) in the host's env.
`;
}
