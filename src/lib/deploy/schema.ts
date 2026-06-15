import type { RepoFile } from "./github";
import type { StackPlan } from "./dockerfile";

/**
 * Database schema strategy: NO MIGRATIONS, auto-create the schema from the model.
 *
 * Generated apps routinely ship broken migration scaffolding — EF migration files
 * that don't compile (a `.cs` whose body is actually a `.csproj`, a Designer that
 * forgets its `using`, an `[assembly: MigrationAssembly]` attribute that doesn't
 * exist), Django/Rails migrations that drift from the models, Prisma migration
 * histories that conflict. Each is a recurring deploy-killer: the .NET ones fail
 * the BUILD (the SDK compiles every `.cs`), the rest fail at START when the
 * migration step errors.
 *
 * The fix is uniform across stacks: never run migrations on generation or deploy.
 * Instead let the ORM create the schema directly from the entities/models at
 * startup, so data writes go straight to a freshly-created database:
 *
 *   .NET (EF Core)   drop Migrations/, Database.Migrate() -> EnsureCreated()
 *   Django           drop app migrations, migrate --run-syncdb (tables from models)
 *   Rails            db:schema:load (load schema, not replay migrations)
 *   Spring (JPA)     SPRING_JPA_HIBERNATE_DDL_AUTO=update (Hibernate builds the DDL)
 *   Node + Prisma    prisma db push (sync schema, no migration history)
 *
 * DB-less stacks (Go, static, most of the 45) have nothing to do here and are a
 * clean no-op — they already "write directly" with no migration layer.
 */

/** A `.cs/.fs/.vb` file whose body is actually an MSBuild project — never compiles. */
const SOURCE_EXT = /\.(cs|fs|vb)$/;
const IS_PROJECT_XML = /^﻿?\s*<Project\b/;
/** Any path segment named "migration"/"migrations" (case-insensitive). */
const MIGRATIONS_SEG = /(^|\/)migrations?\//i;

export interface SchemaResult {
  files: RepoFile[];
  dockerfile: string;
  notes: string[];
}

/**
 * Apply the no-migrations / auto-create-schema strategy to a prepared app.
 * Returns the sanitized file set, the (possibly CMD-rewritten) Dockerfile, and
 * human-readable notes describing what changed.
 */
export function prepareSchema(plan: StackPlan, files: RepoFile[], dockerfile: string): SchemaResult {
  const notes: string[] = [];
  let out = files;
  let df = dockerfile;

  // --- Universal: drop source files that are actually project/markup XML. The
  // compiler treats them as code and dies (StockPortfolio: CS1525 on '<'). ---
  const beforeJunk = out.length;
  out = out.filter((f) => !(SOURCE_EXT.test(f.path) && IS_PROJECT_XML.test(f.content)));
  if (out.length < beforeJunk) {
    notes.push(`Removed ${beforeJunk - out.length} misnamed project file(s) carrying a source extension (would fail to compile).`);
  }

  switch (plan.framework) {
    // --- .NET / EF Core: drop migration scaffolding, create schema at startup. ---
    case "aspnet": {
      const before = out.length;
      out = out.filter((f) => !MIGRATIONS_SEG.test(f.path));
      const dropped = before - out.length;
      out = out.map((f) =>
        /\.(cs|fs|vb)$/.test(f.path)
          ? { path: f.path, content: rewriteEfToEnsureCreated(stripMigrationUsings(f.content)) }
          : f,
      );
      notes.push(
        dropped > 0
          ? `.NET: dropped ${dropped} EF migration file(s); schema auto-created via EnsureCreated() at startup.`
          : `.NET: schema auto-created via EnsureCreated() (Database.Migrate() rewritten where present).`,
      );
      break;
    }

    // --- Django: tables come straight from models via --run-syncdb (no migrations). ---
    case "django": {
      const before = out.length;
      out = out.filter(
        (f) => !(MIGRATIONS_SEG.test(f.path) && /\.py$/.test(f.path) && !/(^|\/)__init__\.py$/.test(f.path)),
      );
      df = df.replace(/manage\.py migrate --noinput/g, "manage.py migrate --run-syncdb --noinput");
      notes.push(`Django: dropped ${before - out.length} migration file(s); schema created from models (migrate --run-syncdb).`);
      break;
    }

    // --- Rails: load schema directly instead of replaying migrations. ---
    case "rails":
      df = df.replace(
        /bundle exec rails db:prepare 2>\/dev\/null \|\| true/,
        "bundle exec rails db:schema:load 2>/dev/null || bundle exec rails db:migrate 2>/dev/null || true",
      );
      notes.push("Rails: schema loaded directly (db:schema:load); migrations not replayed on deploy.");
      break;

    // --- Spring/JPA: Hibernate builds the schema from the entities. ---
    // (Coercing a baked-in H2 datasource → Postgres is a separate concern handled
    // by the datasource/ coercion modules; here we only set the no-migrations strategy.)
    case "spring":
      if (!/SPRING_JPA_HIBERNATE_DDL_AUTO/.test(df)) {
        df = df.replace(
          /(COPY --from=build \/build-app\.jar \/app\/app\.jar\n)/,
          "$1ENV SPRING_JPA_HIBERNATE_DDL_AUTO=update\n",
        );
        notes.push("Spring: SPRING_JPA_HIBERNATE_DDL_AUTO=update so Hibernate auto-creates the schema from entities.");
      }
      break;
  }

  // --- Node + Prisma: push the schema (no migration history) instead of migrate deploy.
  // Prisma's migrate command appears in the Dockerfile and/or package.json scripts. ---
  if (out.some((f) => /(^|\/)prisma\/schema\.prisma$/.test(f.path))) {
    const PRISMA_MIGRATE = /prisma migrate deploy/g;
    if (PRISMA_MIGRATE.test(df)) df = df.replace(PRISMA_MIGRATE, "prisma db push --accept-data-loss");
    let touched = false;
    out = out.map((f) => {
      if (!/package\.json$/.test(f.path) || !/prisma migrate deploy/.test(f.content)) return f;
      touched = true;
      return { path: f.path, content: f.content.replace(/prisma migrate deploy/g, "prisma db push --accept-data-loss") };
    });
    if (touched || df.includes("prisma db push")) {
      notes.push("Prisma: schema pushed directly (db push); no migration history.");
    }
  }

  return { files: out, dockerfile: df, notes };
}

/** Rewrite EF Core's migration-applying calls to model-driven schema creation. */
function rewriteEfToEnsureCreated(src: string): string {
  return src
    .replace(/\.Database\s*\.\s*Migrate\s*\(\s*\)/g, ".Database.EnsureCreated()")
    .replace(/\.Database\s*\.\s*MigrateAsync\s*\(([^)]*)\)/g, ".Database.EnsureCreatedAsync($1)");
}

/** Drop `using <ns>.Migrations;` imports left dangling once the folder is removed. */
function stripMigrationUsings(src: string): string {
  return src.replace(/^[ \t]*using\s+[\w.]+\.Migrations\s*;[ \t]*\r?\n/gm, "");
}
