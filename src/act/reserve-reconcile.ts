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
import { dropPlayers, updateReserve, myRosterView, type Gql } from "../league/api.ts";
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
  action: "activate" | "stuck";
  /** The forced drop that makes room, when the active roster is full. */
  drop: LegalDrop | null;
  /** The reserve list to write. */
  reserveAfter: string[];
  reason: string;
}

/** One activation per call: the first stale reserve player, with a drop when
 *  the active roster is at the cap. A second stale player waits for the next
 *  poll, because each activation changes the roster the next decision needs
 *  and the drop breaker allows one automatic drop an hour anyway. */
export function planReserveActivation(args: {
  view: RosterView; settings: Settings; cap: number; railRoster: RailPlayer[]; cfg: FairnessConfig; rails?: RailConfig;
}): ReserveDecision[] {
  const { view, settings, cap, railRoster, cfg } = args;
  const rails = args.rails ?? DEFAULT_RAILS;
  const stale = staleReserve(view, settings);
  const e = stale[0];
  if (!e) return [];
  const status = e.injuryStatus ?? "healthy";
  const reserveAfter = view.reserve.map((r) => r.playerId).filter((id) => id !== e.playerId);
  const base = { playerId: e.playerId, name: e.name, injuryStatus: e.injuryStatus, reserveAfter };
  if (view.active.length < cap) {
    return [{ ...base, action: "activate", drop: null, reason: `${e.name} is ${status}, not IR-eligible in this league; an active slot is free` }];
  }
  const full = activeRailRoster(view, railRoster);
  const drop = chooseLegalForcedDrops(view, full, 1, cfg, rails)[0];
  if (!drop) {
    return [{ ...base, action: "stuck", drop: null, reason: `${e.name} is ${status}, not IR-eligible; the active roster is full and the rails allow no drop` }];
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
  let railRoster: RailPlayer[] = [];
  let cfg: FairnessConfig = DEFAULT_FAIRNESS;
  if (view.active.length >= cap) {
    const snap = await snapshot();
    railRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
    cfg = { ...DEFAULT_FAIRNESS, ...(await scheduleContext(null)) };
  }
  const plan = planReserveActivation({ view, settings: league.settings, cap, railRoster, cfg, rails: DEFAULT_FAIRNESS.rails })[0];
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
    try {
      await dropPlayers(deps.gql, [plan.drop.playerId], config.rosterId, config.leagueId, "ir-activate");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DropRefused) {
        // The breaker decided. Not a failure: the next poll after the cooldown tries again.
        logEvent("coach", "ir-activate-deferred", `Drop of ${plan.drop.name} to activate ${plan.name} refused by the breaker: ${err.verdict.reason}`, { player: plan.playerId, drop: plan.drop.playerId });
        return null;
      }
      logEvent("coach", "ir-activate-failed", `Could not drop ${plan.drop.name} to activate ${plan.name}: ${msg}`, { player: plan.playerId, drop: plan.drop.playerId });
      if (deferrals.mayAlert(plan.playerId, now)) await sendAlert("IR activation failed", `${plan.reason}. The drop failed: ${msg}`).catch(() => {});
      deferrals.deferFor(plan.playerId, now, HOUR);
      return null;
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
