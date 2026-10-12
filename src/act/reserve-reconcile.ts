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
//
// A seat held for a pending no-drop claim is NOT a full roster (2026-10-07).
// Fourteen active, two on IR, two claims pending with no drop: Dowdle flipped
// Out -> Questionable at 03:07 ET, eight minutes before the waiver run, and
// this path counted the two held seats as taken and recorded "drop
// Croskey-Merritt (96 rest-of-season) and activate Dowdle" for its second
// look. The Bengals claim then lost at 03:15 and the second look found a free
// seat, so nobody was cut; had the run been slow the cut would have gone out
// at 03:37 for a claim that failed anyway. A drop is a player gone for the
// season; a claim is a maybe (we are last in the order). So the returning man
// takes any physically free seat with no drop, and the claims that no longer
// have a seat are cancelled, lowest rest-of-season value first (the rental
// before the season body). The planner refiles a claim as a swap on its next
// run if the add is worth a drop; that drop is then conditional on the claim
// landing, which is the only kind of drop a claim may cause.
//
// A full roster is not yet a cut (2026-10-12). Sixteen active, Smith (Out)
// and Etienne (IR) on reserve, Dowdle Out on the bench: when Smith's tag
// lifted this path went straight to the cheapest legal cut, the Jaguars that
// day and Jake Bates (K2 on the season) once Tuesday's stream had swapped the
// Jaguars out. Filip's rule: an IR slot is a roster expansion. A bench man
// who qualifies for IR under the league's flags (waivers.ts stashCandidates:
// not a starter, not a claim's drop, not never-drop, longest absence first)
// takes the returning man's reserve seat in the same write, and nobody is
// cut for the season. The forced cut is only for a roster with nobody to
// stash.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { staleReserve, reserveWritable, irEligible, RESERVE_LOCKED_RE, type Settings } from "../sleeper/rules.ts";
import type { RosterView } from "../analysis/roster-view.ts";
import { activeCapacity, keptStarters } from "../analysis/roster-fit.ts";
import { loadStartableThisWeek } from "../analysis/week-projections.ts";
import { stashCandidates } from "../analysis/waivers.ts";
import { DEFAULT_FAIRNESS, type FairnessConfig } from "../analysis/trade-fair.ts";
import { DEFAULT_RAILS, type RailConfig, type RailPlayer } from "../analysis/rails.ts";
import { activeRailRoster, chooseLegalForcedDrops, type LegalDrop } from "../analysis/reconcile-plan.ts";
import { snapshot, scheduleContext } from "../analysis/trade-wire.ts";
import { dropPlayers, updateReserve, myRosterView, currentStarters, cancelWaiverClaim, type Gql } from "../league/api.ts";
import { railsWithPendingDrops, pendingClaimPlayers, claimsToCancel, type PendingClaim, type HeldClaim } from "./pending-claims.ts";
export { claimsToCancel, type HeldClaim } from "./pending-claims.ts";
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
  /** The forced drop that makes room, when the active roster is full and
   *  nobody can be stashed. For "release" this is the IR player himself. */
  drop: LegalDrop | null;
  /** The active player who takes the reserve seat instead of a cut, when the
   *  roster is full and he qualifies for IR. He is in `reserveAfter`. */
  stash: { playerId: string; name: string; injuryStatus: string | null } | null;
  /** The reserve list to write (unused for "release": dropping him clears it). */
  reserveAfter: string[];
  /** Our pending no-drop claims that have no seat once he is active, lowest
   *  value first. Cancelled after the move; never a reason to cut anyone. */
  cancel: HeldClaim[];
  reason: string;
}

/** One activation per call: the first stale reserve player.
 *
 *  THE RULE (Filip, 2026-09-30): when the roster is full and nobody can
 *  take the reserve seat (2026-10-12, `stash`), the player cut is the one
 *  worth least for the rest of the season, and the man coming off IR is a
 *  candidate like anyone else. On 09-30 this path cut Travis Etienne
 *  (RB26 rest-of-season) to make room for Rico Dowdle (RB32) because it only
 *  looked at active players and priced every bench player at zero. `keep`
 *  is this week's starters plus the drop side of any pending claim; those
 *  are never cut, except a starting kicker or defense with a better body
 *  behind him who can take the slot this week (`canFill`, roster-fit.ts
 *  keptStarters): the rental is the cut, not the better body.
 *
 *  `heldClaims` are our pending claims with no drop. A seat one of them
 *  holds is still a free seat for the returning man (2026-10-07): the claim
 *  is a maybe, the drop would be for the season. Whatever claims are left
 *  without a seat are cancelled, cheapest first, never traded for a cut. */
export function planReserveActivation(args: {
  view: RosterView; settings: Settings; cap: number; railRoster: RailPlayer[]; cfg: FairnessConfig; rails?: RailConfig;
  keep?: string[]; heldClaims?: HeldClaim[]; canFill?: (body: RailPlayer, starter: RailPlayer) => boolean;
}): ReserveDecision[] {
  const { view, settings, cap, railRoster, cfg } = args;
  const rails = args.rails ?? DEFAULT_RAILS;
  const held = args.heldClaims ?? [];
  const stale = staleReserve(view, settings);
  const e = stale[0];
  if (!e) return [];
  const status = e.injuryStatus ?? "healthy";
  const reserveAfter = view.reserve.map((r) => r.playerId).filter((id) => id !== e.playerId);
  const base = { playerId: e.playerId, name: e.name, injuryStatus: e.injuryStatus, reserveAfter };
  if (view.active.length < cap) {
    // He takes the seat. Seats left over after him stay with the claims; the
    // rest of the claims go, cheapest first.
    const cancel = claimsToCancel(held, cap - view.active.length - 1);
    const note = cancel.length ? `; ${cancel.map((c) => `the claim for ${c.names.join(" + ")} no longer has a seat and is cancelled`).join("; ")}` : "";
    return [{ ...base, action: "activate", drop: null, stash: null, cancel, reason: `${e.name} is ${status}, not IR-eligible in this league; an active slot is free${note}` }];
  }
  // Physically full: after the move the roster is at the cap, so every held
  // seat is gone whichever way the seat is found.
  const cancel = claimsToCancel(held, 0);
  const note = cancel.length ? `; ${cancel.map((c) => `the claim for ${c.names.join(" + ")} has no seat and is cancelled`).join("; ")}` : "";
  const full = activeRailRoster(view, railRoster);
  // THE SEAT FIRST (Filip, BRIEF: an IR slot is a roster expansion). An
  // active player who qualifies for IR takes the seat the returning man
  // leaves, in the same reserve write; nobody is cut. The one stash filter
  // the waiver run uses: the league's flags, never a current starter, never
  // a pending claim's drop (on the never-drop rail), longest absence first
  // (a man the NFL parked holds the seat; a one-week Out flips to
  // Questionable by Thursday and the seat is needed again). A starter whose
  // own tag qualifies for IR is not a starter here: he scores nothing, and
  // the lineup guard cannot bench him while the stale IR man makes every
  // lineup write illegal (this path runs first), so holding him in the leg
  // would send the cut path after Bates.
  const eligible = (st: string | null | undefined): boolean => irEligible(st, settings);
  const parked = new Set(full.filter((p) => eligible(p.injuryStatus)).map((p) => p.name.toLowerCase()));
  const playingStarters = (args.keep ?? []).filter((n) => !parked.has(n.toLowerCase()));
  const stashable = stashCandidates({ roster: full, irEligible: eligible, currentStarters: playingStarters }, { rails })[0];
  if (stashable?.playerId) {
    const stash = { playerId: stashable.playerId, name: stashable.name, injuryStatus: stashable.injuryStatus ?? null };
    return [{ ...base, action: "activate", drop: null, stash, reserveAfter: [...reserveAfter, stash.playerId], cancel, reason: `${e.name} is ${status}, not IR-eligible; the active roster is full and ${stash.name} (${stash.injuryStatus ?? "injured"}) qualifies for injured reserve, so he takes the seat and nobody is cut${note}` }];
  }
  const keep = keptStarters(args.keep ?? [], full, args.canFill ?? (() => false));
  // The IR player as a cut candidate, valued like everyone else.
  const self = railRoster.find((p) => p.playerId === e.playerId);
  const selfRail: RailPlayer = self
    ? { ...self, onIr: false }
    : { playerId: e.playerId, name: e.name, position: e.position ?? "", points: 0, onIr: false, injuryStatus: e.injuryStatus ?? undefined };
  const union = [...full.filter((p) => p.playerId !== e.playerId), selfRail];
  const drop = chooseLegalForcedDrops(view, union, 1, cfg, rails, keep, new Set([e.playerId]))[0];
  if (!drop) {
    return [{ ...base, action: "stuck", drop: null, stash: null, cancel: [], reason: `${e.name} is ${status}, not IR-eligible; the active roster is full and the rails allow no drop` }];
  }
  if (drop.playerId === e.playerId) {
    return [{ ...base, action: "release", drop, stash: null, cancel, reason: `${e.name} is ${status}, not IR-eligible; the active roster is full and he is the least valuable body for the rest of the season (${Math.round(drop.cost)} points), so he is released rather than activated${note}` }];
  }
  return [{ ...base, action: "activate", drop, stash: null, cancel, reason: `${e.name} is ${status}, not IR-eligible; the active roster is full, nobody qualifies for injured reserve, so ${drop.name} goes (${drop.reason})${note}` }];
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

/** Cancel the claims the plan left without a seat. After the roster move, so
 *  legality never waits on this write; a cancel that fails costs nothing
 *  (Sleeper fails a no-drop claim into a full roster on its own) and is
 *  logged so the review sees it. */
async function cancelHeldClaims(gql: Gql, plan: ReserveDecision): Promise<void> {
  for (const c of plan.cancel) {
    const who = c.names.join(" + ");
    try {
      const status = await cancelWaiverClaim(gql, c.transactionId, c.leg);
      logEvent("coach", "claim-cancelled", `Waiver claim for ${who} cancelled: no seat once ${plan.name} is off injured reserve.`, { transactionId: c.transactionId, leg: c.leg, adds: c.adds, value: c.value, status, player: plan.playerId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("coach", "claim-cancel-failed", `Could not cancel the waiver claim for ${who}: ${msg}. It has no seat; if it is still pending it fails at processing.`, { transactionId: c.transactionId, leg: c.leg, adds: c.adds, player: plan.playerId });
    }
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
  const state = await sleeper.nflState();
  const week = Math.max(1, state.week || 1);
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
  const pending = await pendingClaimPlayers(deps.gql, week).catch(() => ({ adds: [], drops: [], slotsNeeded: 0, claims: [] as PendingClaim[] }));
  const rails = railsWithPendingDrops(DEFAULT_FAIRNESS.rails, railRoster, pending.drops);
  // Our no-drop claims, each at the best rest-of-season value among its
  // adds: the ONE value, so the rental (a defense at 71) yields before the
  // season body (a back at 137).
  const heldClaims: HeldClaim[] = pending.claims.filter((c) => c.seats > 0).map((c) => ({
    ...c,
    value: Math.max(0, ...c.adds.map((id) => snap.playerById.get(id)?.points ?? 0)),
    names: c.adds.map((id) => snap.playerById.get(id)?.name ?? id),
  }));
  // Who can take a starting slot this week, for the starter the cut keeps.
  const startable = await loadStartableThisWeek(state.season || config.season, week, league.scoring_settings, now);
  const pendingDrops = new Set<string>(pending.drops);
  const canFill = (body: RailPlayer, starter: RailPlayer): boolean => startable(body, starter) && !pendingDrops.has(body.playerId ?? "");
  const plan = planReserveActivation({ view, settings: league.settings, cap, railRoster, cfg, rails, keep, heldClaims, canFill })[0];
  if (!plan) return null;

  if (plan.action === "stuck") {
    logEvent("coach", "ir-activate-stuck", plan.reason, { player: plan.playerId });
    if (deferrals.mayAlert(plan.playerId, now)) {
      await sendAlert("Player stuck on IR", `${plan.reason}. Free a slot in Sleeper.`).catch(() => {});
    }
    deferrals.deferFor(plan.playerId, now, HOUR);
    return plan;
  }

  const intents = deps.intents ?? new DropIntentStore();
  const prefix = `ir-activate:${plan.playerId}:`;
  // Two looks before a move that costs a player (a cut) or moves one to IR
  // (a stash): the same decision from fresh data at least MIN_AGE_MS apart.
  // Nothing about an illegal roster is urgent at this resolution, and every
  // one of this month's bad drops was a single read. A tag that changes
  // between looks (the stash listed Questionable, the cut no longer cheapest)
  // restarts the decision under the same prefix.
  const twoLooks = async (key: string, would: string, meta: Record<string, unknown>): Promise<boolean> => {
    const restarts = intents.settle(prefix, key, now);
    const gate = decideIntent(intents.get(key), now);
    if (gate.action === "record") {
      intents.put({ key, firstSeen: now, note: plan.reason });
      logEvent("coach", "ir-activate-intent", `Would ${would} ${plan.name}; confirming on a later look. ${plan.reason}`, { player: plan.playerId, ...meta, restarts });
      if (restarts >= 3) {
        // The decision keeps changing between looks, so nothing ever confirms
        // and the roster stays illegal. That needs eyes, not more patience.
        logEvent("coach", "ir-activate-stuck", `${plan.name}: the decision has changed ${restarts} times without confirming; the roster stays illegal`, { player: plan.playerId, restarts });
        if (deferrals.mayAlert(plan.playerId, now)) await sendAlert("IR activation cannot settle", `${plan.name}: the decision keeps changing (${restarts} restarts). ${plan.reason}`).catch(() => {});
      }
      return false;
    }
    return gate.action !== "wait";
  };
  if (plan.stash) {
    if (!(await twoLooks(`${prefix}stash:${plan.stash.playerId}`, `move ${plan.stash.name} to injured reserve and activate`, { stash: plan.stash.playerId, action: "stash" }))) return null;
  } else if (!plan.drop) {
    // A seat is free, so no cut: any drop or stash recorded for him on an
    // earlier look (a seat that was held then) is moot.
    intents.forget(prefix);
  } else {
    if (!(await twoLooks(`${prefix}${plan.action}:${plan.drop.playerId}`, plan.action === "release" ? "release" : `drop ${plan.drop.name} and activate`, { drop: plan.drop.playerId, action: plan.action }))) return null;

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
    intents.forget(prefix);
    if (plan.action === "release") {
      const after = await myRosterView();
      if (after.ownedIds.has(plan.playerId)) {
        logEvent("coach", "ir-activate-failed", `Released ${plan.name} but he is still on the roster after read-back`, { player: plan.playerId });
        deferrals.deferFor(plan.playerId, now, HOUR);
        return null;
      }
      logEvent("coach", "ir-released", `${plan.name} released from injured reserve. ${plan.reason}.`, { player: plan.playerId, injuryStatus: plan.injuryStatus, reserve: after.reserve.map((e) => e.playerId), active: after.active.length });
      deferrals.clear(plan.playerId);
      await cancelHeldClaims(deps.gql, plan);
      return plan;
    }
  }

  let activated = false;
  try {
    // One write: the returning man off, the stash (if any) on. Sleeper
    // validates the list it is handed, so a stash it refuses fails the whole
    // write and nothing moves; the activation is never made alone on a full
    // roster, which would leave it over the cap.
    const back = await updateReserve(deps.gql, plan.reserveAfter, config.rosterId, config.leagueId);
    if (back.includes(plan.playerId)) throw new Error(`write echoed ${plan.playerId} still on reserve`);
    if (plan.stash && !back.includes(plan.stash.playerId)) throw new Error(`write echoed without ${plan.stash.name} on reserve: the roster is over the cap and the over-cap reconciler will cut`);
    // The write is done: the intent has served, whatever the read-back says.
    if (plan.stash) intents.forget(prefix);
    const after = await myRosterView();
    if (after.reserveIds.has(plan.playerId)) throw new Error(`read-back still has ${plan.name} on reserve`);
    if (plan.stash && !after.reserveIds.has(plan.stash.playerId)) throw new Error(`read-back has ${plan.stash.name} off reserve: the roster is over the cap and the over-cap reconciler will cut`);
    logEvent("coach", "ir-activated", `${plan.name} taken off injured reserve${plan.stash ? `; ${plan.stash.name} moved to injured reserve in his place` : ""}. ${plan.reason}.`, {
      player: plan.playerId, injuryStatus: plan.injuryStatus, drop: plan.drop ? { playerId: plan.drop.playerId, name: plan.drop.name, cost: plan.drop.cost } : null,
      stash: plan.stash,
      reserve: after.reserve.map((e) => e.playerId), active: after.active.length,
      cancel: plan.cancel.map((c) => ({ transactionId: c.transactionId, adds: c.adds, value: c.value })),
    });
    deferrals.clear(plan.playerId);
    activated = true;
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
  // After the verified write and outside its try: a cancel that throws must
  // never relabel a done activation as a failure.
  await cancelHeldClaims(deps.gql, plan);
  return activated ? plan : null;
}
// #endregion
