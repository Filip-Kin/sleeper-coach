import { canDrop, isUpgrade, chooseDrop, DEFAULT_RAILS, type RailPlayer } from "./rails.ts";

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

// 5. A marginal upgrade is refused; a clear one is allowed.
const marginal: RailPlayer = { name: "Marginal Guy", position: "RB", points: 90 };
const clear: RailPlayer = { name: "Clear Upgrade", position: "RB", points: 170 };
t("refuses a tie/marginal upgrade", !isUpgrade(marginal, "Bo Nix", roster).allowed);
t("allows a clear upgrade", isUpgrade(clear, "Bo Nix", roster).allowed);

// 6. chooseDrop picks the worst LEGAL player, never the stash.
const chosen = chooseDrop(clear, roster);
t("chooseDrop returns a candidate", chosen !== null);
t("chooseDrop never picks the injured stash", chosen?.name !== "Breece Hall", String(chosen?.name));
console.log(`        -> would drop ${chosen?.name}: ${chosen?.reason}`);

// 7. With nothing worth upgrading, chooseDrop returns null rather than forcing one.
const weak: RailPlayer = { name: "Weak Pickup", position: "RB", points: 50 };
t("chooseDrop returns null when no drop is justified", chooseDrop(weak, roster) === null);

// 8. never-drop overrides projection entirely.
const cfg = { ...DEFAULT_RAILS, neverDrop: ["Bo Nix"] };
t("never-drop list overrides projection", !canDrop("Bo Nix", roster, cfg).allowed);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
