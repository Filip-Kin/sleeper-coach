import { planOne, planWaivers, bestClaim, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import type { RailPlayer } from "./rails.ts";

// Offline tests for the waiver engine. These pin the two things that matter
// most: it prices moves in WAIVER PRIORITY (a costless free-agent add beats
// burning a queue position; a marginal player is never worth going last for),
// and it never routes around the rails (the injured playoff stash cannot be
// dropped to make room, even when the roster is full and he has the lowest
// number on the team).

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];

// A full 16-man roster with ROS projections. 12 real, then fringe. Breece Hall
// is the injured-but-returns stash: the lowest number on the team and the one
// the rails must protect.
const roster: RailPlayer[] = [
  { name: "Jahmyr Gibbs", position: "RB", points: 320 },
  { name: "Nico Collins", position: "WR", points: 280 },
  { name: "Derrick Henry", position: "RB", points: 250 },
  { name: "Jayden Daniels", position: "QB", points: 340 },
  { name: "Colston Loveland", position: "TE", points: 180 },
  { name: "Jayden Reed", position: "WR", points: 200 },
  { name: "Garrett Wilson", position: "WR", points: 210 },
  { name: "Chris Olave", position: "WR", points: 190 },
  { name: "Bhayshul Tuten", position: "RB", points: 150 },
  { name: "David Montgomery", position: "RB", points: 160 },
  { name: "Rhamondre Stevenson", position: "RB", points: 140 },
  { name: "Josh Downs", position: "WR", points: 130 },
  { name: "Kenny Gainwell", position: "RB", points: 90 },
  { name: "Bo Nix", position: "QB", points: 85 },
  { name: "Tyler Bass", position: "K", points: 130 },
  { name: "Breece Hall", position: "RB", points: 40, injuryStatus: "IR", returnsBeforePlayoffs: true },
];

const full: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS };
const withBench: RosterState = { roster, openBenchSlots: 1, openIrSlots: 0, startingSlots: SLOTS };

const avail = (name: string, position: string, points: number, onWaivers: boolean): AvailablePlayer =>
  ({ name, position, points, onWaivers });

// 1. A cleared free agent who is a clear upgrade and there is an open bench slot:
//    costless free-add, no drop.
const clearedStud = avail("Cleared Stud", "WR", 260, false);
const m1 = planOne(clearedStud, withBench, DEFAULT_WAIVERS);
t("cleared clear-upgrade with open bench = free-add, no drop", m1.kind === "free-add" && m1.drop === null, `${m1.kind}/${m1.drop}`);

// 2. The SAME player, but he is still ON WAIVERS and would start for us: worth a
//    priority burn. On a full roster he needs a legal drop, which the rails pick
//    (never the stash).
const onWaiversStud = avail("Waivers Stud", "WR", 260, true);
const m2 = planOne(onWaiversStud, full, DEFAULT_WAIVERS);
t("on-waivers starter-level upgrade = waiver-claim", m2.kind === "waiver-claim", m2.kind);
t("the claim's drop is never the injured stash", m2.drop !== "Breece Hall", String(m2.drop));
t("the claim starts for us", m2.startsForUs === true);

// 3. A marginal streamer still on waivers is NOT worth a priority burn: wait for
//    him to clear and free-add. This is the whole point of rolling priority.
const streamer = avail("Streamer Kicker", "K", 138, true); // beats Bass by only 8 ROS
const m3 = planOne(streamer, full, DEFAULT_WAIVERS);
t("marginal on-waivers streamer = wait, not claim", m3.kind === "wait", `${m3.kind} (${m3.reason})`);

// 4. On a full roster, a cleared player who does NOT improve the starting lineup
//    is skipped, not churned in: dropping a bench body for a non-starter is not a
//    clear upgrade and risks cutting someone who matters. And whatever happens,
//    the injured stash is never the drop target.
const modest = avail("Modest WR", "WR", 145, false); // cleared, but never cracks our lineup
const m4 = planOne(modest, full, DEFAULT_WAIVERS);
t("full-roster non-lineup-improving add is skipped, drops nobody", m4.kind === "skip" && m4.drop === null, `${m4.kind}/${m4.drop}`);
t("full-roster add never proposes dropping the stash", m4.drop !== "Breece Hall", `${m4.kind}/${m4.drop}`);

// 4b. THE cross-position trap (regression for the draft-night capped-position
//     bug): a high-ROS backup QB is available, but he never starts over our
//     starting QB, and dropping our only kicker (or anyone) to roster him does
//     not improve the lineup. The engine must SKIP, never propose dropping the
//     kicker for a third QB just because 250 > 130 on raw points.
const backupQb = avail("Backup QB", "QB", 250, false); // huge raw ROS, but redundant
const m4b = planOne(backupQb, full, DEFAULT_WAIVERS);
t("never drops a needed player to roster a redundant high-ROS position", m4b.kind === "skip", `${m4b.kind}/${m4b.drop} (${m4b.reason})`);
t("the redundant-QB skip never targets the kicker", m4b.drop !== "Tyler Bass", String(m4b.drop));

// 5. A player who beats nobody by the margin is skipped, not forced.
const junk = avail("Junk Guy", "RB", 50, false);
const m5 = planOne(junk, full, DEFAULT_WAIVERS);
t("a non-upgrade is skipped", m5.kind === "skip", `${m5.kind} (${m5.reason})`);

// 6. An IR-stash path: full bench but an open IR slot and an injured incumbent.
//    Adding a cleared player should stash the injured player on IR (no drop)
//    rather than cut anyone. Breece Hall is IR-eligible.
const withIr: RosterState = { roster, openBenchSlots: 0, openIrSlots: 1, startingSlots: SLOTS };
const m6 = planOne(avail("Depth WR", "WR", 175, false), withIr, DEFAULT_WAIVERS);
t("open IR slot stashes the injured incumbent instead of dropping", m6.dropPath === "ir-stash" && m6.drop === null, `${m6.dropPath}/${m6.drop}`);

// 7. Only ONE claim per cycle: planWaivers ranks free-adds first, then the best
//    claim, and bestClaim returns exactly one (or none). Going to the back of
//    the queue is a once-per-run cost.
const board: AvailablePlayer[] = [
  avail("Waivers Stud", "WR", 260, true), // claim-worthy
  avail("Waivers RB1", "RB", 245, true), // also claim-worthy, smaller gain
  avail("Cleared Stud", "WR", 255, false), // costless free-add
  avail("Streamer Kicker", "K", 138, true), // wait
  avail("Junk Guy", "RB", 50, false), // skip (dropped)
];
const planned = planWaivers(board, full, DEFAULT_WAIVERS);
t("planWaivers drops the skips", planned.every((m) => m.kind !== "skip") && planned.length === 4, String(planned.length));
t("free-add is ranked ahead of claims", planned[0]?.kind === "free-add", planned[0]?.kind);
const claim = bestClaim(planned);
t("bestClaim returns exactly the single best claim", claim?.kind === "waiver-claim" && claim.add === "Waivers Stud", `${claim?.add}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
