import type { RepoFile } from "./github";

/**
 * Deploy-time hardening for generated PYTHON backends — the runtime-crash classes
 * that survive a build and only surface once the app is live behind gunicorn.
 *
 * Mirrors the frontend `harden.ts` and the CORS/dual-stack rewrites in
 * `universal-prepare`: conservative, idempotent, behavior-preserving source
 * transforms. Two classes, both observed breaking a real deploy:
 *
 *  1. JWT subject must be a string. flask-jwt-extended 4.x (and the JWT spec)
 *     require the `sub` claim to be a string. Generated code routinely mints
 *     tokens with an int — `create_access_token(identity=user.id)` — so login
 *     returns a token but EVERY protected route then fails with 422 "Subject must
 *     be a string"; the app appears to "log in and do nothing". We cast the
 *     identity to `str(...)` on mint and, for integer-PK apps, back to `int(...)`
 *     on read so `Model.id == user_id` keeps matching.
 *
 *  2. Startup work gated behind `if __name__ == "__main__":`. Under gunicorn/
 *     uvicorn that block never runs, so table creation / seeding silently doesn't
 *     happen (e.g. the advertised demo user never exists → login 401s). We add a
 *     guarded module-level call so the init/seed runs under the real server.
 */

const PY = /\.py$/;

/** A function-call argument that is a plain dotted name (no nested parens). */
const ID_ARG = /create_access_token\(\s*identity\s*=\s*([A-Za-z_][\w.]*)\s*\)/g;

/**
 * Cast JWT identities to string on mint, and to int on read when the identity is
 * clearly an integer primary key (`...​.id`/`id`). Idempotent: an identity already
 * wrapped in `str(...)` contains a `(` and so doesn't match ID_ARG; a read already
 * wrapped in `int(...)` is skipped via lookbehind.
 */
export function fixJwtStringSubject(content: string): string {
  let intIdentity = false;
  let out = content.replace(ID_ARG, (_m, expr: string) => {
    if (/(^|\.)id$/.test(expr)) intIdentity = true; // user.id / current_user.id / id
    return `create_access_token(identity=str(${expr}))`;
  });
  // Only cast reads back to int when the token plainly carries an integer PK; a
  // string/UUID/email identity must stay a string. Lookbehind keeps it idempotent.
  if (intIdentity) {
    out = out.replace(/(?<!int\()\bget_jwt_identity\(\)/g, "int(get_jwt_identity())");
  }
  return out;
}

const MAIN_GUARD = /if\s+__name__\s*==\s*['"]__main__['"]\s*:/;
// A parameterless call to a function whose name implies startup work.
const INIT_CALL = /\b((?:seed|init|setup|bootstrap|create_tables|init_db|migrate)\w*)\(\)/i;
const SEED_MARKER = "platform: run startup init under WSGI";

/**
 * If required init/seed runs only inside the `__main__` block, also run it at
 * import so it executes under gunicorn/uvicorn. Guarded (try/except) so it can
 * never break boot; idempotent via the marker. Only fires when the named function
 * is actually defined in the file (so we never call something that doesn't exist).
 */
export function seedUnderWsgi(content: string): string {
  if (content.includes(SEED_MARKER)) return content;
  const mainIdx = content.search(MAIN_GUARD);
  if (mainIdx === -1) return content;
  const mainBlock = content.slice(mainIdx);
  const call = mainBlock.match(INIT_CALL);
  if (!call) return content;
  const fn = call[1];
  // The function must be defined in this module (def fn(): with no required args).
  if (!new RegExp(`\\bdef\\s+${fn}\\s*\\(\\s*\\)\\s*:`).test(content)) return content;
  return (
    content.replace(/\s*$/, "\n") +
    `\n\n# --- ${SEED_MARKER} (the __main__ block below does not run there) ---\n` +
    `try:\n    ${fn}()\nexcept Exception:\n    pass\n`
  );
}

export interface BackendHardenResult {
  files: RepoFile[];
  applied: string[];
}

/** Apply the Python backend hardening passes over a file set. Pure. */
export function hardenBackendFiles(files: RepoFile[]): BackendHardenResult {
  const applied = new Set<string>();
  const out = files.map((f) => {
    if (!PY.test(f.path)) return f;
    let content = f.content;
    const afterJwt = fixJwtStringSubject(content);
    if (afterJwt !== content) { applied.add("jwt-string-subject"); content = afterJwt; }
    const afterSeed = seedUnderWsgi(content);
    if (afterSeed !== content) { applied.add("seed-under-wsgi"); content = afterSeed; }
    return content === f.content ? f : { path: f.path, content };
  });
  return { files: out, applied: [...applied] };
}
