// Typed shapes for the subset of the Sleeper read-only API this coach uses.
// Only fields we actually read are declared; the API returns more.

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF" | string;

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
}

export interface LeagueUser {
  user_id: string;
  display_name: string;
  avatar: string | null;
  metadata: { team_name?: string } | null;
}

// Scoring settings are a flat map of stat key to points. Vanilla PPR here, but
// we read it dynamically so the projection maths never hard-codes a value.
export type ScoringSettings = Record<string, number>;

export interface LeagueSettings {
  num_teams: number;
  playoff_teams: number;
  playoff_week_start: number;
  trade_deadline: number;
  waiver_budget: number;
  max_keepers: number;
  disable_trades: number;
}

export interface League {
  league_id: string;
  name: string;
  season: string;
  status: string;
  total_rosters: number;
  draft_id: string;
  previous_league_id: string | null;
  scoring_settings: ScoringSettings;
  roster_positions: Position[];
  settings: LeagueSettings;
}

export interface RosterSettings {
  wins: number;
  losses: number;
  ties: number;
  fpts: number;
  fpts_decimal: number;
}

export interface Roster {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  keepers: string[] | null;
  settings: RosterSettings;
}

export interface DraftSettings {
  teams: number;
  rounds: number;
  pick_timer: number;
  cpu_autopick: number;
  reversal_round: number;
}

export interface Draft {
  draft_id: string;
  league_id: string;
  status: string;
  type: string; // "snake" | "auction" | "linear"
  season: string;
  start_time: number | null;
  settings: DraftSettings;
  // Maps user_id -> draft slot (1-based). Null until the order is set.
  draft_order: Record<string, number> | null;
  // Maps draft slot -> roster_id.
  slot_to_roster_id: Record<string, number>;
  metadata: { scoring_type?: string; name?: string };
}

export interface DraftPick {
  round: number;
  pick_no: number;
  draft_slot: number;
  player_id: string;
  roster_id: number | null;
  picked_by: string;
  metadata?: { first_name?: string; last_name?: string } | null;
}

export interface SleeperPlayer {
  player_id: string;
  first_name: string;
  last_name: string;
  full_name?: string;
  position: Position | null;
  fantasy_positions: Position[] | null;
  team: string | null;
  age: number | null;
  years_exp: number | null;
  status: string | null; // "Active", "Inactive", ...
  injury_status: string | null; // "Questionable", "Out", "IR", ...
  injury_notes: string | null;
  // Lower = more fantasy-relevant per Sleeper. Null for irrelevant players.
  search_rank: number | null;
}

export type PlayersMap = Record<string, SleeperPlayer>;

export interface NflState {
  season: string;
  season_type: string;
  week: number;
  display_week: number;
}

// A projection record from the (undocumented) projections endpoint. `stats`
// carries both the projected stat line (rec, rush_yd, pass_td, ...) and ADP
// values (adp_ppr, adp_std, ...) and precomputed points (pts_ppr, ...).
export interface ProjectionRecord {
  player_id: string;
  week: number | null;
  season: string;
  stats: Record<string, number>;
  player: {
    first_name: string;
    last_name: string;
    position: Position | null;
    fantasy_positions: Position[] | null;
    team: string | null;
    injury_status: string | null;
  } | null;
  team: string | null;
}
