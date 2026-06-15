/**
 * Database-URL adapter registry.
 *
 * The deploy pipeline wires ONE managed Postgres connection in as
 * `DATABASE_URL=postgresql://user:pass@host:port/db` (see `containerDatabaseUrl`).
 * Most stacks read that directly (Node/pg/Prisma, Python/SQLAlchemy/Django via
 * psycopg2, Go, Rails via `DATABASE_URL`). But some technologies need a different
 * KEY and/or a different connection-string SHAPE, and silently fail to connect
 * otherwise — the same class of bug as the JWT/`.data` mismatches: the value is
 * present but in a form the framework can't consume.
 *
 * This returns the EXTRA env vars a given backend framework needs (beyond
 * `DATABASE_URL`, which is always set too). Adding a technology = adding one
 * adapter here. Verified shapes per the official docs (Npgsql, Spring Boot).
 */

import { prisma } from "@/lib/prisma";

export interface DbEnvVar {
  key: string;
  value: string;
}

/**
 * A safe Postgres schema identifier derived from an app name. Container backends
 * share ONE managed database, so without isolation every app's tables land in
 * `public` and collide (App A's `users` overwrites App B's). Each app gets its
 * own schema named from its unique deploy name. Sanitized to [a-z0-9_], starts
 * with a letter, ≤63 chars (Postgres identifier limit).
 */
export function appSchemaName(appName: string): string {
  const s = appName.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "app";
  return (/^[a-z]/.test(s) ? s : `a_${s}`).slice(0, 63);
}

/** Create the app's schema if absent (best-effort; the URL still works if it fails
 *  because the app's ORM CREATEs tables and `public` is a fallback). Sanitized
 *  identifier, so the interpolation is injection-safe. */
export async function ensureAppSchema(schema: string): Promise<boolean> {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) return false;
  try {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    return true;
  } catch {
    return false;
  }
}

interface ParsedPg {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslmode: string | null;
}

/** Parse a `postgres(ql)://user:pass@host:port/db?sslmode=…` URL. */
export function parsePostgresUrl(url: string): ParsedPg | null {
  let u: URL;
  try {
    u = new URL(url.replace(/^postgres:\/\//, "postgresql://"));
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
  return {
    host: u.hostname,
    port: u.port || "5432",
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    sslmode: u.searchParams.get("sslmode"),
  };
}

// Postgres libpq sslmode -> Npgsql `SSL Mode` value.
const NPGSQL_SSL: Record<string, string> = {
  disable: "Disable", allow: "Allow", prefer: "Prefer",
  require: "Require", "verify-ca": "VerifyCA", "verify-full": "VerifyFull",
};

/**
 * .NET / Npgsql key-value connection string. Npgsql does NOT accept the
 * `postgresql://` URL form, so we translate. Managed Postgres (Aiven/Neon/…)
 * requires TLS but ships a CA the container image doesn't bundle, so we default
 * to `SSL Mode=Require;Trust Server Certificate=true` (handshake encrypts without
 * failing cert validation) unless the URL asked for stricter verification.
 */
export function npgsqlConnectionString(postgresUrl: string): string {
  const p = parsePostgresUrl(postgresUrl);
  if (!p) return "";
  const mode = p.sslmode ? NPGSQL_SSL[p.sslmode.toLowerCase()] ?? "Require" : "Require";
  const parts = [
    `Server=${p.host}`,
    `Port=${p.port}`,
    `Database=${p.database}`,
    `User Id=${p.user}`,
    `Password=${p.password}`,
    `SSL Mode=${mode}`,
  ];
  // Trust Server Certificate only matters for Require/Prefer; it's ignored by
  // VerifyCA/VerifyFull, so it's safe to always include.
  parts.push("Trust Server Certificate=true");
  return parts.join(";") + ";";
}

/**
 * Spring Boot reads SPRING_DATASOURCE_* with a JDBC URL (no userinfo inline).
 *
 * We also pin the DRIVER and DIALECT, not just the URL. Generated apps routinely
 * ship `spring.datasource.driver-class-name=org.h2.Driver` (+ H2Dialect) baked
 * into application.properties for local dev. Injecting only the Postgres URL
 * leaves that H2 driver in place, and HikariCP then dies at boot —
 * "Driver org.h2.Driver claims to not accept jdbcUrl, jdbc:postgresql://…" —
 * taking the whole context down. Environment variables outrank application.properties
 * in Spring's relaxed binding, so these override the baked-in H2 to the real
 * Postgres driver/dialect. (The driver must also be ON the classpath — the
 * `spring-datasource-postgres` hardening pass guarantees that in pom/gradle.)
 */
function springDatasource(postgresUrl: string, schema?: string): DbEnvVar[] {
  const p = parsePostgresUrl(postgresUrl);
  if (!p) return [];
  const url = `jdbc:postgresql://${p.host}:${p.port}/${p.database}` + (schema ? `?currentSchema=${schema}` : "");
  return [
    { key: "SPRING_DATASOURCE_URL", value: url },
    { key: "SPRING_DATASOURCE_USERNAME", value: p.user },
    { key: "SPRING_DATASOURCE_PASSWORD", value: p.password },
    { key: "SPRING_DATASOURCE_DRIVER_CLASS_NAME", value: "org.postgresql.Driver" },
    { key: "SPRING_JPA_DATABASE_PLATFORM", value: "org.hibernate.dialect.PostgreSQLDialect" },
  ];
}

/**
 * Laravel reads discrete DB_* vars (not a URL) and selects the driver by
 * DB_CONNECTION. Generated apps default that to `sqlite`, so the managed Postgres
 * is ignored unless we set the whole discrete set — DB_CONNECTION=pgsql first.
 */
function laravelDatasource(postgresUrl: string): DbEnvVar[] {
  const p = parsePostgresUrl(postgresUrl);
  if (!p) return [];
  return [
    { key: "DB_CONNECTION", value: "pgsql" },
    { key: "DB_HOST", value: p.host },
    { key: "DB_PORT", value: String(p.port) },
    { key: "DB_DATABASE", value: p.database },
    { key: "DB_USERNAME", value: p.user },
    { key: "DB_PASSWORD", value: p.password },
  ];
}

/**
 * Extra DB env vars for a detected backend framework. `DATABASE_URL` is always
 * set by the caller; this adds the framework-specific keys/shapes on top — and,
 * when `schema` is given, pins the connection to that schema (so the app is
 * isolated from others sharing the database).
 */
export function databaseEnvForFramework(framework: string, postgresUrl: string, schema?: string): DbEnvVar[] {
  switch (framework) {
    case "aspnet": {
      let cs = npgsqlConnectionString(postgresUrl);
      if (cs && schema) cs += `Search Path=${schema};`; // Npgsql honors "Search Path"
      // DefaultConnection is the .NET convention; also expose a couple of common
      // aliases so the generated app finds it regardless of the name it picked.
      return cs
        ? [
            { key: "ConnectionStrings__DefaultConnection", value: cs },
            { key: "ConnectionStrings__Default", value: cs },
            { key: "ConnectionStrings__Postgres", value: cs },
          ]
        : [];
    }
    case "spring":
      return springDatasource(postgresUrl, schema);
    case "laravel":
      return laravelDatasource(postgresUrl);
    default:
      return []; // Node/Python/Go/Rails read DATABASE_URL (with search_path) directly.
  }
}
