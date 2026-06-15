/**
 * Datasource-coercion across every ORM-bearing stack.
 *
 *   npx tsx scripts/test-datasource.mts
 *
 * Verifies the one-class-of-defect fix — a baked-in local-dev DB (H2/SQLite/
 * DB_CONNECTION=sqlite) is re-pointed to the managed Postgres the pipeline wires
 * in — for Spring, Prisma, .NET, Rails, Django, Laravel, AND that the whole pass
 * is a NO-OP when `needsDatabase` is false (the embedded-SQLite apps the pipeline
 * deliberately leaves on their own file DB).
 */
import { hardenDatasource } from "../src/lib/deploy/datasource";
import { databaseEnvForFramework } from "../src/lib/deploy/db-env";
import type { StackPlan } from "../src/lib/deploy/dockerfile";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

const plan = (framework: string, stack: string, needsDatabase = true): StackPlan => ({
  stack: stack as StackPlan["stack"],
  framework,
  label: framework,
  role: "backend",
  dockerfile: "FROM scratch\n",
  dockerignore: "",
  port: 8080,
  needsDatabase,
  runsMigrations: false,
  notes: [],
});

type F = { path: string; content: string };
const run = (framework: string, stack: string, files: F[], dockerfile = "FROM scratch\n", needsDb = true) =>
  hardenDatasource(plan(framework, stack, needsDb), files, dockerfile);
const get = (files: F[], match: RegExp) => files.find((f) => match.test(f.path))!;

// ── Spring: pom dep + un-pin H2 driver/dialect ──
{
  const r = run("spring", "java", [
    { path: "pom.xml", content: "<project>\n<dependencies>\n<dependency><groupId>com.h2database</groupId><artifactId>h2</artifactId></dependency>\n</dependencies>\n</project>" },
    { path: "src/main/resources/application.properties", content: "spring.datasource.driver-class-name=org.h2.Driver\nspring.jpa.database-platform=org.hibernate.dialect.H2Dialect\n" },
  ]);
  check("spring adds the postgres driver dependency", /org\.postgresql/.test(get(r.files, /pom\.xml/).content));
  const props = get(r.files, /application\.properties/).content;
  check("spring un-pins the H2 driver", /org\.postgresql\.Driver/.test(props) && !/org\.h2\.Driver/.test(props));
  check("spring un-pins the H2 dialect", /PostgreSQLDialect/.test(props) && !/H2Dialect/.test(props));
}

// ── Prisma: provider sqlite → postgresql ──
{
  const r = run("express", "node", [
    { path: "prisma/schema.prisma", content: 'datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n' },
  ]);
  const schema = get(r.files, /schema\.prisma/).content;
  check("prisma switches provider to postgresql", /provider = "postgresql"/.test(schema) && !/"sqlite"/.test(schema));
}

// ── .NET: UseSqlite → UseNpgsql (only when Npgsql is referenced) ──
{
  const withPkg = run("aspnet", "dotnet", [
    { path: "App.csproj", content: '<Project><ItemGroup><PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.4" /></ItemGroup></Project>' },
    { path: "Program.cs", content: 'builder.Services.AddDbContext<Db>(o => o.UseSqlite(cs));' },
  ]);
  check("dotnet swaps UseSqlite → UseNpgsql when Npgsql present", /UseNpgsql\(/.test(get(withPkg.files, /Program\.cs/).content));

  const noPkg = run("aspnet", "dotnet", [
    { path: "App.csproj", content: "<Project></Project>" },
    { path: "Program.cs", content: "o.UseSqlite(cs);" },
  ]);
  check("dotnet does NOT swap without Npgsql (would not compile)", /UseSqlite\(/.test(get(noPkg.files, /Program\.cs/).content));
  check("dotnet warns when it can't safely swap", noPkg.notes.some((n) => /Npgsql/.test(n)));
}

// ── Rails: database.yml adapter + pg gem (Gemfile.lock left intact) ──
{
  const r = run("rails", "ruby", [
    { path: "config/database.yml", content: "production:\n  adapter: sqlite3\n  database: db/production.sqlite3\n" },
    { path: "Gemfile", content: 'source "https://rubygems.org"\ngem "rails"\ngem "sqlite3"\n' },
    { path: "Gemfile.lock", content: "GEM\n  specs:\n    sqlite3 (1.7.0)\n" },
  ]);
  check("rails re-points the adapter to postgresql", /adapter: postgresql/.test(get(r.files, /database\.yml/).content));
  check("rails adds the pg gem", /gem "pg"/.test(get(r.files, /Gemfile$/).content));
  check("rails leaves Gemfile.lock for bundle install to re-resolve", r.files.some((f) => /Gemfile\.lock$/.test(f.path)));
}

// ── Django: DATABASE_URL override appended + dj-database-url installed ──
{
  const r = run("django", "python", [
    { path: "config/settings.py", content: "DATABASES = {\n  'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'db.sqlite3'}\n}\n" },
  ], "RUN pip install --no-cache-dir gunicorn whitenoise\n");
  const settings = get(r.files, /settings\.py/).content;
  check("django appends a DATABASE_URL override", /dj_database_url/.test(settings) && /DATABASE_URL/.test(settings));
  check("django installs dj-database-url in the image", /gunicorn whitenoise dj-database-url/.test(r.dockerfile));
  // Idempotence: re-running doesn't append a second block.
  const again = run("django", "python", r.files, r.dockerfile);
  check("django override is idempotent", (get(again.files, /settings\.py/).content.match(/dj_database_url/g) || []).length === 1);
}

// ── Laravel: .env DB_CONNECTION sqlite → pgsql + discrete env vars ──
{
  const r = run("laravel", "php", [
    { path: ".env", content: "APP_ENV=production\nDB_CONNECTION=sqlite\n" },
  ]);
  check("laravel flips .env DB_CONNECTION to pgsql", /DB_CONNECTION=pgsql/.test(get(r.files, /\.env$/).content));
  const env = databaseEnvForFramework("laravel", "postgresql://u:p@host:5432/appdb");
  check("laravel db-env sets DB_CONNECTION=pgsql", env.some((e) => e.key === "DB_CONNECTION" && e.value === "pgsql"));
  check("laravel db-env sets discrete DB_HOST/DB_DATABASE", env.some((e) => e.key === "DB_HOST" && e.value === "host") && env.some((e) => e.key === "DB_DATABASE" && e.value === "appdb"));
}

// ── The GATE: needsDatabase=false → no coercion at all (embedded-SQLite apps) ──
{
  const files: F[] = [{ path: "prisma/schema.prisma", content: 'datasource db {\n  provider = "sqlite"\n}\n' }];
  const r = run("express", "node", files, "FROM scratch\n", /* needsDb */ false);
  check("no coercion when needsDatabase is false", /provider = "sqlite"/.test(get(r.files, /schema\.prisma/).content) && r.notes.length === 0);
}

// ── Spring env override carries driver + dialect (the production Fly fix) ──
{
  const env = databaseEnvForFramework("spring", "postgresql://u:p@host:5432/appdb", "app_schema");
  check("spring db-env overrides the driver class", env.some((e) => e.key === "SPRING_DATASOURCE_DRIVER_CLASS_NAME" && e.value === "org.postgresql.Driver"));
  check("spring db-env overrides the dialect", env.some((e) => e.key === "SPRING_JPA_DATABASE_PLATFORM" && /PostgreSQLDialect/.test(e.value)));
}

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL DATASOURCE TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
