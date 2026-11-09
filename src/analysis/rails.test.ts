import { canDrop, DEFAULT_RAILS, type RailPlayer } from "./rails.ts";

// A realistic 16-man roster: 12 good, 4 fringe.
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

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

// 1. A top player is untouchable.
const gibbs = canDrop("Jahmyr Gibbs", roster);
t("refuses to drop the best player", !gibbs.allowed, gibbs.reason);

// 2. The injured stash is protected even though its projection is the lowest.
const hall = canDrop("Breece Hall", roster);
t("protects the injured stash despite the worst projection", !hall.allowed, hall.reason);
console.log(`        -> ${hall.reason}`);

// 3. A genuine fringe player is droppable.
const nix = canDrop("Bo Nix", roster);
t("allows dropping a fringe player", nix.allowed, nix.reason);

// 4. An unknown name is refused rather than guessed at.
const ghost = canDrop("Someone Notonroster", roster);
t("refuses a name that is not on the roster", !ghost.allowed, ghost.reason);

// 8. never-drop overrides projection entirely.
const cfg = { ...DEFAULT_RAILS, neverDrop: ["Bo Nix"] };
t("never-drop list overrides projection", !canDrop("Bo Nix", roster, cfg).allowed);

// 9. The never-drop list carries its reason when it has one (2026-11-09).
const why = canDrop("Bo Nix", roster, { ...cfg, neverDropWhy: { "bo nix": "he is a leg of our live trade 42 (proposed)" } });
t("a held name is refused with the transaction that holds him", !why.allowed && why.reason.includes("live trade 42"), why.reason);

// 10. A leg of a live trade of ours, flagged on the trade snapshot, is refused
// with the DM-safe reason (no transaction, no manager named).
const legged = roster.map((p) => (p.name === "Bo Nix" ? { ...p, tradeGive: "42" } : p));
const leg = canDrop("Bo Nix", legged);
t("a trade leg is not given or cut", !leg.allowed && leg.reason.includes("committed to a pending roster move") && !leg.reason.includes("42"), leg.reason);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
