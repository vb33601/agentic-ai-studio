/**
 * Post-deploy release verification: per-provider status mapping + the poll state
 * machine (terminal detection + timeout), exercised without the network.
 *
 *   npx tsx scripts/test-verify-release.mts
 */
import {
  mapFlyState, mapRenderState, mapRailwayState, mapVercelState,
  pollUntilLive, type ReleaseStatus,
} from "../src/lib/deploy/verify-release";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// ── Fly mapping ──
check("fly: live when deployed + a machine started",
  mapFlyState({ status: "deployed", deployed: true, releases: { nodes: [{ status: "complete" }] } }, [{ state: "started" }]).state === "live");
check("fly: failed when a release failed",
  mapFlyState({ status: "pending", deployed: false, releases: { nodes: [{ status: "failed" }] } }, []).state === "failed");
{
  const s = mapFlyState({ status: "pending", deployed: false, releases: { nodes: [] } }, []);
  check("fly: pending + 'no release / CI build' hint when 0 releases (the menu-app case)",
    s.state === "pending" && /CI build/i.test(s.hint ?? ""), JSON.stringify(s));
}

// ── Render / Railway / Vercel mapping ──
check("render: live", mapRenderState({ status: "live" }).state === "live");
check("render: failed on build_failed", mapRenderState({ status: "build_failed" }).state === "failed");
check("render: pending while building", mapRenderState({ status: "build_in_progress" }).state === "pending");
check("railway: live on SUCCESS", mapRailwayState({ status: "SUCCESS" }).state === "live");
check("railway: failed on CRASHED", mapRailwayState({ status: "CRASHED" }).state === "failed");
check("railway: pending on BUILDING", mapRailwayState({ status: "BUILDING" }).state === "pending");
check("vercel: live on READY", mapVercelState({ readyState: "READY" }).state === "live");
check("vercel: failed on ERROR", mapVercelState({ readyState: "ERROR" }).state === "failed");
check("vercel: pending on BUILDING", mapVercelState({ readyState: "BUILDING" }).state === "pending");

// ── Poll state machine (injected clock + sleep; no real time) ──
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
const st = (state: ReleaseStatus["state"], hint?: string): ReleaseStatus => ({ provider: "fly", state, detail: state, hint });

{ // resolves to live after a couple of pending polls
  const seq = [st("pending"), st("pending"), st("live")];
  let i = 0;
  const c = clock();
  const r = await pollUntilLive(async () => seq[i++], { timeoutMs: 180_000, intervalMs: 6_000, ...c });
  check("poll: returns live once the release goes live", r.state === "live");
  check("poll: stops polling at the terminal state", i === 3, `made ${i} calls`);
}
{ // a failure is terminal immediately
  let calls = 0;
  const c = clock();
  const r = await pollUntilLive(async () => { calls++; return st("failed", "boom"); }, { timeoutMs: 180_000, intervalMs: 6_000, ...c });
  check("poll: returns failed without extra polling", r.state === "failed" && calls === 1);
}
{ // never goes live → timeout with an actionable hint
  const c = clock();
  const r = await pollUntilLive(async () => st("pending"), { timeoutMs: 20_000, intervalMs: 6_000, ...c });
  check("poll: converts a stuck pending into timeout", r.state === "timeout");
  check("poll: timeout carries a hint", !!r.hint && /check the provider/i.test(r.hint));
}

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL VERIFY-RELEASE TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
