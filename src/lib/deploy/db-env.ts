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

export interface DbEnvVar {
  key: string;
  value: string;
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

/** Spring Boot reads SPRING_DATASOURCE_* with a JDBC URL (no userinfo inline). */
function springDatasource(postgresUrl: string): DbEnvVar[] {
  const p = parsePostgresUrl(postgresUrl);
  if (!p) return [];
  return [
    { key: "SPRING_DATASOURCE_URL", value: `jdbc:postgresql://${p.host}:${p.port}/${p.database}` },
    { key: "SPRING_DATASOURCE_USERNAME", value: p.user },
    { key: "SPRING_DATASOURCE_PASSWORD", value: p.password },
  ];
}

/**
 * Extra DB env vars for a detected backend framework. `DATABASE_URL` is always
 * set by the caller; this adds the framework-specific keys/shapes on top.
 */
export function databaseEnvForFramework(framework: string, postgresUrl: string): DbEnvVar[] {
  switch (framework) {
    case "aspnet": {
      const cs = npgsqlConnectionString(postgresUrl);
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
      return springDatasource(postgresUrl);
    default:
      return []; // Node/Python/Go/Rails/PHP read DATABASE_URL directly.
  }
}
