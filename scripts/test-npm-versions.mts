/**
 * Deterministic npm dependency-version repair: correctness + the no-op safety net.
 *
 *   npx tsx scripts/test-npm-versions.mts
 *
 * Two guarantees:
 *   1) It fixes the real Vercel failure — a hallucinated pin like `date-fns@^2.30.1`
 *      (which npm rejects with ETARGET) is rewritten to a version that actually
 *      exists, preserving the caret/tilde intent and staying on the same major.
 *   2) It is a strict NO-OP on valid manifests — real pins, ranges, tags, urls, and
 *      packages the registry can't answer for are left byte-for-byte untouched, so a
 *      working install is never "repaired" into a different one.
 *
 * The registry is stubbed, so this runs fully offline and deterministically.
 */
import {
  repairDependencyVersions,
  reconcilePeerFamilies,
  type PackumentFetcher,
} from "../src/lib/deploy/npm-versions.ts";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// A tiny fake registry mirroring real published version sets.
const REGISTRY: Record<string, { versions: string[]; latest?: string }> = {
  "date-fns": { versions: ["2.29.3", "2.30.0", "3.0.0", "3.6.0", "4.0.0"], latest: "4.0.0" },
  react: { versions: ["17.0.2", "18.2.0", "18.3.1"], latest: "18.3.1" },
  vite: { versions: ["4.5.0", "5.0.0", "5.4.0", "6.0.0-beta.1"], latest: "5.4.0" },
  // MUI family, mirroring the real registry: @mui/material has stable v5 + v9, but
  // @mui/lab only ever shipped 5.x as alpha prereleases (so an aligned v5 lab must
  // fall back to the newest alpha, not a non-existent stable 5.x).
  "@mui/material": { versions: ["5.14.0", "5.18.0", "6.0.0", "9.1.1"], latest: "9.1.1" },
  "@mui/lab": { versions: ["5.0.0-alpha.170", "5.0.0-alpha.173", "6.0.0-beta.1", "9.0.0-beta.5"], latest: "9.0.0-beta.5" },
  "@mui/icons-material": { versions: ["5.14.0", "5.18.0", "6.0.0", "9.1.1"], latest: "9.1.1" },
};
const fetcher: PackumentFetcher = async (name) => {
  const r = REGISTRY[name];
  if (!r) return null; // unknown package → registry "couldn't answer"
  const versions = new Set(r.versions);
  const stableByMajor = new Map<number, string>();
  for (const v of versions) {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) continue;
    const major = Number(m[1]);
    const cur = stableByMajor.get(major);
    const tup = (s: string) => s.split(".").map(Number) as [number, number, number];
    if (!cur || tup(v)[1] > tup(cur)[1] || (tup(v)[1] === tup(cur)[1] && tup(v)[2] > tup(cur)[2]))
      stableByMajor.set(major, v);
  }
  return { versions, stableByMajor, latest: r.latest };
};

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: "app", dependencies: deps, devDependencies: dev }, null, 2);

const run = (content: string, path = "package.json") =>
  repairDependencyVersions([{ path, content }], { fetcher });

// --- 1) The exact production failure: date-fns@^2.30.1 doesn't exist. ---
{
  const { files, repairs } = await run(pkg({ "date-fns": "^2.30.1" }));
  const fixed = JSON.parse(files[0].content).dependencies["date-fns"];
  check("hallucinated ^2.30.1 is repaired", repairs.length === 1, JSON.stringify(repairs));
  check("pinned to newest stable in same major (^2.30.0)", fixed === "^2.30.0", fixed);
}

// --- 2) Operator intent is preserved (~ stays ~). ---
{
  const { files } = await run(pkg({ "date-fns": "~2.99.0" }));
  check("~ pin stays ~ on repair", JSON.parse(files[0].content).dependencies["date-fns"] === "~2.30.0");
}

// --- 3) Whole-major hallucination falls back to dist-tag latest. ---
{
  const { files } = await run(pkg({ "date-fns": "^9.9.9" }));
  check("fictional major falls back to ^latest", JSON.parse(files[0].content).dependencies["date-fns"] === "^4.0.0");
}

// --- 4) Bare/exact/= pins normalize to ^ on repair. ---
{
  const { files } = await run(pkg({ react: "18.9.9" }));
  check("bare exact pin normalizes to ^realversion", JSON.parse(files[0].content).dependencies["react"] === "^18.3.1");
}

// --- 5) NO-OP on real versions, ranges, tags, urls, and devDependencies. ---
{
  const original = pkg(
    { "date-fns": "^2.30.0", react: "18.2.0", lodash: "^4.17.21", left: "*" },
    { vite: "latest", typescript: "git+https://github.com/x/y.git" },
  );
  const { files, repairs } = await run(original);
  check("strict no-op on a valid manifest", repairs.length === 0, JSON.stringify(repairs));
  check("manifest is byte-for-byte unchanged", files[0].content === original);
}

// --- 6) Never auto-pin to a prerelease (vite 6.0.0-beta.1 is not a target). ---
{
  const { files } = await run(pkg({ vite: "^6.1.0" }));
  // major 6 has only a prerelease → no stable in major → fall back to latest (5.4.0).
  check("prerelease-only major skips to stable latest", JSON.parse(files[0].content).dependencies["vite"] === "^5.4.0");
}

// --- 7) Unknown package (registry can't answer) is left untouched. ---
{
  const original = pkg({ "some-unpublished-pkg": "^9.9.9" });
  const { files, repairs } = await run(original);
  check("unknown package is fail-open (untouched)", repairs.length === 0 && files[0].content === original);
}

// --- 8) Nested monorepo manifest (frontend/package.json) is handled. ---
{
  const { files, repairs } = await run(pkg({ "date-fns": "^2.30.1" }), "frontend/package.json");
  check("nested package.json is repaired", repairs.length === 1 && repairs[0].file === "frontend/package.json");
  check("nested fix lands on the right file", JSON.parse(files[0].content).dependencies["date-fns"] === "^2.30.0");
}

// --- peer-family reconcile: the exact icms Vercel failure --------------------
const fam = (deps: Record<string, string>, path = "package.json") =>
  reconcilePeerFamilies([{ path, content: JSON.stringify({ name: "app", dependencies: deps }, null, 2) }], { fetcher });

// 9) @mui/lab@latest against a v5 app → aligned to the newest v5 alpha (no stable 5.x exists).
{
  const { files, repairs } = await fam({ "@mui/material": "^5.14.0", "@mui/lab": "latest" });
  const lab = JSON.parse(files[0].content).dependencies["@mui/lab"];
  check("@mui/lab latest aligned to material's major", repairs.length === 1 && repairs[0].pkg === "@mui/lab", JSON.stringify(repairs));
  check("aligned to newest v5 prerelease (^5.0.0-alpha.173)", lab === "^5.0.0-alpha.173", lab);
}

// 10) A wrong fixed major is realigned too (icons-material v9 against material v5).
{
  const { files } = await fam({ "@mui/material": "^5.18.0", "@mui/icons-material": "^9.1.1" });
  check("@mui/icons-material v9 realigned to v5 stable", JSON.parse(files[0].content).dependencies["@mui/icons-material"] === "^5.18.0");
}

// 11) NO-OP when the family is already coherent.
{
  const original = JSON.stringify({ name: "app", dependencies: { "@mui/material": "^5.14.0", "@mui/lab": "^5.0.0-alpha.170" } }, null, 2);
  const { repairs } = await reconcilePeerFamilies([{ path: "package.json", content: original }], { fetcher });
  check("coherent v5 family is a strict no-op", repairs.length === 0, JSON.stringify(repairs));
}

// 12) Satellite present but no anchor → untouched (can't infer a major).
{
  const { repairs } = await fam({ "@mui/lab": "latest" });
  check("satellite without its anchor is fail-open", repairs.length === 0, JSON.stringify(repairs));
}

console.log(fails === 0 ? "\nAll npm-version repair tests passed." : `\n${fails} test(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
