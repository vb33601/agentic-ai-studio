import type { RepoFile } from "../github";
import type { StackPlan } from "../dockerfile";
import { coerceSpringDatasource } from "./spring";
import { coerceDotnetDatasource } from "./dotnet";
import { coercePrismaDatasource } from "./prisma";
import { coerceRailsDatasource } from "./rails";
import { coerceDjangoDatasource } from "./django";
import { coerceLaravelDatasource } from "./laravel";
import { coerceSqlAlchemyDatasource } from "./sqlalchemy";

/**
 * Datasource coercion: re-point a generated app's BAKED-IN local-dev database
 * (H2 / SQLite / `DB_CONNECTION=sqlite`) to the managed Postgres the pipeline
 * wires in, so the injected DATABASE_URL / SPRING_DATASOURCE_ vars are actually
 * used instead of being hijacked back to the local DB at boot.
 *
 * Each stack's coercion is a SEPARATE, self-contained module (./spring, ./dotnet,
 * ./prisma, ./rails, ./django, ./laravel, ./sqlalchemy). This dispatcher only
 * routes — keeping the stacks isolated so one stack's fix can't affect another's
 * deploy, and any single stack can be disabled by removing its one line below.
 *
 * CIRCULATION AUDIT — how every DB-bearing technology the detector knows about is
 * handled, so none is silently left on a local DB:
 *
 *   COERCED here (config/source re-pointed to Postgres):
 *     spring (H2) · aspnet (EF UseSqlite) · prisma (provider) · rails (adapter) ·
 *     django (settings) · laravel (DB_CONNECTION) · sqlalchemy (engine URL)
 *   ENV-COVERED (the framework reads DATABASE_URL directly — nothing to rewrite):
 *     symfony/Doctrine, phoenix/Ecto, rust (sqlx/diesel), scala (slick/doobie),
 *     go (database/sql + pgx/lib-pq), deno, bun, and the JDBC/libpq long-tail.
 *   DELIBERATELY NOT rewritten (no deterministic, safe transform):
 *     go/gorm and non-Prisma Node ORMs (sequelize/typeorm/drizzle) — their
 *     dialect+connection shape varies too much to rewrite without risking a worse
 *     break; they fall back to ENV-COVERED when they read DATABASE_URL.
 *
 * CRITICAL GATE: runs ONLY when `plan.needsDatabase` is true. `embeddedSqlite`
 * (dockerfile.ts) already sets that false for apps that manage their OWN file
 * database with no server driver — those are deliberately left on SQLite (wiring
 * Postgres into them would crash), so we must not coerce them.
 */

export interface DatasourceResult {
  files: RepoFile[];
  dockerfile: string;
  notes: string[];
}

export function hardenDatasource(plan: StackPlan, files: RepoFile[], dockerfile: string): DatasourceResult {
  if (!plan.needsDatabase) return { files, dockerfile, notes: [] };

  const notes: string[] = [];
  let out = files;
  let df = dockerfile;

  // Prisma is framework-agnostic (keyed on schema.prisma), so it runs for any
  // Node/Bun app rather than via the framework switch.
  const prisma = coercePrismaDatasource(out);
  out = prisma.files;
  notes.push(...prisma.notes);

  switch (plan.framework) {
    case "spring": {
      const r = coerceSpringDatasource(out);
      out = r.files;
      notes.push(...r.notes);
      break;
    }
    case "aspnet": {
      const r = coerceDotnetDatasource(out);
      out = r.files;
      notes.push(...r.notes);
      break;
    }
    case "rails": {
      const r = coerceRailsDatasource(out);
      out = r.files;
      notes.push(...r.notes);
      break;
    }
    case "django": {
      const r = coerceDjangoDatasource(out, df);
      out = r.files;
      df = r.dockerfile;
      notes.push(...r.notes);
      break;
    }
    case "laravel": {
      const r = coerceLaravelDatasource(out);
      out = r.files;
      notes.push(...r.notes);
      break;
    }
    // SQLAlchemy spans the Python web frameworks (FastAPI/Flask and bare-Python
    // apps); Django uses its own ORM and is handled above.
    case "fastapi":
    case "flask":
    case "python": {
      const r = coerceSqlAlchemyDatasource(out);
      out = r.files;
      notes.push(...r.notes);
      break;
    }
  }

  return { files: out, dockerfile: df, notes };
}
