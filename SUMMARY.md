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
  system-prompt.md from the pristine base at
  /data/sleeper-coach/system-prompt.base.md, so repeated edits cannot stack. The
  guidance block is byte-compatible with coach-say's, so coach-guidance still
  reads dashboard edits and vice versa.
- It writes ONLY system-prompt.md (the file runAgent loads). It never writes into
  /data/sleeper-coach, which is live state; the base there is read-only. Writes
  are atomic (temp file then rename) so a mid-write read can never see a partial
  prompt, and a failed base read aborts rather than blanking the prompt.
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
- guidance.ts: set / read round-trip, no stacking on repeated edits, clear
  restores the exact base.
- draftView(): ran against the STAGING league (read-only). Queue is K/DEF-free,
  byes flag 3+ weeks, override vorGaps match the postmortem table (45.5, 41.5,
  28.2, 13.4) and all flag capped. VONA/survival path exercised with a simulated
  mid-draft state and returns finite numbers.
- Full server on an alternate port: /api/guidance GET+POST and /api/draftview
  return correctly and index.html serves the new tab.

Not run: docker restart/deploy, any write to /data or the real league. Changes
go live only when merged and redeployed, which is Filip's call.
