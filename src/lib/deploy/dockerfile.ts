/**
 * Detect a project's language/runtime and generate a Dockerfile so ANY stack
 * (Node, Python, Go, Rust, PHP, Java, .NET, Ruby, C/C++, static) can be built
 * and run on any container platform (Docker, Railway, Render, Fly.io, etc.) —
 * not just Vercel. Pure functions, safe to use on the client (ZIP download).
 */

export type Stack =
  | "node" | "python" | "go" | "rust" | "php" | "java" | "dotnet" | "ruby" | "cpp" | "static";

export interface DockSourceFile {
  path: string;
  content: string;
}

const FILE_LABELS: Record<Stack, string> = {
  node: "Node.js", python: "Python", go: "Go", rust: "Rust", php: "PHP",
  java: "Java", dotnet: ".NET", ruby: "Ruby", cpp: "C/C++", static: "Static site",
};

export function stackLabel(s: Stack): string {
  return FILE_LABELS[s];
}

export function detectStack(files: DockSourceFile[]): Stack {
  const has = (re: RegExp) => files.some((f) => re.test(f.path));
  if (has(/\.csproj$/) || has(/\.sln$/) || has(/(^|\/)Program\.cs$/)) return "dotnet";
  if (has(/(^|\/)go\.mod$/) || has(/\.go$/)) return "go";
  if (has(/(^|\/)Cargo\.toml$/) || has(/\.rs$/)) return "rust";
  if (has(/(^|\/)composer\.json$/) || has(/\.php$/)) return "php";
  if (has(/(^|\/)pom\.xml$/) || has(/(^|\/)build\.gradle(\.kts)?$/) || has(/\.java$/)) return "java";
  if (has(/(^|\/)Gemfile$/) || has(/\.rb$/)) return "ruby";
  if (has(/(^|\/)requirements\.txt$/) || has(/(^|\/)pyproject\.toml$/) || has(/\.py$/)) return "python";
  if (has(/(^|\/)CMakeLists\.txt$/) || has(/(^|\/)Makefile$/) || has(/\.(c|cc|cpp|cxx|h|hpp)$/)) return "cpp";
  if (has(/(^|\/)package\.json$/)) return "node";
  return "static";
}

function nodeHasBuild(files: DockSourceFile[]): boolean {
  const pkg = files.find((f) => f.path === "package.json" || f.path.endsWith("/package.json"));
  if (!pkg) return false;
  try {
    return !!JSON.parse(pkg.content)?.scripts?.build;
  } catch {
    return false;
  }
}

const TEMPLATES: Record<Exclude<Stack, "node">, string> = {
  python: `# Python app
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* ./
RUN pip install --no-cache-dir -r requirements.txt || true
COPY . .
EXPOSE 8000
# Adjust to your entrypoint (gunicorn / uvicorn / flask / python app.py)
CMD ["sh", "-c", "python app.py || python main.py || (pip install gunicorn && gunicorn app:app -b 0.0.0.0:8000)"]
`,
  go: `# Go app
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN go mod download || true
RUN go build -o /app/server ./...
FROM alpine:3.20
COPY --from=build /app/server /server
EXPOSE 8080
CMD ["/server"]
`,
  rust: `# Rust app
FROM rust:1.79 AS build
WORKDIR /src
COPY . .
RUN cargo build --release
FROM debian:bookworm-slim
COPY --from=build /src/target/release/* /usr/local/bin/app
EXPOSE 8080
CMD ["app"]
`,
  php: `# PHP app
FROM php:8.3-apache
COPY . /var/www/html/
EXPOSE 80
`,
  java: `# Java app (Maven)
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY . .
RUN mvn -q package -DskipTests || gradle build -x test || true
FROM eclipse-temurin:21-jre
COPY --from=build /src/target/*.jar /app/app.jar
EXPOSE 8080
CMD ["java", "-jar", "/app/app.jar"]
`,
  dotnet: `# .NET app
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
CMD ["sh", "-c", "dotnet *.dll"]
`,
  ruby: `# Ruby app
FROM ruby:3.3-slim
WORKDIR /app
COPY Gemfile* ./
RUN bundle install || true
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "ruby app.rb || rails server -b 0.0.0.0 -p 3000"]
`,
  cpp: `# C/C++ app
FROM gcc:14 AS build
WORKDIR /src
COPY . .
RUN (cmake -B build && cmake --build build) || g++ -O2 -o /app *.cpp *.cc 2>/dev/null || g++ -O2 -o /app *.c
FROM debian:bookworm-slim
COPY --from=build /app /app
CMD ["/app"]
`,
  static: `# Static site
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`,
};

export function generateDockerfile(files: DockSourceFile[]): { stack: Stack; dockerfile: string } {
  const stack = detectStack(files);
  if (stack === "node") {
    const build = nodeHasBuild(files);
    const dockerfile = `# Node.js app
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
${build ? "RUN npm run build || true\n" : ""}EXPOSE 3000
# Adjust if your start command differs
CMD ["sh", "-c", "npm start || npm run dev || node index.js"]
`;
    return { stack, dockerfile };
  }
  return { stack, dockerfile: TEMPLATES[stack] };
}

/** A short deploy guide tailored to the detected stack. */
export function deployReadme(stack: Stack): string {
  return `# Deploying this app

Detected stack: **${FILE_LABELS[stack]}**

This project includes a \`Dockerfile\`, so you can run it on any container platform.

## Run locally with Docker
\`\`\`bash
docker build -t my-app .
docker run -p 8080:8080 my-app
\`\`\`

## Deploy to a host (any of these work)
- **Railway** — \`railway up\` (auto-detects the Dockerfile)
- **Render** — New > Web Service > "Docker" environment
- **Fly.io** — \`fly launch\` then \`fly deploy\`
- **Google Cloud Run / AWS App Runner / Azure Container Apps** — push the image and deploy

> Static sites and JS frameworks can also be deployed straight from the app's Deploy tab (Vercel).
> Backend servers (Python/Go/Java/.NET/PHP/Ruby/Rust) need a container host like the above — Vercel won't run them.
`;
}
