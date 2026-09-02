// The league votes on trades between other managers. veto_auto_poll is on and
// veto_votes_needed is 4, so a trade between, say, cookieeater45 and Owen sits
// in review for two days and any member, us included, can vote to veto it.
//
// TWO DELIBERATE POSITIONS.
//
// 1. THE DEFAULT IS ALLOW, AND ALLOW REQUIRES NO ACTION. A veto needs four
//    votes to pass, so doing nothing lets a trade through. That is correct
//    almost always: vetoing other people's fair trades is the most trust-
//    destroying thing a bot can do in a league, and a "lopsided" trade is
//    usually just a rebuilding team selling to a contender, which is legitimate.
//    The coach polices collusion, not trades it merely dislikes.
//
// 2. WE DO NOT CAST A VETO VOTE BLIND. There is no veto-specific mutation, and
//    no veto poll is attached to a pending trade that we can read, so the exact
//    mechanism cannot be verified without a live between-others trade to watch.
//    A vote is public and irreversible, so until the mechanism is observed the
//    coach EVALUATES and ALERTS, and a human casts any actual veto. This is the
//    one trade action left in a human's hands, on purpose.
//
// The judgement here is neutral collusion detection: is one side being fleeced
// so badly, in favour of a real threat to us, that it looks like a dump rather
// than a deal?

import type { TradePlayer } from "../analysis/trade.ts";
import { bestLineup } from "../analysis/trade.ts";

export interface ReviewTrade {
  transactionId: string;
  rosterIds: number[];
  /** player_id -> roster receiving; used only to split the two sides. */
  adds: Record<string, number>;
  drops: Record<string, number>;
}

export type VetoVerdict = "allow" | "flag";

export interface VetoAssessment {
  verdict: VetoVerdict;
  /** Points each side's starting lineup gains, keyed by roster id. */
  gain: Record<number, number>;
  reason: string;
}

/** How lopsided a trade must be before it even looks like a dump. A team can
 *  legitimately sell its season for future value, so this is deliberately
 *  extreme: one side must GAIN a lot while the other gains essentially nothing
 *  or loses ground. */
export interface VetoConfig {
  /** The winner must gain at least this much starting-lineup value. */
  lopsidedWinnerPts: number;
  /** ...while the loser gains no more than this (negative = actively worse). */
  lopsidedLoserPts: number;
  /** Roster ids we consider real threats: only a dump TO one of these is worth
   *  flagging, because a dump to a cellar-dweller does not change our race. */
  threats: number[];
}

export const DEFAULT_VETO: VetoConfig = {
  lopsidedWinnerPts: 40,
  lopsidedLoserPts: 5,
  threats: [],
};

function sideGain(
  roster: TradePlayer[], incoming: TradePlayer[], outgoing: TradePlayer[],
): number {
  const out = new Set(outgoing.map((p) => p.name.toLowerCase()));
  const before = bestLineup(roster).total;
  const after = bestLineup([...roster.filter((p) => !out.has(p.name.toLowerCase())), ...incoming]).total;
  return Math.round((after - before) * 10) / 10;
}

/** Assess a between-others trade. `rosterOf`/`playerOf` come from the live
 *  snapshot. Pure so the collusion call is tested rather than trusted. */
export function assessVeto(
  tx: ReviewTrade,
  rosterOf: Map<number, TradePlayer[]>,
  playerOf: (id: string) => TradePlayer,
  cfg: VetoConfig = DEFAULT_VETO,
): VetoAssessment {
  const gain: Record<number, number> = {};
  for (const rid of tx.rosterIds) {
    const incoming = Object.entries(tx.adds).filter(([, r]) => r === rid).map(([id]) => playerOf(id));
    const outgoing = Object.entries(tx.drops).filter(([, r]) => r === rid).map(([id]) => playerOf(id));
    gain[rid] = sideGain(rosterOf.get(rid) ?? [], incoming, outgoing);
  }
  const sorted = [...tx.rosterIds].sort((a, b) => (gain[b] ?? 0) - (gain[a] ?? 0));
  const winner = sorted[0];
  const loser = sorted[sorted.length - 1];
  if (winner === undefined || loser === undefined || winner === loser) {
    return { verdict: "allow", gain, reason: "not a two-sided trade" };
  }
  const w = gain[winner] ?? 0;
  const l = gain[loser] ?? 0;

  const lopsided = w >= cfg.lopsidedWinnerPts && l <= cfg.lopsidedLoserPts;
  const toThreat = cfg.threats.includes(winner);
  if (lopsided && toThreat) {
    return {
      verdict: "flag",
      gain,
      reason: `roster ${winner} gains ${w} while roster ${loser} gains ${l}; the winner is a team we are chasing, so this looks like a dump worth a human eye`,
    };
  }
  if (lopsided) {
    return { verdict: "allow", gain, reason: `lopsided (+${w} vs ${l}) but the winner, roster ${winner}, is not a threat to us, so not our fight` };
  }
  return { verdict: "allow", gain, reason: `fair enough: +${w} vs ${l >= 0 ? "+" : ""}${l}` };
}
