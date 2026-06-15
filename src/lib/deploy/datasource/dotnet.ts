import type { RepoFile } from "../github";

/**
 * .NET/EF Core datasource coercion — SQLite dev DB → managed Postgres.
 *
 * Generated EF Core apps call `UseSqlite(connectionString)` in Program.cs. Fed
 * the managed Postgres connection string, SQLite's parser throws
 * "keyword 'host' not supported" and 500s every request. `UseNpgsql` takes the
 * same connection-string argument, so the swap is call-compatible — but only when
 * Npgsql is referenced, otherwise the `UseNpgsql` extension won't compile. When it
 * isn't, we leave the source untouched and emit an advisory instead of producing a
 * build that can't compile.
 */
export function coerceDotnetDatasource(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const notes: string[] = [];
  const hasNpgsql = files.some((f) => /\.csproj$/.test(f.path) && /Npgsql/i.test(f.content));
  if (!hasNpgsql) {
    if (files.some((f) => /\.cs$/.test(f.path) && /\bUseSqlite\s*\(/.test(f.content))) {
      notes.push("⚠ .NET: code calls UseSqlite() but no Npgsql package is referenced; cannot safely swap to UseNpgsql — add Npgsql.EntityFrameworkCore.PostgreSQL.");
    }
    return { files, notes };
  }
  const out = files.map((f) => {
    if (!/\.cs$/.test(f.path) || !/\bUseSqlite\s*\(/.test(f.content)) return f;
    notes.push(`.NET: swapped UseSqlite() → UseNpgsql() in ${f.path} so EF accepts the managed Postgres connection string.`);
    return { path: f.path, content: f.content.replace(/\bUseSqlite\s*\(/g, "UseNpgsql(") };
  });
  return { files: out, notes };
}
