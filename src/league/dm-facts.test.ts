import { test, expect } from "bun:test";
import { checkFacts, resolveMentions, safeReply, splitSentences, type FactContext, type FactPlayer } from "./dm-facts.ts";
import type { TradeBrief } from "./dm-brief.ts";

// The league as the gate sees it. Roster 3 is ours, roster 1 is Cloud Nine
// (the manager we are talking to), roster 5 is a third party.
const P = (playerId: string, name: string, position: string, rosterId: number, onIr = false): FactPlayer =>
  ({ playerId, name, position, rosterId, onIr });
const PLAYERS: FactPlayer[] = [
  P("1", "Dak Prescott", "QB", 3), P("2", "Mark Andrews", "TE", 3), P("3", "Sam LaPorta", "TE", 3),
  P("4", "Nico Collins", "WR", 3), P("5", "Kenneth Walker", "RB", 3), P("6", "Chase Brown", "RB", 3),
  P("7", "A.J. Brown", "WR", 3, true), P("8", "Mike Evans", "WR", 3),
  P("11", "Ja'Marr Chase", "WR", 1), P("12", "Harold Fannin", "TE", 1), P("13", "Omarion Hampton", "RB", 1),
  P("14", "Quinshon Judkins", "RB", 1), P("15", "Jameson Williams", "WR", 1),
  P("21", "Bijan Robinson", "RB", 5), P("22", "Javonte Williams", "RB", 5), P("23", "Jordan Love", "QB", 5),
];
const TEAM: Record<number, string> = { 1: "Cloud Nine", 3: "CoachClaude", 5: "Third Wheel" };

const EMPTY: TradeBrief = { surplus: [], thin: [], askFor: [], deals: [], lastOffer: null, pendingFromUs: [] };
function ctx(over: Partial<FactContext> = {}, brief: Partial<TradeBrief> = {}): FactContext {
  const b = { ...EMPTY, ...brief };
  return {
    players: PLAYERS, ourRosterId: 3, theirRosterId: 1,
    teamName: (rid) => TEAM[rid] ?? `roster ${rid}`,
    brief: b,
    briefText: "Their most recent offer to you: you give Dak Prescott, you get Omarion Hampton. Your numbers: -42.3 season points to your lineup, +162.8 to theirs.",
    ...over,
  };
}

// --- name resolution ----------------------------------------------------------

test("a full name and an unambiguous surname both resolve to the roster", () => {
  const m = resolveMentions("Harold Fannin is fine but Hampton is the piece", PLAYERS);
  expect(m.map((x) => x.player.name)).toEqual(["Harold Fannin", "Omarion Hampton"]);
});

test("apostrophes and initials do not stop a match", () => {
  expect(resolveMentions("JaMarr Chase and AJ Brown", PLAYERS).map((x) => x.player.name)).toEqual(["Ja'Marr Chase", "A.J. Brown"]);
  expect(resolveMentions("Ja'Marr Chase", PLAYERS).map((x) => x.player.name)).toEqual(["Ja'Marr Chase"]);
});

test("an ambiguous surname is not resolved and not flagged", () => {
  // Two Williams in the league: the gate must not guess.
  expect(resolveMentions("Williams is the starter", PLAYERS)).toEqual([]);
  expect(checkFacts("I would give my Williams for anything", ctx())).toEqual([]);
  // Chase is both a surname (Ja'Marr) and a first name (Chase Brown).
  expect(resolveMentions("Chase is elite", PLAYERS)).toEqual([]);
});

test("a lowercase ordinary word that happens to be a surname is not a mention", () => {
  expect(resolveMentions("I love this deal", PLAYERS)).toEqual([]);
  expect(resolveMentions("Jordan Love is a QB", PLAYERS).map((x) => x.player.name)).toEqual(["Jordan Love"]);
});

test("sentences split on terminal punctuation only", () => {
  expect(splitSentences("Fair is A.J. Brown for Chase. Youre getting my WR1! Really?")).toEqual([
    "Fair is A.J. Brown for Chase.", "Youre getting my WR1!", "Really?",
  ]);
});

// --- possessive and direction frames ----------------------------------------

test("a rival's player claimed with my is a violation, the 2026-09-23 Fannin case", () => {
  // Word for word what went out at 14:31Z. At that moment the offer on the
  // table was you give Dak Prescott + Mark Andrews, you get Ja'Marr Chase +
  // Omarion Hampton + Harold Fannin. The reply flips the sides: it says the
  // rival is getting a WR and a TE from us, which is Chase and Fannin, who
  // are Cloud Nine's players.
  const reply = "Fair is Dak plus Andrews for Chase, Fannin, and Hampton. Youre getting my WR1 and my TE1 for a QB1 and a TE I have buried behind LaPorta, plus a bell cow at a position I already have five deep. Thats not charity, thats a real offer, send yours if you think Im wrong.";
  const v = checkFacts(reply, ctx({}, {
    pendingFromUs: [{ give: ["Dak Prescott", "Mark Andrews"], get: ["Ja'Marr Chase", "Omarion Hampton", "Harold Fannin"] }],
  }));
  expect(v.length).toBeGreaterThan(0);
  const text = v.map((x) => x.instruction).join("\n");
  expect(text).toContain("Harold Fannin");
  expect(text).toContain("Cloud Nine");
  expect(text).toContain("rewrite");
});

test("my plus their player, directly", () => {
  const v = checkFacts("I will send you my Fannin for Dak.", ctx());
  expect(v.some((x) => x.rule === "possessive" && x.player === "Harold Fannin")).toBe(true);
  expect(v[0]!.instruction).toBe("Harold Fannin is on Cloud Nine's roster, not yours; rewrite");
});

test("you get and I give frame our side; I get and you give frame theirs", () => {
  expect(checkFacts("You get Mark Andrews and I get Omarion Hampton.", ctx())).toEqual([]);
  expect(checkFacts("You get Omarion Hampton.", ctx()).map((x) => x.player)).toEqual(["Omarion Hampton"]);
  expect(checkFacts("I get Mark Andrews from you.", ctx()).map((x) => x.player)).toEqual(["Mark Andrews"]);
  expect(checkFacts("You give Mark Andrews.", ctx()).map((x) => x.player)).toEqual(["Mark Andrews"]);
});

test("a swap sentence reads the far side of for as the other roster", () => {
  expect(checkFacts("You get Dak Prescott and Nico Collins for Omarion Hampton and Harold Fannin.", ctx({}, {
    pendingFromUs: [{ give: ["Dak Prescott", "Nico Collins"], get: ["Omarion Hampton", "Harold Fannin"] }],
  }))).toEqual([]);
  expect(checkFacts("I give Nico Collins for Hampton.", ctx({}, {
    pendingFromUs: [{ give: ["Nico Collins"], get: ["Omarion Hampton"] }],
  }))).toEqual([]);
});

test("a third roster's player in a possessive frame is a violation either way", () => {
  const v1 = checkFacts("I would give you my Bijan Robinson for Fannin.", ctx());
  expect(v1.some((x) => x.rule === "third-party" && x.player === "Bijan Robinson")).toBe(true);
  expect(v1.find((x) => x.rule === "third-party")!.instruction).toContain("Third Wheel");
  const v2 = checkFacts("I want your Bijan Robinson.", ctx());
  expect(v2.some((x) => x.rule === "third-party")).toBe(true);
});

test("a football opinion about a third roster's player is not a trade claim", () => {
  expect(checkFacts("Bijan Robinson is the best back in football and it is not close.", ctx())).toEqual([]);
  expect(checkFacts("Jordan Love wins that one Sunday.", ctx())).toEqual([]);
});

test("our IR player offered in any trade frame is a violation", () => {
  const v = checkFacts("I give A.J. Brown for Harold Fannin.", ctx());
  expect(v.some((x) => x.rule === "ir" && x.player === "A.J. Brown")).toBe(true);
  // Talking about him outside a trade is fine.
  expect(checkFacts("A.J. Brown will be back before the playoffs.", ctx())).toEqual([]);
});

// --- numbers --------------------------------------------------------------------

test("a number next to points or a sign must appear in the brief", () => {
  expect(checkFacts("That is -42.3 to my lineup and +162.8 to yours.", ctx())).toEqual([]);
  const v = checkFacts("That swap is +7.2 points for you.", ctx());
  expect(v.map((x) => x.rule)).toEqual(["number"]);
  expect(v[0]!.instruction).toContain("7.2");
  expect(checkFacts("You gain 12 points a week.", ctx()).map((x) => x.rule)).toEqual(["number"]);
});

test("weeks, records and position labels are not point claims", () => {
  expect(checkFacts("You are 3-0 and your bye is week 7, so your RB2 starts in week 10.", ctx())).toEqual([]);
  expect(checkFacts("Weeks 1-18 are the whole season.", ctx())).toEqual([]);
});

// --- offers on the table ---------------------------------------------------------

test("an offer I say I sent must be one I actually have out", () => {
  const c = ctx({}, { pendingFromUs: [{ give: ["Dak Prescott", "Nico Collins"], get: ["Ja'Marr Chase", "Omarion Hampton"] }] });
  expect(checkFacts("I sent you Dak Prescott and Nico Collins for Hampton, it is in your inbox.", c)).toEqual([]);
  const v = checkFacts("I sent you Mark Andrews, check your inbox.", c);
  expect(v.map((x) => x.rule)).toEqual(["offer"]);
  expect(v[0]!.instruction).toContain("Mark Andrews");
});

test("an invented offer with nothing on the table is a violation", () => {
  const v = checkFacts("I sent you Dak Prescott for Hampton.", ctx());
  expect(v.map((x) => x.rule)).toEqual(["offer"]);
  expect(v[0]!.instruction).toContain("no offer");
});

test("a swap I say I would do must be a listed deal", () => {
  const c = ctx({}, { deals: [{ give: ["Mark Andrews (TE)"], get: ["Harold Fannin (TE)"], theirGain: 3 }] });
  expect(checkFacts("I would do Mark Andrews for Fannin today.", c)).toEqual([]);
  const v = checkFacts("I would do Mark Andrews for Hampton today.", c);
  expect(v.map((x) => x.rule)).toEqual(["deal"]);
});

test("a just-sent counter counts as an offer on the table", () => {
  const c = ctx({ justSent: { give: ["Nico Collins"], get: ["Harold Fannin"] } });
  expect(checkFacts("Just sent you Nico Collins for Fannin, it is in your inbox.", c)).toEqual([]);
});

test("a clean reply passes untouched", () => {
  const c = ctx({}, { pendingFromUs: [{ give: ["Dak Prescott", "Nico Collins"], get: ["Ja'Marr Chase", "Omarion Hampton"] }] });
  expect(checkFacts("Hampton is the piece I want and you know it. Dak Prescott and Nico Collins for Chase and Hampton is on the table, -42.3 for me by my numbers and I still sent it.", c)).toEqual([]);
  expect(checkFacts("Ha. Ask me again after Sunday.", c)).toEqual([]);
});

// --- the safe reply ------------------------------------------------------------

test("the safe reply is fixed text chosen by intent and never the draft", () => {
  expect(safeReply("trade", "x")).toBe("Send it as a real offer and I will grade it");
  const a = safeReply("chat", "msg-1");
  expect(a.length).toBeLessThan(60);
  expect(safeReply("chat", "msg-1")).toBe(a);
});
