import type { RepoFile } from "../github";

/**
 * SQLAlchemy datasource coercion — SQLite dev DB → managed Postgres.
 *
 * Generated FastAPI/Flask/SQLAlchemy apps hard-code a local SQLite engine URL —
 * `create_engine("sqlite:///./app.db")` or `SQLALCHEMY_DATABASE_URI = "sqlite:///…"`
 * — and never read DATABASE_URL. The pipeline injects a Postgres DATABASE_URL (and
 * installs psycopg), but the hard-coded sqlite URL wins, so writes go to ephemeral
 * SQLite (lost on redeploy) or the file is read-only and 500s.
 *
 * Route the hard-coded URL through `os.environ["DATABASE_URL"]` with the original
 * literal as the local-dev fallback (so `python app.py` locally still uses SQLite),
 * mirroring the Django override. Only the URL/URI assignment and create_engine call
 * are touched — never an unrelated sqlite string — and `import os` is ensured.
 */
export function coerceSqlAlchemyDatasource(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const notes: string[] = [];
  const out = files.map((f) => {
    if (!/\.py$/.test(f.path)) return f;
    if (!/sqlite:\/\/\//.test(f.content)) return f;
    if (!/create_engine|SQLALCHEMY_DATABASE_UR[IL]|SQLALCHEMY_DATABASE_URI/.test(f.content)) return f;

    let c = f.content;
    let changed = false;
    const wrap = (lit: string) => `os.environ.get("DATABASE_URL", ${lit})`;

    // create_engine("sqlite:///…")  — leave an already-wrapped call alone (idempotent:
    // after wrapping, the char after `create_engine(` is `o`, not a quote).
    c = c.replace(/create_engine\(\s*(["']sqlite:\/\/\/[^"']*["'])/g, (_m, lit) => {
      changed = true;
      return `create_engine(${wrap(lit)}`;
    });
    // SQLALCHEMY_DATABASE_URL = "sqlite:///…"  OR  config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///…"
    c = c.replace(
      /(SQLALCHEMY_DATABASE_UR[IL]\s*=\s*|\[\s*["']SQLALCHEMY_DATABASE_URI["']\s*\]\s*=\s*)(["']sqlite:\/\/\/[^"']*["'])/g,
      (_m, lhs, lit) => {
        changed = true;
        return `${lhs}${wrap(lit)}`;
      },
    );

    if (!changed) return f;
    // Ensure `import os` (insert right after the first import so it's valid even
    // when the file leads with `from __future__ import …`).
    if (!/^[ \t]*import\s+os\b/m.test(c)) {
      c = /^[ \t]*(import|from)\s/m.test(c)
        ? c.replace(/^([ \t]*(?:import|from)\s.*\n)/m, "$1import os\n")
        : "import os\n" + c;
    }
    notes.push(`SQLAlchemy: routed a hard-coded sqlite engine URL through os.environ["DATABASE_URL"] in ${f.path}.`);
    return { path: f.path, content: c };
  });
  return { files: out, notes };
}
