// The fact gate. Pure and deterministic: a DM draft goes in with the league as
// the brief knew it, violations come out, and nothing here talks to a model or
// the network. It sits between cleanReply and sendDm.
//
// Why it exists. On 2026-09-23 at 14:31Z the coach told a rival "Youre getting
// my WR1 and my TE1", meaning Ja'Marr Chase and Harold Fannin, who were the
// RIVAL'S players in an offer we had sent him. The model had the full brief in
// front of it and still flipped the sides. A prompt instruction cannot prevent
// that; a check that resolves every name to a roster and reads the frame it
// sits in can. Same for numbers (a made-up "+7.2 points") and for offers that
// were never sent ("check your inbox").
//
// What it checks, per sentence:
//   1. Every full name and every unambiguous surname or first name resolves to a
//      roster. Two Williams in the league means "Williams" resolves to nobody
//      and is never flagged; the gate does not guess.
//   2. Possessive and direction frames. "my", "I give", "you get" put a player
//      on OUR side; "your", "you give", "I get" put him on THEIRS. A player on
//      the wrong side is a violation. A third roster's player in any possessive
//      frame is a violation. Our IR player in any trade frame is a violation.
//      In a swap sentence ("A for B") the far side of "for" is the other roster.
//   3. Every numeral next to points/pts or carrying a sign must appear
//      literally in the brief. Weeks, W-L records and position labels (RB2)
//      are exempt.
//   4. A sentence that says an offer was sent must describe an offer we have
//      out (or just sent); one that says we would do a swap must describe a
//      listed deal; a bare "A for B" swap must equal an offer on the table.
//
// The instructions it returns are written for the model: one line each, the
// fact and the word "rewrite", so a regeneration can be asked for verbatim.

import type { TradeBrief } from "./dm-brief.ts";

export interface FactPlayer { playerId: string; name: string; position: string; rosterId: number; onIr: boolean }
export interface FactContext {
  players: FactPlayer[];
  ourRosterId: number;
  theirRosterId: number | null;
  teamName: (rosterId: number) => string;
  brief: TradeBrief;
  briefText: string;
  /** A counter sent during this very reply, so "it is in your inbox" is true. */
  justSent?: { give: string[]; get: string[] } | null;
}
export type Rule = "possessive" | "third-party" | "ir" | "number" | "offer" | "deal";
export interface Violation { rule: Rule; player?: string; sentence: string; instruction: string }
export interface Mention { player: FactPlayer; index: number; how: "full" | "surname" | "first"; comparison: boolean }

// #region text
function normWord(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
export function normName(name: string): string {
  return name.split(/\s+/).map(normWord).filter(Boolean).join(" ");
}
function nameParts(name: string): string[] {
  return name.split(/[\s]+/).map(normWord).filter(Boolean);
}

interface Tok { raw: string; norm: string; cap: boolean; endsSentence: boolean }
function tokens(s: string): Tok[] {
  return s.split(/\s+/).filter(Boolean).map((raw) => {
    const core = raw.replace(/^[^A-Za-z0-9+-]+/, "").replace(/[^A-Za-z0-9.]+$/, "");
    return { raw, norm: normWord(core), cap: /^[A-Z]/.test(core), endsSentence: /[.!?]["')]*$/.test(raw) };
  });
}

const ABBREV = new Set(["st", "jr", "sr", "mr", "mrs", "dr", "vs", "etc"]);
/** Sentence boundaries on . ! ? followed by whitespace, except after an initial
 *  (A.J.) or a common abbreviation (St.). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["')]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(start, m.index);
    const lastWord = before.split(/\s+/).pop() ?? "";
    if (/^([A-Z]\.)*[A-Z]$/.test(lastWord) || ABBREV.has(lastWord.toLowerCase().replace(/\.$/, ""))) continue;
    out.push(text.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}
// #endregion

// #region names
/** Words that are also ordinary English, only trusted as a name mid-sentence
 *  with a capital. Sentence-initial "Will" or "Chase" is not a player. */
const WORD_NAMES = new Set(["will", "chase", "mark", "drake", "jordan", "tank", "van", "rome", "ray", "hunter", "grant", "jack", "max", "cam", "cade",
  "cook", "hill", "love", "rice", "brown", "walker", "smith", "hall", "pierce", "london", "young", "bell", "ward", "fields", "white", "green", "gray",
  "king", "bill", "rob", "don", "art", "josh", "joe", "sam", "ben", "dan", "tom", "bo", "pitts", "moss", "banks", "lamb", "burden", "tate", "evans"]);
/** A name right after one of these is a comparison, not a trade piece:
 *  "buried behind LaPorta", "better than Bijan". */
const COMPARATIVE = new Set(["behind", "than", "like", "over", "under", "ahead", "versus", "vs", "with", "without", "beside", "unlike", "after", "before", "above", "below", "past"]);

export function resolveMentions(text: string, players: FactPlayer[]): Mention[] {
  const toks = tokens(text);
  const used = new Array<boolean>(toks.length).fill(false);
  const out: Mention[] = [];
  const named = players.filter((p) => p.position !== "DEF");
  const isComparison = (i: number) => {
    const p1 = toks[i - 1]?.norm ?? "", p2 = toks[i - 2]?.norm ?? "";
    return COMPARATIVE.has(p1) || (COMPARATIVE.has(p2) && (p1 === "of" || p1 === "the" || p1 === "a"));
  };
  // Full names first, longest first so "Amon-Ra St. Brown" beats "A.J. Brown".
  const full = named.map((p) => ({ p, parts: nameParts(p.name) })).filter((x) => x.parts.length >= 2).sort((a, b) => b.parts.length - a.parts.length);
  for (const { p, parts } of full) {
    for (let i = 0; i + parts.length <= toks.length; i++) {
      if (used[i]) continue;
      let ok = true;
      for (let k = 0; k < parts.length; k++) if (toks[i + k]!.norm !== parts[k]) { ok = false; break; }
      if (!ok) continue;
      for (let k = 0; k < parts.length; k++) used[i + k] = true;
      out.push({ player: p, index: i, how: "full", comparison: isComparison(i) });
    }
  }
  // Single tokens: unique across surnames and first names together.
  const byToken = new Map<string, Set<FactPlayer>>();
  for (const { p, parts } of full) {
    for (const key of [parts[0]!, parts[parts.length - 1]!]) {
      if (key.length < 3) continue;
      (byToken.get(key) ?? byToken.set(key, new Set()).get(key)!).add(p);
    }
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (used[i] || !t.cap || t.norm.length < 3) continue;
    const cands = byToken.get(t.norm);
    if (!cands || cands.size !== 1) continue;
    const sentenceInitial = i === 0 || toks[i - 1]!.endsSentence;
    if (sentenceInitial && WORD_NAMES.has(t.norm)) continue;
    const p = [...cands][0]!;
    used[i] = true;
    out.push({ player: p, index: i, how: nameParts(p.name)[0] === t.norm ? "first" : "surname", comparison: isComparison(i) });
  }
  return out.sort((a, b) => a.index - b.index);
}
// #endregion

// #region frames
type Side = "ours" | "theirs";
const STRONG_OURS = /\b(i (give|send|offer|ship|move|am sending|am giving|am offering|would give|will give|can give|could give|would send|will send|can send|could send|would ship|will ship)|id (give|send|ship)|ill (give|send|ship)|you (get|receive|take|are getting|would get|will get|would receive|would be getting|are receiving|would take)|youre getting|youd get|youll get|youd be getting|from me|off my)\b/;
const STRONG_THEIRS = /\b(you (give|send|offer|ship|move|are sending|are giving|are offering|would give|will give|can give|could give|would send|will send|can send|could send)|youd (give|send|ship)|youll (give|send|ship)|i (get|want|take|receive|am getting|would get|will get|would take|would receive|am taking)|im getting|id (get|take)|ill take|from you|off your)\b/;
const WEAK_OURS = /\b(i (have|hold|own|keep|start|am starting|already have)|on my (roster|team|bench|side|end)|mine)\b/;
const WEAK_THEIRS = /\b(you (have|hold|own|keep|start|are starting|already have)|on your (roster|team|bench|side|end)|yours)\b/;
const TRADE_CTX = /\b(trade|trades|offer|offers|deal|swap|package|counter|for|send|sent|give|gives|get|gets|take|takes|receive|accept|inbox)\b/;
const OUR_OFFER = /\b(i (sent|have sent|offered|have offered|proposed|have proposed|put)|ive (sent|offered|proposed)|my offer|the offer i|in your inbox|is out to you|already sent|just sent|i have out|is on the table|on the table)\b/;
const THEIR_OFFER = /\b(you (sent|have sent|offered|have offered|proposed|put)|youve (sent|offered|proposed)|your offer|the offer you|what you sent)\b/;
const ACCEPT = /\b(i (would|will|can|could) (do|accept|take|make|sign off on)|id (do|accept|take)|ill (do|accept|take)|i accept|done deal|thats a deal|you have a deal|youve got a deal|i am in|im in|works for me|lets do (it|that|this))\b/;
const POS_LABEL = /^(qb|rb|wr|te|k|def|dst)\d?$/;

function normSentence(s: string): string {
  return s.toLowerCase().replace(/['’]/g, "");
}

interface Clause { toks: Tok[]; offset: number; frame: Side | "mixed" | null; positions: Set<string> }

function localFrame(text: string, tradeCtx: boolean): Side | "mixed" | null {
  const n = normSentence(text);
  const o = STRONG_OURS.test(n) || (tradeCtx && WEAK_OURS.test(n));
  const t = STRONG_THEIRS.test(n) || (tradeCtx && WEAK_THEIRS.test(n));
  return o && t ? "mixed" : o ? "ours" : t ? "theirs" : null;
}
const invert = (s: Side | "mixed" | null): Side | null => (s === "ours" ? "theirs" : s === "theirs" ? "ours" : null);

function positionsIn(toks: Tok[]): Set<string> {
  const out = new Set<string>();
  for (const t of toks) if (POS_LABEL.test(t.norm)) out.add(t.norm.replace(/\d$/, "").toUpperCase().replace("DST", "DEF"));
  return out;
}

/** Break a sentence into the clauses the frame rules read. A swap sentence
 *  splits at its first "for" that has names or position labels on both sides;
 *  the far side inherits the inverse frame unless it carries its own. A
 *  sentence with both frames and no "for" splits on commas and conjunctions. */
function clausesOf(toks: Tok[], mentionIdx: Set<number>, tradeCtx: boolean): { clauses: Clause[]; swap: boolean } {
  const text = (ts: Tok[]) => ts.map((t) => t.raw).join(" ");
  const hasPiece = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (mentionIdx.has(i) || POS_LABEL.test(toks[i]!.norm)) return true;
    return false;
  };
  for (let i = 1; i < toks.length - 1; i++) {
    if (toks[i]!.norm !== "for") continue;
    if (!hasPiece(0, i) || !hasPiece(i + 1, toks.length)) continue;
    const left = toks.slice(0, i), right = toks.slice(i + 1);
    let lf = localFrame(text(left), true), rf = localFrame(text(right), true);
    if (lf === null) lf = invert(rf);
    if (rf === null) rf = invert(lf);
    return { swap: true, clauses: [
      { toks: left, offset: 0, frame: lf, positions: positionsIn(left) },
      { toks: right, offset: i + 1, frame: rf, positions: positionsIn(right) },
    ] };
  }
  const whole = localFrame(text(toks), tradeCtx);
  if (whole !== "mixed") return { swap: false, clauses: [{ toks, offset: 0, frame: whole, positions: positionsIn(toks) }] };
  const clauses: Clause[] = [];
  let start = 0;
  const flush = (end: number) => {
    if (end > start) { const ts = toks.slice(start, end); clauses.push({ toks: ts, offset: start, frame: localFrame(text(ts), tradeCtx), positions: positionsIn(ts) }); }
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (["and", "but", "while"].includes(t.norm) && !/[,;]$/.test(toks[i - 1]?.raw ?? "")) { flush(i); start = i + 1; }
    else if (/[,;:]$/.test(t.raw)) { flush(i + 1); start = i + 1; }
  }
  flush(toks.length);
  return { swap: false, clauses };
}

/** "my X" / "your X" within two tokens before, or "X is mine/yours" after. */
function adjacentPossessive(toks: Tok[], i: number): Side | null {
  const before = [toks[i - 1]?.norm, toks[i - 2]?.norm];
  const after = [toks[i + 1]?.norm, toks[i + 2]?.norm];
  if (before.includes("my") || after.includes("mine")) return "ours";
  if (before.includes("your") || after.includes("yours")) return "theirs";
  return null;
}
// #endregion

// #region offers
interface OfferSet { label: string; give: Set<string>; get: Set<string>; giveNames: string[]; getNames: string[] }
function stripPos(s: string): string { return s.replace(/\s*\([A-Z]+\)\s*$/, ""); }
function offerSet(label: string, give: string[], get: string[]): OfferSet {
  const g = give.map(stripPos), r = get.map(stripPos);
  return { label, give: new Set(g.map(normName)), get: new Set(r.map(normName)), giveNames: g, getNames: r };
}
function knownOffers(ctx: FactContext): { ours: OfferSet[]; theirs: OfferSet[]; deals: OfferSet[] } {
  const ours = ctx.brief.pendingFromUs.map((o) => offerSet("your offer to them, still open", o.give, o.get));
  if (ctx.justSent) ours.push(offerSet("the offer you just sent them", ctx.justSent.give, ctx.justSent.get));
  const theirs = ctx.brief.lastOffer ? [offerSet("their most recent offer to you", ctx.brief.lastOffer.give, ctx.brief.lastOffer.get)] : [];
  const deals = ctx.brief.deals.map((d, i) => offerSet(`listed deal ${i + 1}`, d.give, d.get));
  return { ours, theirs, deals };
}
// #endregion

// #region numbers
const NUMERAL = /\d+(?:\.\d+)?/g;
function briefNumbers(brief: string): Set<string> {
  return new Set(brief.match(NUMERAL) ?? []);
}
function numberClaims(sentence: string): string[] {
  const s = sentence
    .replace(/\b\d+-\d+\b/g, " ")                       // records 3-0, ranges 1-18
    .replace(/\b(week|weeks|wk)\s*\d+\b/gi, " ")         // week 7
    .replace(/\b(qb|rb|wr|te|k|def|dst)\d\b/gi, " ")     // RB2
    .replace(/\b\d+(st|nd|rd|th)\b/gi, " ")              // 1st
    .replace(/\b\d+\s*(am|pm)\b/gi, " ")                 // 2am
    .replace(/\b(19|20)\d\d\b/g, " ");                   // years
  const out: string[] = [];
  for (const m of s.matchAll(/[+-]\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)(?:\s+\w+){0,2}\s+(?:points?|pts?)\b/gi)) out.push(m[1] ?? m[2] ?? "");
  return out.filter(Boolean);
}
// #endregion

// #region the gate
export function checkFacts(reply: string, ctx: FactContext): Violation[] {
  const possessive: Violation[] = [], offers: Violation[] = [], numbers: Violation[] = [];
  const known = knownOffers(ctx);
  const allSets = [...known.ours, ...known.theirs, ...known.deals];
  const posOf = new Map(ctx.players.map((p) => [normName(p.name), p.position]));
  const playerByNorm = new Map(ctx.players.map((p) => [normName(p.name), p]));
  const allowed = briefNumbers(ctx.briefText);

  const where = (p: FactPlayer): string =>
    p.rosterId === ctx.ourRosterId ? "your roster" : `${ctx.teamName(p.rosterId)}'s roster`;
  const describe = (s: OfferSet) =>
    `you give ${s.giveNames.map((n) => `${n} (${posOf.get(normName(n)) ?? "?"})`).join(" + ") || "nothing"}, you get ${s.getNames.map((n) => `${n} (${posOf.get(normName(n)) ?? "?"})`).join(" + ") || "nothing"}`;

  for (const sentence of splitSentences(reply)) {
    const toks = tokens(sentence);
    const mentions = resolveMentions(sentence, ctx.players);
    const mentionIdx = new Set(mentions.map((m) => m.index));
    const n = normSentence(sentence);
    const ourOffer = OUR_OFFER.test(n), theirOffer = THEIR_OFFER.test(n), accept = ACCEPT.test(n);
    const tradeCtx = TRADE_CTX.test(n) || ourOffer || theirOffer || accept;
    const { clauses, swap } = clausesOf(toks, mentionIdx, tradeCtx);
    const anyFrame = clauses.some((c) => c.frame !== null);
    const tradeFrame = anyFrame || swap || ourOffer || theirOffer || accept;

    // 2. possessive and direction frames, per mention
    for (const m of mentions) {
      const clause = clauses.find((c) => m.index >= c.offset && m.index < c.offset + c.toks.length);
      const adj = adjacentPossessive(toks, m.index);
      const frame: Side | null = adj ?? (clause && clause.frame !== "mixed" ? clause.frame : null);
      const p = m.player;
      const ours = p.rosterId === ctx.ourRosterId, theirs = p.rosterId === ctx.theirRosterId;
      if (ours && p.onIr && tradeFrame) {
        possessive.push({ rule: "ir", player: p.name, sentence, instruction: `${p.name} is on your injured reserve and cannot be traded; do not offer him; rewrite` });
        continue;
      }
      if (!frame) continue;
      if (!ours && !theirs) {
        possessive.push({ rule: "third-party", player: p.name, sentence, instruction: `${p.name} is on ${ctx.teamName(p.rosterId)}'s roster, not yours or theirs; rewrite` });
      } else if (frame === "ours" && theirs) {
        possessive.push({ rule: "possessive", player: p.name, sentence, instruction: `${p.name} is on ${ctx.teamName(p.rosterId)}'s roster, not yours; rewrite` });
      } else if (frame === "theirs" && ours) {
        possessive.push({ rule: "possessive", player: p.name, sentence, instruction: `${p.name} is on your roster, not theirs; rewrite` });
      }
    }

    // 4. offers on the table
    const pieces = mentions.filter((m) => !m.comparison);
    const names = new Set(pieces.map((m) => normName(m.player.name)));
    const labelsBothSides = swap && clauses.every((c) => c.positions.size > 0 || pieces.some((m) => m.index >= c.offset && m.index < c.offset + c.toks.length));
    let candidates: OfferSet[] | null = null, rule: Rule = "offer", exact = false;
    if (ourOffer) candidates = known.ours;
    else if (theirOffer) candidates = known.theirs;
    else if (accept) { candidates = [...known.deals, ...known.ours]; rule = "deal"; }
    else if (swap && (names.size > 0 || (labelsBothSides && anyFrame))) { candidates = allSets; exact = true; }
    if (candidates && (names.size > 0 || (swap && labelsBothSides && anyFrame))) {
      const loosely = (name: string) => nameParts(name).some((part) => part.length >= 3 && toks.some((t) => t.norm === part));
      const satisfies = (s: OfferSet): boolean => {
        const all = new Set([...s.give, ...s.get]);
        for (const x of names) if (!all.has(x)) return false;
        if (exact) for (const x of all) if (!names.has(x) && !loosely(x)) return false;
        for (const c of clauses) {
          if (c.frame !== "ours" && c.frame !== "theirs") continue;
          const side = c.frame === "ours" ? s.give : s.get;
          const sidePos = new Set([...side].map((x) => posOf.get(x) ?? "?"));
          for (const m of pieces) if (m.index >= c.offset && m.index < c.offset + c.toks.length && !side.has(normName(m.player.name))) return false;
          if (swap) for (const pos of c.positions) if (!sidePos.has(pos)) return false;
        }
        return true;
      };
      if (!candidates.some(satisfies)) {
        const namedPlayers = pieces.map((m) => m.player);
        const wherePart = namedPlayers.length
          ? namedPlayers.map((p) => `${p.name} is on ${where(p)}`).join("; ") + ". "
          : "";
        if (!candidates.length) {
          const stated = rule === "deal" ? "there is no swap you would accept with this manager" : "there is no offer on the table between you";
          offers.push({ rule, sentence, instruction: `${wherePart}${stated[0]!.toUpperCase()}${stated.slice(1)}, so do not describe one; invite a real offer instead; rewrite` });
        } else {
          const best = candidates.map((s) => ({ s, hit: [...names].filter((x) => s.give.has(x) || s.get.has(x)).length })).sort((a, b) => b.hit - a.hit)[0]!.s;
          const theirPieces = best.getNames.filter((x) => playerByNorm.get(normName(x))?.rosterId !== ctx.ourRosterId);
          const theirLine = ctx.theirRosterId !== null && theirPieces.length
            ? ` ${theirPieces.join(", ")} ${theirPieces.length === 1 ? "is" : "are"} ${ctx.teamName(ctx.theirRosterId)}'s, not yours.`
            : "";
          offers.push({ rule, sentence, instruction: `${wherePart}That is not ${rule === "deal" ? "a swap you would accept" : "an offer on the table"}. The nearest real one (${best.label}): ${describe(best)}.${theirLine} Describe only that, with the sides the right way round; rewrite` });
        }
      }
    }

    // 3. numbers
    for (const num of numberClaims(sentence)) {
      if (allowed.has(num)) continue;
      numbers.push({ rule: "number", sentence, instruction: `The number ${num} is not in your brief; use only numbers the brief gives you, or give no number; rewrite` });
    }
  }
  return [...possessive, ...offers, ...numbers];
}

const CHAT_SAFE = [
  "Ha. Ask me again after Sunday.",
  "Noted. Back to football.",
  "Not biting on that one.",
  "Good chat. See you on the scoreboard.",
];
/** The fixed reply when two drafts both failed. Never the draft. */
export function safeReply(intent: "trade" | "chat", seed: string): string {
  if (intent === "trade") return "Send it as a real offer and I will grade it";
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHAT_SAFE[h % CHAT_SAFE.length]!;
}
// #endregion
