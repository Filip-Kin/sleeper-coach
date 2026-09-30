// Taking a healed player off injured reserve.
//
// Sleeper does not do this for you. A player parked on IR while Out who is
// then listed Questionable is "no longer IR eligible", the roster is invalid,
// and every lineup write is refused until somebody moves him. On 2026-09-23
// that somebody was nobody: the coach could see the state (staleReserve) and
// had the write (updateReserve) and never connected the two, so the lineup
// guard failed every poll for a day. This is the connection.
//
// The decision is pure (planReserveActivation) and the rest is plumbing:
// when the active roster is full, one forced drop goes first, chosen over the
// FULL active roster the same way the over-cap path does; then the reserve
// list is rewritten without him and read back. Sleeper refuses reserve writes
// while any game of the week is in progress, and that is deferred silently
// until after the week's last game rather than retried every poll.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { staleReserve, reserveWritable, RESERVE_LOCKED_RE, type Settings } from "../sleeper/rules.ts";
import type { RosterView } from "../analysis/roster-view.ts";
import { activeCapacity } from "../analysis/roster-fit.ts";
import { DEFAULT_FAIRNESS, type FairnessConfig } from "../analysis/trade-fair.ts";
import { DEFAULT_RAILS, type RailConfig, type RailPlayer } from "../analysis/rails.ts";
import { activeRailRoster, chooseLegalForcedDrops, type LegalDrop } from "../analysis/reconcile-plan.ts";
import { snapshot, scheduleContext } from "../analysis/trade-wire.ts";
import { dropPlayers, updateReserve, myRosterView, currentStarters, type Gql } from "../league/api.ts";
import { railsWithPendingDrops, pendingClaimPlayers } from "./pending-claims.ts";
import { DropIntentStore, decideIntent } from "./drop-intent.ts";
import { DropRefused } from "../league/drop-ledger.ts";
import { weekGames } from "../blog/auto.ts";
import { freezeState } from "../killswitch.ts";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";
import { KICKOFF_CACHE } from "../paths.ts";

// #region pure
export interface ReserveDecision {
  playerId: string;
  name: string;
  injuryStatus: string | null;
  /** activate: take him off IR (with `drop` first when the roster is full).
   *  release: he is himself the least valuable body, so he is dropped instead.
   *  stuck: the rails allow no cut. */
  action: "activate" | "release" | "stuck";
  /** The forced drop that makes room, when the active roster is full. For
   *  "release" this is the IR player himself. */
  drop: LegalDrop | null;
  /** The reserve list to write (unused for "release": dropping him clears it). */
  reserveAfter: string[];
  reason: string;
}

/** One activation per call: the first stale reserve player.
 *
 *  THE RULE (Filip, 2026-09-30): when the roster is full, the player cut is
 *  the one worth least for the rest of the season, and the man coming off IR
 *  is a candidate like anyone else. On 09-30 this path cut Travis Etienne
 *  (RB26 rest-of-season) to make room for Rico Dowdle (RB32) because it only
 *  looked at active players and priced every bench player at zero. `keep`
 *  is this week's starters plus the drop side of any pending claim; those
 *  are never cut. `slotsHeld` is the number of active slots a pending claim
 *  with no drop will need. */
export function planReserveActivation(args: {
  view: RosterView; settings: Settings; cap: number; railRoster: RailPlayer[]; cfg: FairnessConfig; rails?: RailConfig;
  keep?: string[]; slotsHeld?: number;
}): ReserveDecision[] {
  const { view, settings, cap, railRoster, cfg } = args;
  const rails = args.rails ?? DEFAULT_RAILS;
  const keep = args.keep ?? [];
  const slotsHeld = args.slotsHeld ?? 0;
  const stale = staleReserve(view, settings);
  const e = stale[0];
  if (!e) return [];
  const status = e.injuryStatus ?? "healthy";
  const reserveAfter = view.reserve.map((r) => r.playerId).filter((id) => id !== e.playerId);
  const base = { playerId: e.playerId, name: e.name, injuryStatus: e.injuryStatus, reserveAfter };
  if (view.active.length + slotsHeld < cap) {
    return [{ ...base, action: "activate", drop: null, reason: `${e.name} is ${status}, not IR-eligible in this league; an active slot is free` }];
  }
  const full = activeRailRoster(view, railRoster);
  // The IR player as a cut candidate, valued like everyone else.
  const self = railRoster.find((p) => p.playerId === e.playerId);
  const selfRail: RailPlayer = self
    ? { ...self, onIr: false }
    : { playerId: e.playerId, name: e.name, position: e.position ?? "", points: 0, onIr: false, injuryStatus: e.injuryStatus ?? undefined };
  const union = [...full.filter((p) => p.playerId !== e.playerId), selfRail];
  const drop = chooseLegalForcedDrops(view, union, 1, cfg, rails, keep, new Set([e.playerId]))[0];
  if (!drop) {
    return [{ ...base, action: "stuck", drop: null, reason: `${e.name} is ${status}, not IR-eligible; the active roster is full and the rails allow no drop` }];
  }
  if (drop.playerId === e.playerId) {
    return [{ ...base, action: "release", drop, reason: `${e.name} is ${status}, not IR-eligible; the active roster is full and he is the least valuable body for the rest of the season (${Math.round(drop.cost)} points), so he is released rather than activated` }];
  }
  return [{ ...base, action: "activate", drop, reason: `${e.name} is ${status}, not IR-eligible; the active roster is full, so ${drop.name} goes (${drop.reason})` }];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How long after the week's last kickoff the reserve lock is assumed lifted. */
const GAME_MS = 4 * HOUR;

/** Per-player deferral and alert throttling. In memory: a restart simply
 *  retries once, which is harmless. */
export class ReserveDeferrals {
  private until = new Map<string, number>();
  private alerted = new Map<string, number>();
  /** Sleeper locked the reserve list for the week's games: wait for the last
   *  one to finish. With no kickoff cache, wait an hour and look again. */
  deferLocked(playerId: string, now: number, kickoffs: number[]): void {
    const last = kickoffs.length ? Math.max(...kickoffs) : 0;
    this.until.set(playerId, last > 0 ? Math.max(now + HOUR, last + GAME_MS) : now + HOUR);
  }
  deferFor(playerId: string, now: number, ms: number): void {
    this.until.set(playerId, now + ms);
  }
  deferred(playerId: string, now: number): boolean {
    return (this.until.get(playerId) ?? 0) > now;
  }
  clear(playerId: string): void {
    this.until.delete(playerId);
  }
  /** One alert per player per day, whatever the poll interval. */
  mayAlert(playerId: string, now: number): boolean {
    const last = this.alerted.get(playerId) ?? Number.NEGATIVE_INFINITY;
    if (now - last < DAY) return false;
    this.alerted.set(playerId, now);
    return true;
  }
}
// #endregion

// #region io
const deferrals = new ReserveDeferrals();
let heldLogged = 0;

async function cachedKickoffTimes(): Promise<number[]> {
  try {
    const f = Bun.file(KICKOFF_CACHE);
    if (!(await f.exists())) return [];
    const j = (await f.json()) as { games?: { startTime?: number }[] };
    return (j.games ?? []).map((g) => Number(g.startTime)).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export interface ReserveDeps {
  gql: Gql;
  tokenReady: () => Promise<boolean>;
  now?: number;
  /** Injected for tests; defaults to the live reads. */
  view?: RosterView;
  intents?: DropIntentStore;
}

/** One pass. Returns the decision acted on, or null when there was nothing to
 *  do or the work was deferred. Never throws for a Sleeper refusal. */
export async function reconcileReserve(deps: ReserveDeps): Promise<ReserveDecision | null> {
  const now = deps.now ?? Date.now();
  const league = await sleeper.league(config.leagueId);
  const view = deps.view ?? (await myRosterView());
  const stale = staleReserve(view, league.settings);
  const first = stale[0];
  if (!first) return null;
  if (deferrals.deferred(first.playerId, now)) return null;

  const froze = freezeState();
  if (froze.frozen) {
    if (now - heldLogged > HOUR) {
      heldLogged = now;
      logEvent("coach", "ir-activate-held", `${first.name} needs to come off IR but writes are frozen: ${froze.reason}`, { player: first.playerId });
    }
    return null;
  }
  if (!(await deps.tokenReady())) return null;

  // Sleeper refuses reserve writes while a game is in progress. Check before
  // dropping anyone, so a locked week does not cost a player for nothing. A
  // failed read is not a lock: proceed and let the write decide.
  const week = Math.max(1, (await sleeper.nflState()).week || 1);
  const games = await weekGames(week).catch(() => []);
  if (games.length && !reserveWritable(games)) {
    deferrals.deferLocked(first.playerId, now, games.map((g) => g.startTime));
    logEvent("coach", "ir-activate-deferred", `${first.name} needs to come off IR; Sleeper locks reserve until the week's games finish. Waiting.`, { player: first.playerId, week });
    return null;
  }

  const cap = activeCapacity(league.roster_positions);
  // Everything the cut must respect, read now: this week's starters (the
  // matchup leg), the drop side and slot needs of our pending claims, and
  // every player's rest-of-season value with live injury status.
  const snap = await snapshot();
  const railRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
  const cfg: FairnessConfig = { ...DEFAULT_FAIRNESS, ...(await scheduleContext(null)) };
  const starters = await currentStarters(deps.gql, week, []).catch(() => [] as string[]);
  // Names as the RAIL roster spells them (a defense is "SEA" there and
  // "Seattle Seahawks" in the view), since the chooser matches on rail names.
  const nameOf = new Map(railRoster.map((p) => [p.playerId ?? "", p.name]));
  const keep = starters.map((id) => nameOf.get(id)).filter((n): n is string => !!n);
  const pending = await pendingClaimPlayers(deps.gql, week).catch(() => ({ adds: [], drops: [], slotsNeeded: 0 }));
  const rails = railsWithPendingDrops(DEFAULT_FAIRNESS.rails, railRoster, pending.drops);
  const plan = planReserveActivation({ view, settings: league.settings, cap, railRoster, cfg, rails, keep, slotsHeld: pending.slotsNeeded })[0];
  if (!plan) return null;

  if (plan.action === "stuck") {
    logEvent("coach", "ir-activate-stuck", plan.reason, { player: plan.playerId });
    if (deferrals.mayAlert(plan.playerId, now)) {
      await sendAlert("Player stuck on IR", `${plan.reason}. Free a slot in Sleeper.`).catch(() => {});
    }
    deferrals.deferFor(plan.playerId, now, HOUR);
    return plan;
  }

  if (plan.drop) {
    // Two looks before the cut: the same decision from fresh data at least
    // MIN_AGE_MS apart. Nothing about an illegal roster is urgent at this
    // resolution, and every one of this month's bad drops was a single read.
    const intents = deps.intents ?? new DropIntentStore();
    const prefix = `ir-activate:${plan.playerId}:`;
    const key = `${prefix}${plan.action}:${plan.drop.playerId}`;
    const restarts = intents.settle(prefix, key, now);
    const gate = decideIntent(intents.get(key), now);
    if (gate.action === "record") {
      intents.put({ key, firstSeen: now, note: plan.reason });
      logEvent("coach", "ir-activate-intent", `Would ${plan.action === "release" ? "release" : `drop ${plan.drop.name} and activate`} ${plan.name}; confirming on a later look. ${plan.reason}`, { player: plan.playerId, drop: plan.drop.playerId, action: plan.action, restarts });
      if (restarts >= 3) {
        // The decision keeps changing between looks, so nothing ever confirms
        // and the roster stays illegal. That needs eyes, not more patience.
        logEvent("coach", "ir-activate-stuck", `${plan.name}: the cut decision has changed ${restarts} times without confirming; the roster stays illegal`, { player: plan.playerId, restarts });
        if (deferrals.mayAlert(plan.playerId, now)) await sendAlert("IR activation cannot settle", `${plan.name}: the cut decision keeps changing (${restarts} restarts). ${plan.reason}`).catch(() => {});
      }
      return null;
    }
    if (gate.action === "wait") return null;

    const via = plan.action === "release" ? "ir-release" : "ir-activate";
    try {
      await dropPlayers(deps.gql, [plan.drop.playerId], config.rosterId, config.leagueId, via);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DropRefused) {
        logEvent("coach", "ir-activate-deferred", `Drop of ${plan.drop.name} for ${plan.name} refused by the breaker: ${err.verdict.reason}`, { player: plan.playerId, drop: plan.drop.playerId });
        return null;
      }
      logEvent("coach", "ir-activate-failed", `Could not drop ${plan.drop.name} for ${plan.name}: ${msg}`, { player: plan.playerId, drop: plan.drop.playerId });
      if (deferrals.mayAlert(plan.playerId, now)) await sendAlert("IR activation failed", `${plan.reason}. The drop failed: ${msg}`).catch(() => {});
      deferrals.deferFor(plan.playerId, now, HOUR);
      return null;
    }
    intents.delete(key);
    if (plan.action === "release") {
      const after = await myRosterView();
      if (after.ownedIds.has(plan.playerId)) {
        logEvent("coach", "ir-activate-failed", `Released ${plan.name} but he is still on the roster after read-back`, { player: plan.playerId });
        deferrals.deferFor(plan.playerId, now, HOUR);
        return null;
      }
      logEvent("coach", "ir-released", `${plan.name} released from injured reserve. ${plan.reason}.`, { player: plan.playerId, injuryStatus: plan.injuryStatus, reserve: after.reserve.map((e) => e.playerId), active: after.active.length });
      deferrals.clear(plan.playerId);
      return plan;
    }
  }

  try {
    const back = await updateReserve(deps.gql, plan.reserveAfter, config.rosterId, config.leagueId);
    if (back.includes(plan.playerId)) throw new Error(`write echoed ${plan.playerId} still on reserve`);
    const after = await myRosterView();
    if (after.reserveIds.has(plan.playerId)) throw new Error(`read-back still has ${plan.name} on reserve`);
    logEvent("coach", "ir-activated", `${plan.name} taken off injured reserve. ${plan.reason}.`, {
      player: plan.playerId, injuryStatus: plan.injuryStatus, drop: plan.drop ? { playerId: plan.drop.playerId, name: plan.drop.name, cost: plan.drop.cost } : null,
      reserve: after.reserve.map((e) => e.playerId), active: after.active.length,
    });
    deferrals.clear(plan.playerId);
    return plan;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (RESERVE_LOCKED_RE.test(msg)) {
      deferrals.deferLocked(plan.playerId, now, await cachedKickoffTimes());
      logEvent("coach", "ir-activate-deferred", `${plan.name}: Sleeper locks reserve until the week's games finish. Waiting.`, { player: plan.playerId });
      return null;
    }
    logEvent("coach", "ir-activate-failed", `Could not take ${plan.name} off IR: ${msg}`, { player: plan.playerId });
    if (deferrals.mayAlert(plan.playerId, now)) await sendAlert("IR activation failed", `${plan.name} is ${plan.injuryStatus ?? "healthy"} and stuck on IR: ${msg}`).catch(() => {});
    deferrals.deferFor(plan.playerId, now, HOUR);
    return null;
  }
}
// #endregion
