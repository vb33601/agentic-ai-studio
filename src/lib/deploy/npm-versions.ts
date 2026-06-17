import type { RepoFile } from "./github";

/**
 * Deterministic npm dependency-version repair.
 *
 * Generated package.json files routinely pin a version the model INVENTED — e.g.
 * `date-fns@^2.30.1` when the newest 2.x ever published is 2.30.0. npm then aborts
 * the whole install with `ETARGET No matching version found`, and the Vercel build
 * fails before a single line of app code runs. The LLM auto-repair is unreliable
 * for this (it guesses another version that may also not exist), yet the problem is
 * fully deterministic: the npm registry is the ground truth for which versions
 * exist. This pass validates every pinned dependency against the registry and
 * rewrites only the ones that resolve to nothing — pinning them to the newest
 * STABLE published version in the same major (preserving the `^`/`~` intent), or
 * the dist-tag `latest` when the whole major is fictional.
 *
 * FAIL-OPEN by construction: a manifest that doesn't parse, a package the registry
 * can't answer for, or any network error leaves the dependency exactly as-is — this
 * can only ever turn an install that was GUARANTEED to fail into one that resolves;
 * it never rewrites a version that already exists.
 */

const REGISTRY = (process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org").replace(/\/+$/, "");

const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export interface VersionRepair {
  file: string;
  pkg: string;
  from: string;
  to: string;
}

export interface RepairResult {
  files: RepoFile[];
  repairs: VersionRepair[];
}

/** Slim packument: which exact versions exist, the newest stable per major, and `latest`. */
interface Packument {
  versions: Set<string>;
  stableByMajor: Map<number, string>;
  latest?: string;
}

export type PackumentFetcher = (name: string) => Promise<Packument | null>;

type SemverTuple = [number, number, number];

const EXACT = /^\d+\.\d+\.\d+$/; // stable release, no prerelease/build suffix
const PINNED = /^\s*(\^|~|=|v|>=)?\s*v?(\d+\.\d+\.\d+)\s*$/; // a single exact-ish pin

function parse(v: string): SemverTuple | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gt(a: SemverTuple, b: SemverTuple): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

/** Build the slim packument from a registry document. */
function toPackument(doc: { versions?: Record<string, unknown>; "dist-tags"?: Record<string, string> }): Packument {
  const versions = new Set(Object.keys(doc.versions || {}));
  const stableByMajor = new Map<number, string>();
  for (const v of versions) {
    if (!EXACT.test(v)) continue; // never auto-pin to a prerelease (e.g. 3.0.0-beta.1)
    const p = parse(v);
    if (!p) continue;
    const cur = stableByMajor.get(p[0]);
    if (!cur || gt(p, parse(cur)!)) stableByMajor.set(p[0], v);
  }
  return { versions, stableByMajor, latest: doc["dist-tags"]?.latest };
}

/** Default fetcher: the public npm registry's slim "install" packument. */
const defaultFetcher: PackumentFetcher = async (name) => {
  try {
    const res = await fetch(`${REGISTRY}/${name.replace("/", "%2F")}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return null;
    return toPackument((await res.json()) as Parameters<typeof toPackument>[0]);
  } catch {
    return null;
  }
};

/**
 * Decide a corrected range for one dependency, or null to leave it untouched.
 * Only single exact-ish pins are candidates; ranges, tags, urls, git/workspace
 * specs, and `*`/`latest` always resolve and are never rewritten.
 */
function correctedRange(range: string, pack: Packument): string | null {
  const m = range.match(PINNED);
  if (!m) return null; // not a plain pin → out of scope (ranges/tags/urls/etc.)
  const base = m[2];
  if (pack.versions.has(base)) return null; // the pinned version really exists → fine

  // Hallucinated pin: prefer the newest stable in the same major (keeps the app on
  // the major it was written against), else the registry's `latest`.
  const major = parse(base)![0];
  const target = pack.stableByMajor.get(major) || pack.latest;
  if (!target || !EXACT.test(target)) return null; // nothing safe/stable to pin to
  const op = m[1] === "^" || m[1] === "~" ? m[1] : "^"; // preserve ^/~, normalize bare/=/v/>= to ^
  const fixed = `${op}${target}`;
  return fixed === range.trim() ? null : fixed;
}

// ---------------------------------------------------------------------------
// Coupled peer families
// ---------------------------------------------------------------------------

/**
 * Some packages are published as a FAMILY whose members must share a major, or
 * npm's peer resolution aborts the install. The classic generated-app failure:
 * a MUI v5 app pins `@mui/material@^5` but `@mui/lab@"latest"`, which resolves to
 * a v9 beta whose peer is `@mui/material@^9` — ERESOLVE, the Vercel build dies at
 * `npm install`. `repairDependencyVersions` above can't catch this (the satellite
 * version really EXISTS; it's just peer-incompatible), so this pass aligns every
 * satellite to the ANCHOR package's major.
 */
interface PeerFamily {
  anchor: string;
  satellites: string[];
}
const PEER_FAMILIES: PeerFamily[] = [
  { anchor: "@mui/material", satellites: ["@mui/lab", "@mui/icons-material", "@mui/system", "@mui/base", "@mui/styled-engine"] },
];

const TAG_OR_FLOATING = /^(latest|next|canary|beta|alpha|rc|\*|x)$/i;

/** The major a range targets, or null for tags/urls/git/workspace/floating specs. */
function rangeMajor(range: string): number | null {
  const t = range.trim();
  if (TAG_OR_FLOATING.test(t)) return null;
  const m = t.match(/^[\s^~>=v]*?(\d+)(?:[.\s]|$)/);
  return m ? Number(m[1]) : null;
}

/** Full semver compare incl. prerelease ordering (release > prerelease). */
function cmpVer(a: string, b: string): number {
  const [ca, ...pa] = a.split("-");
  const [cb, ...pb] = b.split("-");
  const ra = ca.split(".").map(Number);
  const rb = cb.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((ra[i] || 0) !== (rb[i] || 0)) return (ra[i] || 0) - (rb[i] || 0);
  const sa = pa.join("-");
  const sb = pb.join("-");
  if (!sa && sb) return 1; // release > prerelease
  if (sa && !sb) return -1;
  if (!sa && !sb) return 0;
  const ia = sa.split(".");
  const ib = sb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const xn = !Number.isNaN(nx) && /^\d+$/.test(x);
    const yn = !Number.isNaN(ny) && /^\d+$/.test(y);
    if (xn && yn) {
      if (nx !== ny) return nx - ny;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Newest version of a package within a given major — stable if any, else the
 *  newest prerelease (e.g. `@mui/lab` only ships `5.0.0-alpha.*` for MUI v5). */
function pickInMajor(pack: Packument, major: number): string | null {
  const stable = pack.stableByMajor.get(major);
  if (stable) return stable;
  let best: string | null = null;
  for (const v of pack.versions) {
    const p = parse(v);
    if (!p || p[0] !== major) continue;
    if (!best || cmpVer(v, best) > 0) best = v;
  }
  return best;
}

/**
 * Align every coupled-family satellite to its anchor's major across all manifests.
 * Same fail-open contract as the version repair: a manifest that won't parse, a
 * registry it can't reach, or no compatible version leaves the spec untouched.
 */
export async function reconcilePeerFamilies(
  files: RepoFile[],
  opts: { fetcher?: PackumentFetcher } = {},
): Promise<RepairResult> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const manifests = files
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.path === "package.json" || f.path.endsWith("/package.json"));
  if (manifests.length === 0) return { files, repairs: [] };

  const packCache = new Map<string, Packument | null>();
  const getPack = async (n: string) => {
    if (!packCache.has(n)) packCache.set(n, await fetcher(n).catch(() => null));
    return packCache.get(n) ?? null;
  };

  const out = [...files];
  const repairs: VersionRepair[] = [];
  for (const { f, i } of manifests) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(f.content);
    } catch {
      continue;
    }
    let changed = false;
    for (const fam of PEER_FAMILIES) {
      // Locate the anchor spec and resolve its major (from the range, else the
      // registry's `latest` when the anchor itself floats on a tag).
      let anchorRange: string | undefined;
      for (const sec of DEP_SECTIONS) {
        const b = json[sec] as Record<string, string> | undefined;
        if (b && typeof b[fam.anchor] === "string") {
          anchorRange = b[fam.anchor];
          break;
        }
      }
      if (anchorRange === undefined) continue;
      let anchorMajor = rangeMajor(anchorRange);
      if (anchorMajor === null) {
        const ap = await getPack(fam.anchor);
        const lp = ap?.latest ? parse(ap.latest) : null;
        anchorMajor = lp ? lp[0] : null;
      }
      if (anchorMajor === null) continue;

      for (const sat of fam.satellites) {
        for (const sec of DEP_SECTIONS) {
          const b = json[sec] as Record<string, string> | undefined;
          if (!b || typeof b[sat] !== "string") continue;
          const cur = b[sat];
          if (rangeMajor(cur) === anchorMajor) continue; // already aligned
          const sp = await getPack(sat);
          if (!sp) continue; // registry can't answer → fail open
          const target = pickInMajor(sp, anchorMajor);
          if (!target) continue; // no version in the anchor's major → leave as-is
          const fixed = `^${target}`;
          if (fixed === cur.trim()) continue;
          b[sat] = fixed;
          repairs.push({ file: f.path, pkg: sat, from: cur, to: fixed });
          changed = true;
        }
      }
    }
    if (changed) out[i] = { path: f.path, content: JSON.stringify(json, null, 2) + "\n" };
  }
  return { files: out, repairs };
}

/** Parse a manifest's dependency sections into a flat name→range map. */
function readDeps(content: string): { json: Record<string, unknown>; names: string[] } | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const sec of DEP_SECTIONS) {
    const block = json[sec];
    if (block && typeof block === "object") for (const n of Object.keys(block as object)) names.add(n);
  }
  return { json, names: [...names] };
}

/**
 * Validate every pinned dependency across all package.json files against the npm
 * registry and rewrite the hallucinated ones in place. Returns the (possibly
 * unchanged) files plus a list of the repairs made for logging.
 */
export async function repairDependencyVersions(
  files: RepoFile[],
  opts: { fetcher?: PackumentFetcher } = {},
): Promise<RepairResult> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const manifests = files
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.path === "package.json" || f.path.endsWith("/package.json"));
  if (manifests.length === 0) return { files, repairs: [] };

  // Collect every dependency name across all manifests, then fetch each unique
  // packument once (a package pinned in two manifests is one request).
  const wanted = new Set<string>();
  const parsed = new Map<number, { json: Record<string, unknown>; names: string[] }>();
  for (const { f, i } of manifests) {
    const r = readDeps(f.content);
    if (!r) continue;
    parsed.set(i, r);
    for (const n of r.names) wanted.add(n);
  }
  if (wanted.size === 0) return { files, repairs: [] };

  const packs = new Map<string, Packument | null>();
  await Promise.all(
    [...wanted].map(async (name) => {
      packs.set(name, await fetcher(name).catch(() => null));
    }),
  );

  const out = [...files];
  const repairs: VersionRepair[] = [];
  for (const { f, i } of manifests) {
    const r = parsed.get(i);
    if (!r) continue;
    let changed = false;
    for (const sec of DEP_SECTIONS) {
      const block = r.json[sec] as Record<string, string> | undefined;
      if (!block || typeof block !== "object") continue;
      for (const [name, range] of Object.entries(block)) {
        if (typeof range !== "string") continue;
        const pack = packs.get(name);
        if (!pack) continue; // registry couldn't answer → fail open
        const fixed = correctedRange(range, pack);
        if (fixed) {
          block[name] = fixed;
          repairs.push({ file: f.path, pkg: name, from: range, to: fixed });
          changed = true;
        }
      }
    }
    if (changed) out[i] = { path: f.path, content: JSON.stringify(r.json, null, 2) + "\n" };
  }

  return { files: out, repairs };
}
