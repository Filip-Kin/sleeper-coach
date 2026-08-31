# Coach dashboard fixes (feat/dashboard)

Fixes the two live complaints from the 30 August 2026 draft: the feedback box
did nothing, and there was no visibility of what the coach was about to do. Both
are addressed in the dashboard only (src/web/server.ts and public/). The engine
was not touched, and nothing drives the shared browser.

## Problem 1: the feedback box now actually reaches the draft agent

The old console input streamed the agent's reasoning but posted to /api/chat,
which spins up a SEPARATE conversation. During a draft the engine owns the plan
loop, so that input never touched a pick. What worked mid-draft was coach-say,
which rewrites the LIVE GUIDANCE block in system-prompt.md inside the running
container; runAgent re-reads that file on every call and passes it as
--append-system-prompt, so an edit reaches the planning agent on its next plan
refresh (about 20s).

- New src/web/guidance.ts writes through that same mechanism. It ALWAYS rebuilds
  system-prompt.md from a pristine base, so repeated edits cannot stack. The
  output is byte-identical to coach-say's, so coach-guidance still reads dashboard
  edits and vice versa.
- Base resolution self-heals without ever writing live state. Order: GUIDANCE_BASE
  env (authoritative and exclusive), then /data/sleeper-coach/system-prompt.base.md
  (what coach-say and the live box share), then a NEW system-prompt.base.md
  committed in the repo. The committed base is the fix for the base previously
  existing on one machine only by accident: it ships in the image, so a fresh
  Coolify deploy has a working channel with no manual step. I did NOT seed a file
  into /data (two reviewers asked): writing there is a hard rule, and seeding from
  whatever system-prompt.md is live would invent a base rather than recover one.
  Committing the base to git is the option one reviewer floated and is strictly
  better.
- It refuses a base that already carries the "## LIVE GUIDANCE" marker rather than
  stripping it, because snapshotting an already-appended prompt as the base would
  bake that stale guidance in permanently and invisibly. GuidanceState carries a
  baseReadable flag and, when false, a human reason the UI shows verbatim.
- It writes ONLY system-prompt.md (the file runAgent loads). It never writes into
  /data/sleeper-coach, which is live state. Writes are atomic (temp file then
  rename) so a mid-write read can never see a partial prompt; on any failure the
  temp file is removed (no .tmp litter) and the live prompt is left untouched.
- The console input now has two honest modes. "Guide the draft" applies guidance
  and shows what is currently in effect. "Ask (off-draft)" keeps the old one-off
  chat, clearly labelled as not steering the live pick. The UI states plainly
  that guidance applies from the next refresh (~20s) and will NOT catch a pick
  already on the clock, which is the latency that cost a pick on 30 Aug.
- Endpoints: GET/POST /api/guidance.

One wart worth knowing: the engine's secondary guidance channel (run.ts reading
/data/sleeper-coach/guidance.txt for the plan prompt) is not updated by the
dashboard, because writing /data is off-limits. Guidance still reaches the agent
on every call via the system prompt, so the feature works; only coach-say's
bookkeeping file goes unupdated if you mix the two tools.

## Problem 2: a "Draft plan" tab showing what the coach is about to do

New src/web/draftview.ts and a new default tab, all read-only off the Sleeper API
plus the same analysis modules the engine uses. Endpoint: GET /api/draftview.

- Plan AGE is the headline, ticking every second from the engine's own logged
  plan timestamp. The whole box changes state, not just a number: fresh (green)
  under 30s, ageing (amber) to 45s, and stale (red, tinted and pulsing) past 45s,
  the postmortem's "treat as absent" threshold, with a plain-language note that a
  stale plan drops to the raw value board where guidance has no effect and that
  the botched pick ran on a 116s plan. The pulse respects prefers-reduced-motion.
  Age is read from the log, never a fresh recompute, because a recompute would
  always read ~0s and hide the exact failure.
- The current plan, each player enriched with VOR, tier, news tag and bye
  (exact), plus VONA and survival (recomputed live off the Sleeper picks feed,
  labelled as an estimate since that feed lags a few picks in-draft). Targets a
  rival has already taken are struck through.
- The backstop queue. It reads the ACTUAL queue the engine pushed, from the
  "queue" log event, and labels the panel live. When no queue event exists yet (a
  draft predating that log line, or a rotated log) it falls back to rebuilding the
  queue with the engine's exact algorithm and labels it a reconstruction.
- Our roster's per-week bye load, flagged red at 3+ on a week.
- The last few agent overrides with what the value board wanted instead. When the
  board wanted a K or DEF the raw VOR gap is flagged as NOT a real cost, because
  those positions are one-starter capped. Verified against the postmortem: the
  four most recent overrides are all K/DEF and are all flagged.

## Testing

- tsc --noEmit clean.
- Unit tests in src/web/guidance.test.ts (bun:test), all against temp files via
  the env overrides so nothing real is touched: set/get round-trips the exact
  text; setting twice does not stack and is byte-identical to coach-say; clearing
  removes the block and leaves the base unchanged; a missing base is refused and
  never blanks the live prompt; a marker-bearing base is refused with a reason;
  and no .tmp files are left behind on success or failure. Run with:
    bun test src/web/guidance.test.ts
  NOTE: bare `bun test` in this environment only discovers the one pre-existing
  file (src/analysis/rails.test.ts) and ignores every other test file, including a
  trivial probe, so run the guidance tests by path. This is a bun runner quirk
  here, not a test problem: the file passes 6/6 when named, and rails still passes
  10/10.
- draftView(): ran against the STAGING league (read-only). Queue is K/DEF-free,
  byes flag 3+ weeks, override vorGaps match the postmortem table (45.5, 41.5,
  28.2, 13.4) and all flag capped. VONA/survival path exercised with a simulated
  mid-draft state and returns finite numbers. Logged-queue and reconstruction
  fallback both exercised with a synthetic activity log.
- Full server on an alternate port: /api/guidance GET+POST and /api/draftview
  return correctly and index.html serves the new tab.

## Files

New system-prompt.base.md at the repo root is the committed pristine base (an
exact copy of system-prompt.md, verified marker-free). It exists so the guidance
channel works on any machine without a hand-made file on the state volume. Keep it
in sync if system-prompt.md changes materially.

Not run: docker restart/deploy, any write to /data or the real league. Changes
go live only when merged and redeployed, which is Filip's call.
