# syntax=docker/dockerfile:1
# Multi-stage build for the Next.js 16 (standalone) platform.
# Produces a small runtime image that runs `node server.js`.

# ---- deps: install full dependencies (incl. dev) for the build ----
FROM node:22-alpine AS deps
WORKDIR /app
# libc6-compat: glibc shim some native deps expect; openssl for Prisma.
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
# `npm install` (not `npm ci`): the lockfile drifted (optional native deps like
# @emnapi/* present in node_modules but missing from the lock), which `npm ci`
# rejects. install tolerates it and resolves a consistent tree.
RUN npm install --no-audit --no-fund

# ---- builder: generate Prisma client + build Next standalone output ----
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder DATABASE_URL so any Prisma client construction during the build
# succeeds. The real connection string is injected at runtime by the host.
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"

# Prisma v7 uses the "client" engine + driver adapter (no native query engine
# binary), so `generate` just emits the JS client.
RUN npx prisma generate
RUN npm run build

# ---- runner: minimal image that serves the standalone build ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache openssl \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001

# Static assets + the self-contained server (server.js + traced node_modules).
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
# Render injects PORT at runtime — default to 3000 for local/other hosts.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
