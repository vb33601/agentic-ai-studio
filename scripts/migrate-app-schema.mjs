#!/usr/bin/env node
/**
 * Generate a REVIEWABLE SQL migration that moves a deployed app's tables out of
 * the shared `public` schema into its own schema (fixes the cross-app collision
 * for an already-deployed app). This only WRITES a .sql file — you review it and
 * apply it deliberately. It refuses to touch studio-owned tables.
 *
 *   node scripts/migrate-app-schema.mjs --schema my_app_x --tables users,stocks
 *
 * Then, after reviewing the generated file:
 *   1) DATABASE_URL='<aiven url>' npx prisma db execute --file ./prisma/migrate-<schema>.sql
 *   2) On the APP's host (Fly/Render), set its DATABASE_URL to include the schema:
 *        ...?options=-c%20search_path%3D<schema>%2Cpublic   (libpq: Python/Ruby/PHP/Go)
 *        .NET:  append `Search Path=<schema>;`   Spring: `?currentSchema=<schema>`
 *   3) Redeploy/restart the app so it reads from the new schema.
 *
 * `ALTER TABLE ... SET SCHEMA` moves the table WITH its data/indexes/constraints.
 * SERIAL sequences stay in `public` (still referenced cross-schema, so inserts keep
 * working) — harmless; move them too only if you want full isolation.
 */
import { writeFileSync } from "node:fs";

const STUDIO_TABLES = new Set([
  "Agent", "ApiKey", "Chat", "Deployment", "Execution", "File", "FixOutcome",
  "Memory", "Message", "Organization", "OrganizationMember", "PreflightRule",
  "Project", "Task", "User",
]);

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const schema = arg("--schema");
const tablesArg = arg("--tables");
if (!schema || !tablesArg) {
  console.error("Usage: node scripts/migrate-app-schema.mjs --schema <name> --tables <t1,t2,...>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9_]*$/.test(schema)) {
  console.error(`Refusing: schema "${schema}" is not a safe identifier ([a-z][a-z0-9_]*).`);
  process.exit(1);
}
const tables = tablesArg.split(",").map((t) => t.trim()).filter(Boolean);
const blocked = tables.filter((t) => STUDIO_TABLES.has(t));
if (blocked.length) {
  console.error(`Refusing: these are STUDIO-owned tables and must not be moved: ${blocked.join(", ")}`);
  process.exit(1);
}
for (const t of tables) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    console.error(`Refusing: table name "${t}" is not a plain identifier.`);
    process.exit(1);
  }
}

const lines = [
  `-- Move app tables into schema "${schema}" (review before applying).`,
  `-- Generated ${new Date().toISOString()}`,
  `BEGIN;`,
  `CREATE SCHEMA IF NOT EXISTS "${schema}";`,
  ...tables.map((t) => `ALTER TABLE IF EXISTS public."${t}" SET SCHEMA "${schema}";`),
  `COMMIT;`,
  ``,
];
const out = `prisma/migrate-${schema}.sql`;
writeFileSync(out, lines.join("\n"));
console.log(`Wrote ${out}:\n`);
console.log(lines.join("\n"));
console.log(`Review it, then:\n  DATABASE_URL='<aiven url>' npx prisma db execute --file ./${out}`);
console.log(`Then update the app's DATABASE_URL env (add search_path/Search Path/currentSchema) and redeploy.`);
