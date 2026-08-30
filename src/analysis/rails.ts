// Deterministic guards in front of every irreversible roster move.
//
// The design rule for the whole in-season system is: the model proposes, code
// decides what is permitted. An agent having a bad day should be UNABLE to do
// lasting damage, not merely unlikely to. Filip dropped a good player last
// season for exactly this class of reason, and unlike the draft there is no
// rehearsal available in-season, so these are checks rather than advice.
//
// Everything here is a pure function of a roster and a projection table, which
// means it is fully testable offline with no live writes. That is deliberate:
// the untestable part of the system should be as small as possible.

export interface RailPlayer {
  name: string;
  position: string;
  points: number; // rest-of-season projection
  injuryStatus?: string; // Sleeper injury_status, if any
  returnsBeforePlayoffs?: boolean; // hurt but expected back before week 16
}

export interface RailConfig {
  // How many of our best players are untouchable. Sized to starters plus a
  // buffer, so a thin bench cannot be raided for a streaming pickup.
  protectTopN: number;
  // A drop must be a clear UPGRADE, not a tie. Ties keep the incumbent, because
  // a tie plus transaction risk is a loss.
  upgradeMarginPts: number;
  // Names that may never be dropped regardless of projection.
  neverDrop: string[];
}

export const DEFAULT_RAILS: RailConfig = {
  protectTopN: 12, // 10 starting slots + 2
  upgradeMarginPts: 8,
  neverDrop: [],
};

export interface Verdict {
  allowed: boolean;
  reason: string;
}

function norm(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// May we drop this player at all, ignoring what we would get back?
export function canDrop(target: string, roster: RailPlayer[], cfg: RailConfig = DEFAULT_RAILS): Verdict {
  const t = norm(target);
  const player = roster.find((p) => norm(p.name) === t);
  if (!player) {
    // Not knowing what we are about to drop is itself disqualifying.
    return { allowed: false, reason: `"${target}" is not on the roster as read back from Sleeper` };
  }
  if (cfg.neverDrop.some((n) => norm(n) === t)) {
    return { allowed: false, reason: `"${player.name}" is on the never-drop list` };
  }

  // A hurt starter looks worthless to a weekly projection and is exactly the
  // player you must not cut. This clause matters more than the rest.
  if (player.returnsBeforePlayoffs) {
    return {
      allowed: false,
      reason: `"${player.name}" is injured but projected back before the week 16 playoffs, so he is a stash, not dead weight`,
    };
  }

  const ranked = roster.slice().sort((a, b) => b.points - a.points);
  const rank = ranked.findIndex((p) => norm(p.name) === t) + 1;
  if (rank > 0 && rank <= cfg.protectTopN) {
    return {
      allowed: false,
      reason: `"${player.name}" is #${rank} on our roster by rest-of-season projection (top ${cfg.protectTopN} is protected)`,
    };
  }
  return { allowed: true, reason: `"${player.name}" is #${rank} of ${roster.length}, outside the protected top ${cfg.protectTopN}` };
}

// Is dropping `target` to add `incoming` a clear enough upgrade to be worth it?
export function isUpgrade(
  incoming: RailPlayer,
  target: string,
  roster: RailPlayer[],
  cfg: RailConfig = DEFAULT_RAILS,
): Verdict {
  const gate = canDrop(target, roster, cfg);
  if (!gate.allowed) return gate;
  const player = roster.find((p) => norm(p.name) === norm(target))!;
  const gain = incoming.points - player.points;
  if (gain < cfg.upgradeMarginPts) {
    return {
      allowed: false,
      reason: `${incoming.name} beats ${player.name} by only ${gain.toFixed(1)}pts, under the ${cfg.upgradeMarginPts}pt margin`,
    };
  }
  return { allowed: true, reason: `${incoming.name} beats ${player.name} by ${gain.toFixed(1)}pts` };
}

// The cheapest legal drop for a given add, or null if there is none. Prefer
// paths that cost nothing: an empty bench slot means no drop at all, which the
// caller checks before ever getting here.
export function chooseDrop(
  incoming: RailPlayer,
  roster: RailPlayer[],
  cfg: RailConfig = DEFAULT_RAILS,
): { name: string; reason: string } | null {
  const candidates = roster
    .slice()
    .sort((a, b) => a.points - b.points) // worst first
    .filter((p) => canDrop(p.name, roster, cfg).allowed);
  for (const c of candidates) {
    const v = isUpgrade(incoming, c.name, roster, cfg);
    if (v.allowed) return { name: c.name, reason: v.reason };
  }
  return null;
}
