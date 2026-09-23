// The judgement step between "the engine found offers" and "one goes out".
//
// The engine (trade-fair.ts) values a roster by its best starting lineup, so a
// player who never starts for us is worth nothing to it. That is right for the
// acceptor's floor and wrong as a reason to SEND: on 2026-09-23 it wanted to
// give away Dak Prescott (a 304-point QB2 we keep as injury cover) plus two
// bench receivers for a Questionable Barkley who would not start for us either,
// and it ranked that above the one offer that actually added two starters.
// Filip: "it should make the claude agent decide which one makes most sense to
// actually send and only send that one."
//
// So the engine produces a shortlist, one best candidate per rival, with the
// numbers a manager would look at, and the model picks one or none. The
// deterministic gates stay in front of the send: fairness, rails, the two-pass
// intent gate, the open-offer cap, the cooldown. The model only ever narrows.
// Anything but a clean answer means nothing is sent.

import { bestLineup, samePlayer, type TradePlayer } from "../analysis/trade.ts";
import type { Proposal } from "../analysis/trade-fair.ts";
import { runAgent, type RunOptions, type RunResult } from "../agent/runner.ts";

/** Same model and effort as the DM bot unless overridden. Not imported from
 *  dm-watch.ts, which imports the proposer and would cycle. */
export const PICK_MODEL = process.env.PICK_MODEL ?? process.env.DM_MODEL ?? "claude-opus-5-5";
export const PICK_EFFORT = process.env.PICK_EFFORT ?? process.env.DM_EFFORT ?? "medium";
/** Most rivals shown to the model in one pass. */
export const PICK_MAX = 4;

export interface PickCandidate {
  proposal: Proposal;
  /** Our best lineup by rest-of-season points, before and after. */
  lineupBefore: number;
  lineupAfter: number;
  /** Rest-of-season points received minus given, bench included. */
  rawDelta: number;
  startersAfter: string[];
  headToHeadRemaining: number;
}

export interface PickResult {
  chosen: PickCandidate | null;
  why: string;
  /** Set when the model run failed or answered in a shape we refused. */
  error?: string;
}

// #region shortlist
/** One candidate per rival, in the order given (the caller sorts by score),
 *  at most PICK_MAX. */
export function shortlist(
  ourRoster: TradePlayer[],
  candidates: Proposal[],
  h2h: (managerId: string) => number,
  max = PICK_MAX,
): PickCandidate[] {
  const seen = new Set<string>();
  const out: PickCandidate[] = [];
  const before = bestLineup(ourRoster);
  for (const p of candidates) {
    if (seen.has(p.managerId)) continue;
    seen.add(p.managerId);
    const after = ourRoster.filter((x) => !p.offer.give.some((g) => samePlayer(g, x))).concat(p.offer.receive);
    const lineupAfter = bestLineup(after);
    const sum = (ps: TradePlayer[]) => ps.reduce((s, x) => s + x.points, 0);
    out.push({
      proposal: p,
      lineupBefore: before.total,
      lineupAfter: lineupAfter.total,
      rawDelta: sum(p.offer.receive) - sum(p.offer.give),
      startersAfter: lineupAfter.starters.map((s) => s.player?.name ?? "(empty)"),
      headToHeadRemaining: h2h(p.managerId),
    });
    if (out.length >= max) break;
  }
  return out;
}
// #endregion

// #region brief
const r0 = (n: number) => String(Math.round(n));
const r1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
function playerLine(p: TradePlayer): string {
  const bits = [p.position, `${r0(p.points)} season pts`, p.injuryStatus ?? "healthy"];
  if (p.bye) bits.push(`bye ${p.bye}`);
  if (p.onIr) bits.push("on IR");
  return `${p.name} (${bits.join(", ")})`;
}

export function pickBrief(cands: PickCandidate[], ourRoster: TradePlayer[]): string {
  const starters = new Set(bestLineup(ourRoster).starters.map((s) => s.player?.name));
  const roster = [...ourRoster].sort((a, b) => b.points - a.points)
    .map((p) => `  ${starters.has(p.name) ? "*" : " "} ${playerLine(p)}`).join("\n");
  const blocks = cands.map((c, i) => {
    const p = c.proposal;
    return [
      `${i + 1}. To ${p.teamName} (${c.headToHeadRemaining} head-to-head games left against them)`,
      `   Give: ${p.offer.give.map(playerLine).join("; ")}`,
      `   Get:  ${p.offer.receive.map(playerLine).join("; ")}`,
      `   Our best lineup: ${r0(c.lineupBefore)} -> ${r0(c.lineupAfter)} season points`,
      `   Starters after: ${c.startersAfter.join(", ")}`,
      `   Season points swapped, bench included: ${c.rawDelta >= 0 ? "+" : ""}${r0(c.rawDelta)} for us`,
      `   Engine, bye-aware lineup gain: ours +${r1(p.ourGain)}, theirs +${r1(p.theirGain)}`,
      `   Their side: ${p.theirReason || "no positional reason found"}`,
    ].join("\n");
  });
  return `OUR ROSTER (* = current best-lineup starter)\n${roster}\n\nCANDIDATE OFFERS\n${blocks.join("\n\n")}`;
}

export const PICK_SYSTEM = `You are CoachClaude, the manager of a fantasy football team in an 8-team full-PPR league. Once a week you may send at most ONE trade offer. Below is a shortlist the trade engine built: its best candidate for each rival, with the numbers. Decide which one, if any, is actually worth sending.

Judge like a good manager, not like the engine:
- The engine values a roster only by its best starting lineup, so it prices bench players at zero. Do not accept that. A strong QB2 or RB depth is injury cover and trade capital, and giving it away for a marginal lineup bump is a bad trade.
- An offer is worth sending when the players we GET start for us and improve the lineup by a real margin, and the players we GIVE are surplus we can afford to lose.
- A two-for-one where the one does not start for us is a giveaway. A Questionable or injured player coming to us is a risk, not a discount.
- Season points swapped is a sanity check: a large negative number means we are paying a lot of total value; it needs a large lineup gain to justify.
- The rival must plausibly say yes. That is already roughly enforced; do not send something insulting.
- When nothing is clearly good, send nothing. Nothing is a fine answer and usually the right one.

Answer with ONE line of JSON and nothing else: {"pick": N, "why": "one sentence"} where N is the candidate number, or 0 to send nothing.`;

export const PICK_PROMPT = (brief: string) => `${brief}\n\nWhich candidate, if any, do we send this week?`;
// #endregion

// #region parse
export interface ParsedPick { index: number | null; why: string }
/** Strict: the first {...} in the text must parse and "pick" must be an
 *  integer in [0, n]. Anything else is null and the caller sends nothing. */
export function parsePick(text: string, n: number): ParsedPick | null {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let obj: unknown;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const pick = (obj as { pick?: unknown }).pick;
  const why = String((obj as { why?: unknown }).why ?? "").trim();
  if (typeof pick !== "number" || !Number.isInteger(pick) || pick < 0 || pick > n) return null;
  return { index: pick === 0 ? null : pick - 1, why };
}
// #endregion

// #region run
export type PickRunner = (opts: RunOptions) => Promise<RunResult>;

/** Ask the model. Tool-free and under the untrusted settings so a text-only
 *  decision can never become an action (see runner.ts on why tools: [] alone
 *  is not enough). */
export async function pickOne(cands: PickCandidate[], ourRoster: TradePlayer[], run: PickRunner = runAgent): Promise<PickResult> {
  if (!cands.length) return { chosen: null, why: "no candidates" };
  const res = await run({
    prompt: PICK_PROMPT(pickBrief(cands, ourRoster)),
    untrusted: true,
    extraSystemPrompt: PICK_SYSTEM,
    tools: [],
    partial: false,
    model: PICK_MODEL,
    effort: PICK_EFFORT,
  });
  if (res.error) return { chosen: null, why: "model run failed; nothing sent", error: res.error };
  const parsed = parsePick(res.text, cands.length);
  if (!parsed) return { chosen: null, why: "model answer was not a clean pick; nothing sent", error: `unparsed: ${res.text.slice(0, 200)}` };
  return { chosen: parsed.index === null ? null : cands[parsed.index]!, why: parsed.why || (parsed.index === null ? "model chose to send nothing" : "model picked it") };
}
// #endregion
