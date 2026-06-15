import type { RepoFile } from "../github";

/**
 * Prisma datasource coercion — SQLite dev DB → managed Postgres.
 *
 * Generated Node/Bun apps pin `provider = "sqlite"` (url file:./dev.db) in
 * schema.prisma. Prisma refuses a postgres URL under a sqlite provider — client
 * init / `prisma db push` errors "the URL must start with the protocol file:" —
 * so deploy or first query fails. Flip the provider to postgresql; the url already
 * reads `env("DATABASE_URL")`, which the pipeline sets.
 *
 * Framework-agnostic: keyed off schema.prisma, not the framework slug (Next /
 * Express / Bun / … all share it).
 */
export function coercePrismaDatasource(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const notes: string[] = [];
  const out = files.map((f) => {
    if (!/(^|\/)schema\.prisma$/.test(f.path)) return f;
    const content = f.content.replace(/provider\s*=\s*["']sqlite["']/g, 'provider = "postgresql"');
    if (content !== f.content) {
      notes.push(`Prisma: switched datasource provider sqlite → postgresql in ${f.path}.`);
      return { path: f.path, content };
    }
    return f;
  });
  return { files: out, notes };
}
