import type { RepoFile } from "../github";

/**
 * Rails datasource coercion — SQLite dev DB → managed Postgres.
 *
 * Generated Rails apps use `adapter: sqlite3` in config/database.yml and ship only
 * the sqlite3 gem. With the managed Postgres DATABASE_URL that either loads the
 * wrong adapter (LoadError: pg) or silently writes to ephemeral SQLite that resets
 * on every redeploy. Re-point the adapter to postgresql and add the `pg` gem.
 *
 * We do NOT touch Gemfile.lock: the Rails image runs a non-frozen `bundle install`,
 * which resolves the newly-added gem and updates the lock itself. (Dropping the
 * lock would force a full re-resolution and risk a hung/failed build.)
 */
export function coerceRailsDatasource(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const notes: string[] = [];
  const out = files.map((f) => {
    if (/(^|\/)config\/database\.yml$/.test(f.path) && /adapter:\s*sqlite3/.test(f.content)) {
      notes.push("Rails: re-pointed database.yml adapter sqlite3 → postgresql.");
      return { path: f.path, content: f.content.replace(/adapter:\s*sqlite3/g, "adapter: postgresql") };
    }
    if (/(^|\/)Gemfile$/.test(f.path) && !/gem\s+["']pg["']/.test(f.content)) {
      notes.push('Rails: added gem "pg" to the Gemfile so the Postgres adapter loads.');
      return { path: f.path, content: f.content.replace(/\n?$/, '\ngem "pg"\n') };
    }
    return f;
  });
  return { files: out, notes };
}
