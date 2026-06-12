/**
 * Defensive reader for server-side deploy credentials (RENDER_API_KEY,
 * GITHUB_TOKEN, FLY_API_TOKEN, RAILWAY_API_TOKEN, VERCEL_TOKEN, …).
 *
 * Tokens are configured in `.env.local` — where, by our convention, values are
 * wrapped in double quotes (e.g. FLY_API_TOKEN="FlyV1 fm2_..."). dotenv strips
 * those quotes for `next dev`, so local runs work. But the SAME token pasted into
 * a hosting provider's env UI (Render/Vercel), or read by any non-dotenv parser,
 * keeps the quotes. A leading/trailing quote — or stray whitespace/newline from a
 * copy-paste — is then sent verbatim in the `Authorization` header and the
 * upstream API rejects it with an opaque 401. That mismatch (works locally, fails
 * on the deployed studio) is the "token issue" this normalizes away.
 *
 * See [[feedback_envlocal_quoted_values]].
 */

/** Read a credential, trimming whitespace and one pair of surrounding quotes. */
export function serverToken(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null) return undefined;
  let v = raw.trim();
  // Strip a single pair of matching surrounding quotes (single or double).
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    v = v.slice(1, -1).trim();
  }
  return v || undefined;
}

/** Like {@link serverToken} but throws a clear, actionable error when missing. */
export function requireServerToken(name: string, hint?: string): string {
  const v = serverToken(name);
  if (!v) throw new Error(`${name} is not configured on the server.${hint ? ` ${hint}` : ""}`);
  return v;
}
