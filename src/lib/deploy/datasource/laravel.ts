import type { RepoFile } from "../github";

/**
 * Laravel datasource coercion — SQLite dev DB → managed Postgres.
 *
 * Laravel selects its connection from `DB_CONNECTION`, which generated apps
 * default to `sqlite`. db-env.ts sets DB_CONNECTION=pgsql + the discrete DB_* at
 * deploy, but a committed `.env` with `DB_CONNECTION=sqlite` can still win, so flip
 * it in the file too. (config/database.php reads env(), so the env vars do the
 * rest once the connection name is pgsql.)
 */
export function coerceLaravelDatasource(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const notes: string[] = [];
  const out = files.map((f) => {
    if (!/(^|\/)\.env(\.\w+)?$/.test(f.path) || !/^DB_CONNECTION\s*=\s*sqlite/m.test(f.content)) return f;
    notes.push(`Laravel: set DB_CONNECTION=pgsql in ${f.path}.`);
    return { path: f.path, content: f.content.replace(/^DB_CONNECTION\s*=\s*sqlite.*$/m, "DB_CONNECTION=pgsql") };
  });
  return { files: out, notes };
}
