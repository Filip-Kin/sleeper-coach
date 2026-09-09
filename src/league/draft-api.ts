// The live draft over Sleeper's GraphQL, replacing the draft-room DOM.
//
// WHY. The 2026 draft loop scraped the draft room: pick buttons for "on the
// clock", rendered rows for "who is available", board cells for "who was
// taken", and it clicked to pick, to queue and to react. Every one of those has
// a plain GraphQL operation. The reason the DOM was chosen in the first place
// was that REST /draft/<id>/picks lags by up to a day behind a live draft.
// GraphQL draft_picks does not: it is the same feed the Sleeper web app renders
// the board from. Verified 2026-09-09 on the completed real draft: 128 picks
// over GraphQL matched REST on player_id and pick_no with zero mismatches.
//
// Public reads (get_draft, draft_picks, get_active_players, draft_autopickers)
// answer with no token, so they can go straight to the endpoint through
// publicDraftGql. draft_queue and every mutation need the session token, which
// only the logged-in browser page holds, so those take browserGql from api.ts.
// Both transports are passed in as a Gql so the mappers and the clock logic can
// be tested with fixtures and no network.

import { config } from "../config.ts";
import { assertWritesAllowed } from "../killswitch.ts";
import { publicGql } from "../sleeper/graphql.ts";
import { slotOnClock } from "../draft/logic.ts";
import type { Gql } from "./api.ts";

/** publicGql returns the unwrapped data; the Gql helpers expect the whole
 *  body so they can see errors. This adapter makes the two interchangeable. */
export const publicDraftGql: Gql = async (query) => ({ data: await publicGql(query) });

// #region plumbing
type Row = Record<string, unknown>;

function unwrap(body: Record<string, unknown>, field: string): unknown {
  const errs = body.errors as { code?: string; message?: string }[] | undefined;
  const err = errs?.[0];
  if (err) throw new Error(`graphql ${field}: ${err.code ?? ""} ${err.message ?? ""}`.trim());
  return (body.data as Record<string, unknown> | undefined)?.[field];
}

/** Same rule as api.ts: a Sleeper snowflake is 1 to 25 digits, nothing else. */
export function safeId(v: string): string {
  if (!/^[0-9]{1,25}$/.test(v)) throw new Error(`unsafe id: ${v}`);
  return v;
}

/** A player id is a numeric snowflake, or a 2-3 letter team code for a defense
 *  (SEA, KC). get_active_players has no defense rows at all (0 of 3,198 on
 *  2026-09-09), so the team-code form is the only way a DEF pick is spelled. */
export function safePlayerId(v: string): string {
  if (/^[A-Z]{2,3}$/.test(v)) return v;
  return safeId(v);
}

function safeReaction(v: string): string {
  if (!/^[a-z_]{1,24}$/.test(v)) throw new Error(`unsafe reaction: ${v}`);
  return v;
}

function safeSport(v: string): string {
  if (!/^[a-z:_]{1,24}$/.test(v)) throw new Error(`unsafe sport: ${v}`);
  return v;
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
// #endregion

// #region mappers (pure, tested)
export interface DraftInfo {
  draftId: string;
  /** null for a mock draft, which lives under the user rather than a league. */
  leagueId: string | null;
  /** pre_draft | drafting | paused | complete */
  status: string;
  /** snake | linear | auction */
  type: string;
  teams: number;
  rounds: number;
  pickTimer: number;
  reversalRound: number;
  /** user_id -> 1-based slot. Null until the commissioner sets the order. */
  draftOrder: Record<string, number> | null;
  startTime: number | null;
  lastPicked: number | null;
}

export function toDraftInfo(row: Row): DraftInfo {
  const settings = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Row;
  const orderRaw = row.draft_order && typeof row.draft_order === "object" ? (row.draft_order as Row) : null;
  const draftOrder = orderRaw
    ? Object.fromEntries(Object.entries(orderRaw).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, v as number]))
    : null;
  return {
    draftId: String(row.draft_id ?? ""),
    leagueId: strOrNull(row.league_id),
    status: String(row.status ?? ""),
    type: String(row.type ?? ""),
    teams: num(settings.teams),
    rounds: num(settings.rounds),
    pickTimer: num(settings.pick_timer),
    reversalRound: num(settings.reversal_round),
    draftOrder,
    startTime: numOrNull(row.start_time),
    lastPicked: numOrNull(row.last_picked),
  };
}

export interface LivePick {
  pickNo: number;
  playerId: string;
  /** user_id of the drafter; "0" for a CPU pick in a mock draft. */
  pickedBy: string;
  isKeeper: boolean;
  name: string;
  position: string;
  team: string | null;
  /** user_id -> reaction names, e.g. {"1267685386142887936": ["crying"]}. */
  reactions: Record<string, string[]>;
}

export function toLivePick(row: Row): LivePick {
  const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Row;
  const first = String(meta.first_name ?? "").trim();
  const last = String(meta.last_name ?? "").trim();
  const rx = row.reactions && typeof row.reactions === "object" ? (row.reactions as Row) : {};
  const reactions = Object.fromEntries(
    Object.entries(rx).map(([uid, list]) => [uid, Array.isArray(list) ? list.map(String) : []]),
  );
  return {
    pickNo: num(row.pick_no),
    playerId: String(row.player_id ?? ""),
    pickedBy: String(row.picked_by ?? ""),
    isKeeper: row.is_keeper === true,
    name: [first, last].filter(Boolean).join(" "),
    position: String(meta.position ?? ""),
    team: strOrNull(meta.team),
    reactions,
  };
}

export interface ActivePlayer {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  injuryStatus: string | null;
}

export function toActivePlayer(row: Row): ActivePlayer {
  const first = String(row.first_name ?? "").trim();
  const last = String(row.last_name ?? "").trim();
  return {
    playerId: String(row.player_id ?? ""),
    name: [first, last].filter(Boolean).join(" "),
    position: String(row.position ?? ""),
    team: strOrNull(row.team),
    injuryStatus: strOrNull(row.injury_status),
  };
}
// #endregion

// #region clock logic (pure, tested)
/** Round of an overall pick number. */
export const pickRound = (pickNo: number, teams: number): number => Math.ceil(pickNo / teams);
/** Slot on the clock for an overall pick number (snake). */
export const pickSlot = (pickNo: number, teams: number): number => slotOnClock(pickNo, teams);

/** The lowest overall pick number with nothing on the board yet, or null when
 *  every pick is in. Counting picks is not enough: a keeper sits at its own
 *  pick_no in a later round before the draft reaches it, so "picks made + 1"
 *  would be wrong for every pick after the first keeper. */
export function nextOpenPickNo(picks: { pickNo: number }[], teams: number, rounds: number): number | null {
  const taken = new Set(picks.map((p) => p.pickNo));
  const total = teams * rounds;
  for (let n = 1; n <= total; n++) if (!taken.has(n)) return n;
  return null;
}

export interface ClockState {
  /** Our slot from draft_order, or null while the order is unset. */
  mySlot: number | null;
  /** The pick the room is waiting on, or null when the board is full. */
  pickNo: number | null;
  round: number;
  /** Slot that owns pickNo. 0 when the board is full. */
  slot: number;
  /** True only while the draft is live AND pickNo belongs to our slot. */
  onClock: boolean;
}

/** Are we on the clock. A paused or not-yet-started draft is never our turn,
 *  whatever the pick count says, which is the GraphQL equivalent of the old
 *  "pick button not disabled" test. */
export function clockState(draft: DraftInfo, picks: { pickNo: number }[], userId = config.userId): ClockState {
  const mySlot = draft.draftOrder?.[userId] ?? null;
  const pickNo = draft.teams > 0 && draft.rounds > 0 ? nextOpenPickNo(picks, draft.teams, draft.rounds) : null;
  const round = pickNo == null ? draft.rounds : pickRound(pickNo, draft.teams);
  const slot = pickNo == null ? 0 : pickSlot(pickNo, draft.teams);
  const onClock = draft.status === "drafting" && pickNo != null && mySlot != null && slot === mySlot;
  return { mySlot, pickNo, round, slot, onClock };
}

/** Which of the board's players are still draftable: not on the board, and
 *  still an active player when we have the active list. Defenses are keyed by
 *  team code and are absent from get_active_players, so they pass on the
 *  drafted check alone. */
export function availableIds(boardIds: Iterable<string>, draftedIds: Set<string>, activeIds: Set<string> | null): Set<string> {
  const out = new Set<string>();
  for (const id of boardIds) {
    if (draftedIds.has(id)) continue;
    if (activeIds && !/^[A-Z]{2,3}$/.test(id) && !activeIds.has(id)) continue;
    out.add(id);
  }
  return out;
}
// #endregion

// #region reads
const DRAFT_FIELDS = "draft_id league_id status type settings draft_order start_time last_picked";
const PICK_FIELDS = "pick_no player_id picked_by is_keeper metadata reactions";

export async function getDraft(gql: Gql, draftId: string, sport = config.sport): Promise<DraftInfo> {
  const body = await gql(`{get_draft(sport:"${safeSport(sport)}",draft_id:"${safeId(draftId)}"){${DRAFT_FIELDS}}}`);
  const row = unwrap(body, "get_draft");
  if (!row || typeof row !== "object") throw new Error(`get_draft ${draftId}: nothing returned`);
  return toDraftInfo(row as Row);
}

/** Every pick on the board, sorted by pick_no. Live, unlike REST. */
export async function draftPicks(gql: Gql, draftId: string): Promise<LivePick[]> {
  const body = await gql(`{draft_picks(draft_id:"${safeId(draftId)}"){${PICK_FIELDS}}}`);
  const raw = unwrap(body, "draft_picks");
  if (!Array.isArray(raw)) throw new Error(`draft_picks ${draftId}: nothing returned`);
  return (raw as Row[]).map(toLivePick).sort((a, b) => a.pickNo - b.pickNo);
}

/** The caller's own queue, as player ids. Needs the session token. */
export async function draftQueue(gql: Gql, draftId: string): Promise<string[]> {
  const body = await gql(`{draft_queue(draft_id:"${safeId(draftId)}")}`);
  const raw = unwrap(body, "draft_queue");
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** User ids currently on autopick. If ours is in here Sleeper will pick for
 *  us off the queue the instant we are on the clock, ahead of the coach. */
export async function draftAutopickers(gql: Gql, draftId: string, sport = config.sport): Promise<string[]> {
  const body = await gql(`{draft_autopickers(sport:"${safeSport(sport)}",draft_id:"${safeId(draftId)}")}`);
  const raw = unwrap(body, "draft_autopickers");
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** All active players. Measured 2026-09-09: 3,198 rows. The field list is
 *  kept to what the draft needs, so it is well under the 3.2 MB full row. */
export async function activePlayers(gql: Gql, sport = config.sport): Promise<ActivePlayer[]> {
  const body = await gql(
    `{get_active_players(sport:"${safeSport(sport)}"){player_id first_name last_name position team injury_status}}`,
  );
  const raw = unwrap(body, "get_active_players");
  if (!Array.isArray(raw)) throw new Error("get_active_players: nothing returned");
  return (raw as Row[]).map(toActivePlayer).filter((p) => p.playerId);
}
// #endregion

// #region writes (every one passes the kill switch first)
/** Replace our queue. Sleeper autopicks down this list if the clock expires. */
export async function updateDraftQueue(gql: Gql, draftId: string, playerIds: string[]): Promise<string[]> {
  assertWritesAllowed("update draft queue");
  const list = `[${playerIds.map((id) => `"${safePlayerId(id)}"`).join(",")}]`;
  const body = await gql(`mutation{update_draft_queue(draft_id:"${safeId(draftId)}",player_ids:${list})}`);
  const raw = unwrap(body, "update_draft_queue");
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** Make the pick. pick_no must be the open pick our slot owns right now; the
 *  caller gets it from clockState, never by counting. */
export async function draftPickPlayer(
  gql: Gql, draftId: string, playerId: string, pickNo: number, sport = config.sport,
): Promise<LivePick> {
  assertWritesAllowed(`draft pick ${pickNo}`);
  if (!Number.isInteger(pickNo) || pickNo < 1) throw new Error(`draftPickPlayer: bad pick_no ${pickNo}`);
  const body = await gql(
    `mutation{draft_pick_player(sport:"${safeSport(sport)}",player_id:"${safePlayerId(playerId)}",draft_id:"${safeId(draftId)}",pick_no:${pickNo}){${PICK_FIELDS}}}`,
  );
  const row = unwrap(body, "draft_pick_player");
  if (!row || typeof row !== "object") throw new Error(`draft_pick_player ${pickNo}: nothing returned`);
  return toLivePick(row as Row);
}

/** React to a pick on the board. Reaction names are the ones the room's
 *  picker uses: heart, poop, crying, shock, happy, angry, smart, like,
 *  dislike, thinking. */
export async function reactToDraftPick(
  gql: Gql, draftId: string, pickNo: number, reaction: string, sport = config.sport,
): Promise<LivePick> {
  assertWritesAllowed(`react to draft pick ${pickNo}`);
  if (!Number.isInteger(pickNo) || pickNo < 1) throw new Error(`reactToDraftPick: bad pick_no ${pickNo}`);
  const body = await gql(
    `mutation{react_to_draft_pick(sport:"${safeSport(sport)}",draft_id:"${safeId(draftId)}",pick_no:${pickNo},reaction:"${safeReaction(reaction)}"){${PICK_FIELDS}}}`,
  );
  const row = unwrap(body, "react_to_draft_pick");
  if (!row || typeof row !== "object") throw new Error(`react_to_draft_pick ${pickNo}: nothing returned`);
  return toLivePick(row as Row);
}

// The rehearsal surface: claim a seat and start the draft, which the old loop
// did by clicking CLAIM and the start button. Only meaningful on a mock draft.
export async function claimDraftSlot(gql: Gql, draftId: string, slot: number, sport = config.sport): Promise<DraftInfo> {
  assertWritesAllowed(`claim draft slot ${slot}`);
  const body = await gql(
    `mutation{claim_draft_slot(slot:${Math.trunc(slot)},sport:"${safeSport(sport)}",draft_id:"${safeId(draftId)}"){${DRAFT_FIELDS}}}`,
  );
  return toDraftInfo((unwrap(body, "claim_draft_slot") ?? {}) as Row);
}

export async function updateDraftStatus(gql: Gql, draftId: string, status: "drafting" | "paused" | "complete", sport = config.sport): Promise<DraftInfo> {
  assertWritesAllowed(`set draft status ${status}`);
  const body = await gql(
    `mutation{update_draft_status(status:"${status}",sport:"${safeSport(sport)}",draft_id:"${safeId(draftId)}"){${DRAFT_FIELDS}}}`,
  );
  return toDraftInfo((unwrap(body, "update_draft_status") ?? {}) as Row);
}

/** Create a MOCK draft under the user (no league_id). Settings are parallel
 *  key/value arrays; values must be integers. */
export async function createMockDraft(
  gql: Gql, settings: Record<string, number>, metadata: Record<string, string> = {}, season = config.season, sport = config.sport,
): Promise<DraftInfo> {
  assertWritesAllowed("create mock draft");
  const keys = Object.keys(settings);
  const mkeys = Object.keys(metadata);
  for (const k of [...keys, ...mkeys]) if (!/^[a-z_]{1,32}$/.test(k)) throw new Error(`unsafe setting key: ${k}`);
  const kList = `[${keys.map((k) => `"${k}"`).join(",")}]`;
  const vList = `[${keys.map((k) => Math.trunc(settings[k] as number)).join(",")}]`;
  const kMeta = `[${mkeys.map((k) => `"${k}"`).join(",")}]`;
  const vMeta = `[${mkeys.map((k) => JSON.stringify(metadata[k] ?? "")).join(",")}]`;
  const body = await gql(
    `mutation{create_draft(type:"snake",sport:"${safeSport(sport)}",season_type:"regular",season:"${safeId(season)}",k_settings:${kList},v_settings:${vList},k_metadata:${kMeta},v_metadata:${vMeta}){${DRAFT_FIELDS}}}`,
  );
  const row = unwrap(body, "create_draft");
  if (!row || typeof row !== "object") throw new Error("create_draft: nothing returned");
  return toDraftInfo(row as Row);
}

export async function deleteDraft(gql: Gql, draftId: string, sport = config.sport): Promise<DraftInfo> {
  assertWritesAllowed(`delete draft ${draftId}`);
  const body = await gql(`mutation{delete_draft(sport:"${safeSport(sport)}",draft_id:"${safeId(draftId)}"){${DRAFT_FIELDS}}}`);
  return toDraftInfo((unwrap(body, "delete_draft") ?? {}) as Row);
}
// #endregion
