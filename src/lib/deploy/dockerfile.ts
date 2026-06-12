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
  | "node" | "python" | "go" | "rust" | "php" | "java" | "dotnet" | "ruby" | "elixir" | "cpp" | "static";

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
}

const FILE_LABELS: Record<Stack, string> = {
  node: "Node.js", python: "Python", go: "Go", rust: "Rust", php: "PHP",
  java: "Java", dotnet: ".NET", ruby: "Ruby", elixir: "Elixir", cpp: "C/C++", static: "Static site",
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
  if (has(files, /(^|\/)composer\.json$/) || has(files, /\.php$/)) return "php";
  // JVM family: Java, Kotlin, Scala, Groovy.
  if (has(files, /(^|\/)pom\.xml$/) || has(files, /(^|\/)build\.(gradle(\.kts)?|sbt)$/) || has(files, /\.(java|kt|kts|scala|groovy)$/)) return "java";
  if (has(files, /(^|\/)Gemfile$/) || has(files, /\.rb$/)) return "ruby";
  if (has(files, /(^|\/)requirements\.txt$/) || has(files, /(^|\/)pyproject\.toml$/) || has(files, /(^|\/)Pipfile$/) || has(files, /(^|\/)manage\.py$/) || has(files, /\.py$/)) return "python";
  if (has(files, /(^|\/)CMakeLists\.txt$/) || has(files, /\.(c|cc|cpp|cxx)$/)) return "cpp";
  if (has(files, /(^|\/)package\.json$/)) return "node";
  return "static";
}

/** All dependency-ish text for a language, lowercased, for cheap framework sniffing. */
function depsBlob(files: DockSourceFile[], pathRe: RegExp): string {
  return files.filter((f) => pathRe.test(f.path)).map((f) => f.content).join("\n").toLowerCase();
}

// ---------------------------------------------------------------------------
// Per-language framework planners. Each returns a partial StackPlan.
// ---------------------------------------------------------------------------

type Partial = Omit<StackPlan, "stack" | "label" | "dockerignore">;

function planPython(files: DockSourceFile[]): Partial {
  const reqs = depsBlob(files, /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/);
  const pyVersion = "3.12";
  const pip = "RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || (pip install --no-cache-dir . 2>/dev/null || true)";
  const needsDatabase = /psycopg|asyncpg|dj-database-url|databases\[|sqlalchemy|django|tortoise/.test(reqs);
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
      notes: [`FastAPI detected (ASGI app at ${mod}:app). If your app object isn't named "app", adjust the start command.`] };
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
      notes: [`Flask detected (${mod}:${varName}).`] };
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
  const needsDatabase = /\bpg\b|postgres|activerecord|sequel|mysql2/.test(gems);

  // Rails — config/application.rb or the rails gem.
  if (has(files, /(^|\/)config\/application\.rb$/) || /['"]rails['"]/.test(gems)) {
    const dockerfile = `# Rails app
FROM ruby:3.3-slim
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
FROM ruby:3.3-slim
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
FROM ruby:3.3-slim
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
  const needsDatabase = /pdo|postgres|pgsql|mysql|doctrine|eloquent|laravel/.test(composer);

  // Laravel — artisan present.
  if (has(files, /(^|\/)artisan$/) || /laravel\/framework/.test(composer)) {
    const dockerfile = `# Laravel app
FROM php:8.3-cli
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
FROM php:8.3-cli
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
FROM php:8.3-apache
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
  const isGradle = has(files, /(^|\/)build\.gradle(\.kts)?$/);
  const pom = depsBlob(files, /(^|\/)pom\.xml$/);
  const gradle = depsBlob(files, /(^|\/)build\.gradle(\.kts)?$/);
  const isSpring = /spring-boot/.test(pom + gradle);
  const needsDatabase = /postgresql|mysql|spring-data|jdbc|hibernate/.test(pom + gradle);

  const buildStage = isGradle
    ? `FROM gradle:8-jdk21 AS build
WORKDIR /src
COPY . .
RUN gradle bootJar -x test --no-daemon 2>/dev/null || gradle build -x test --no-daemon || true`
    : `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY . .
RUN mvn -q -DskipTests package`;

  const jarGlob = isGradle ? "build/libs/*.jar" : "target/*.jar";
  // Spring reads server.port; pass $PORT explicitly so it binds correctly.
  // (Plain string — ${PORT} is literal here and expanded by the shell at runtime.)
  const startArg = isSpring ? " --server.port=${PORT:-8080}" : "";
  const dockerfile = `# Java${isSpring ? " (Spring Boot)" : ""} app
${buildStage}
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/${jarGlob} /app/app.jar
EXPOSE 8080
CMD ["sh", "-c", "java -jar /app/app.jar${startArg}"]
`;
  return { framework: isSpring ? "spring" : "java", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: [isSpring ? "Spring Boot detected; server.port bound to $PORT." : "Java detected; ensure the app reads $PORT."] };
}

function planGo(files: DockSourceFile[]): Partial {
  const mod = depsBlob(files, /(^|\/)go\.(mod|sum)$/);
  const fw = /gin-gonic/.test(mod) ? "gin" : /labstack\/echo/.test(mod) ? "echo" : /gofiber/.test(mod) ? "fiber" : "go";
  const needsDatabase = /pgx|lib\/pq|gorm|database\/sql|sqlx/.test(mod);
  const dockerfile = `# Go app
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 go build -o /app/server ./... 2>/dev/null || CGO_ENABLED=0 go build -o /app/server .
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
  const name = cargo && /name\s*=\s*"([^"]+)"/.exec(cargo.content)?.[1];
  const needsDatabase = /sqlx|diesel|tokio-postgres|sea-orm/.test(cargo?.content?.toLowerCase() || "");
  const runBin = name ? `/usr/local/bin/${name}` : "sh -c 'exec $(ls /usr/local/bin/* | head -n1)'";
  const dockerfile = `# Rust app
FROM rust:1-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/${name || ""} /usr/local/bin/${name || "app"}
EXPOSE 8080
CMD ["${name ? runBin : "/usr/local/bin/app"}"]
`;
  return { framework: "rust", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false,
    notes: ["Rust release binary built. Ensure the app reads $PORT."] };
}

function planDotnet(files: DockSourceFile[]): Partial {
  const csproj = depsBlob(files, /\.csproj$/);
  const needsDatabase = /npgsql|entityframework|sqlclient|pomelo/.test(csproj);
  const dockerfile = `# .NET app
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
# ASP.NET reads ASPNETCORE_URLS; rebind to $PORT when the host injects one.
CMD ["sh", "-c", "export ASPNETCORE_URLS=http://+:\${PORT:-8080}; dotnet $(ls *.dll | head -n1)"]
`;
  return { framework: "aspnet", role: "backend", dockerfile, port: 8080, needsDatabase, runsMigrations: false, notes: [".NET detected; bound to $PORT via ASPNETCORE_URLS."] };
}

function planElixir(files: DockSourceFile[]): Partial {
  const mix = depsBlob(files, /(^|\/)mix\.exs$/);
  const isPhoenix = /phoenix/.test(mix);
  const needsDatabase = /postgrex|ecto/.test(mix);
  const dockerfile = `# Elixir${isPhoenix ? " (Phoenix)" : ""} app
FROM elixir:1.17-slim
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

function planCpp(files: DockSourceFile[]): Partial {
  const dockerfile = `# C/C++ app
FROM gcc:14 AS build
WORKDIR /src
COPY . .
RUN (test -f CMakeLists.txt && cmake -B build && cmake --build build && cp $(find build -maxdepth 2 -type f -executable | head -n1) /app) \\
 || g++ -O2 -o /app *.cpp *.cc 2>/dev/null || gcc -O2 -o /app *.c
FROM debian:bookworm-slim
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

  const dockerfile = `# Node.js app
FROM node:22-slim
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
RUN rm -f /etc/nginx/conf.d/default.conf && printf 'server { listen \${PORT}; root /usr/share/nginx/html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/templates/default.conf.template
EXPOSE 80
`;
  return { framework: "static", role: "static", dockerfile, port: 80, needsDatabase: false, runsMigrations: false, notes: [] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PLANNERS: Record<Stack, (f: DockSourceFile[]) => Partial> = {
  python: planPython, ruby: planRuby, php: planPhp, java: planJava, go: planGo,
  rust: planRust, dotnet: planDotnet, elixir: planElixir, cpp: planCpp, node: planNode, static: () => planStatic(),
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
