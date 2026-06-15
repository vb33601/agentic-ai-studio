import type { RepoFile } from "../github";

const DJANGO_MARKER = "# --- deploy: honor managed Postgres DATABASE_URL ---";

/**
 * Django datasource coercion — SQLite dev DB → managed Postgres.
 *
 * A generated settings.py hard-codes `ENGINE: django.db.backends.sqlite3` and
 * never reads DATABASE_URL, so the injected Postgres is ignored and writes go to
 * ephemeral SQLite (lost on redeploy; or a read-only file that 500s). Append a
 * dj-database-url override (last assignment wins) that switches DATABASES to the
 * managed Postgres WHEN DATABASE_URL is set — local dev still uses SQLite — and add
 * `dj-database-url` to the image's pip step. Idempotent via a marker comment.
 */
export function coerceDjangoDatasource(
  files: RepoFile[],
  dockerfile: string,
): { files: RepoFile[]; dockerfile: string; notes: string[] } {
  const notes: string[] = [];
  let touched = false;
  const out = files.map((f) => {
    const isSettings = /(^|\/)settings\.py$/.test(f.path) || (/\bsettings[^/]*\.py$/.test(f.path) && /DATABASES\s*=/.test(f.content));
    if (!isSettings) return f;
    if (f.content.includes(DJANGO_MARKER)) return f; // idempotent
    if (!/django\.db\.backends\.sqlite3/.test(f.content) && !/DATABASES\s*=/.test(f.content)) return f;
    touched = true;
    const block =
      `\n\n${DJANGO_MARKER}\n` +
      `import os as _dpg_os\n` +
      `if _dpg_os.environ.get("DATABASE_URL"):\n` +
      `    import dj_database_url as _dpg_dj\n` +
      `    DATABASES = {"default": _dpg_dj.parse(_dpg_os.environ["DATABASE_URL"], conn_max_age=600)}\n`;
    notes.push(`Django: appended a DATABASE_URL override to ${f.path} so the managed Postgres is used in production.`);
    return { path: f.path, content: f.content.replace(/\s*$/, "") + block };
  });

  let df = dockerfile;
  if (touched && /gunicorn whitenoise/.test(df) && !/dj-database-url/.test(df)) {
    df = df.replace(/gunicorn whitenoise/, "gunicorn whitenoise dj-database-url");
    notes.push("Django: added dj-database-url to the image's pip install.");
  }
  return { files: out, dockerfile: df, notes };
}
