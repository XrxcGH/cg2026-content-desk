# 09 — Roadmap, open decisions, risks

CalGames 2026 is **October 16–18, 2026**. Load-in and practice matches Friday afternoon.

Working backwards from that, with the constraint that this is a volunteer project competing with
build season, school, and jobs.

## Phases

Ordered so that **every phase is independently shippable**. If the project stops after any one of
them, CalGames still gets something better than last year.

### P0 — Works with zero integrations *(target: end of August)*

The floor. Everything here runs off manual operator input and a camera. No FMS, no Cheesy Arena,
no network approval needed.

- ✅ Theme tokens + the seven-transition motion system — [tokens.css](../packages/theme/tokens.css)
- ✅ `core`: event bus, dual-clocked NDJSON event log, snapshot reducer, WS fan-out, log replay
- ✅ Program overlay: alliance overview + score bar + hub indicator + RP pips + lower third +
  final score, all in one Browser Source, switching on `state.screen`
- ✅ Desk console: keyboard-first, drives the whole show including shadow scoring at `estimated`
  confidence and back-dated replay markers
- ✅ Team media library: drag-drop upload, alpha/perimeter validation, trim, multi-width output,
  three-tier fallback in the overview
- ✅ Telestrator: `/s/draw` pad + `/s/tele` render surface, shared renderer, six tools
  (pen, arrow, circle, spotlight, path, team tag), five inks, frozen-frame backdrop,
  6s auto-fade, ANALYSIS chip. Strokes relay off-bus at pointer rate; one durable
  `telestrator.stroke` event per finished stroke goes to the log
- ✅ Rolling record: supervised ffmpeg per source, wall-clock-aligned segments, restart-with-backoff,
  and an encoder chooser that picks by **running a real encode** rather than trusting
  `-encoders` (NVENC→QSV→AMF→libx264)
- ✅ Clip extraction: segment index, accurate seek, multi-range cuts, optional slow-motion.
  Timing-aware `matchCut()` frames a match video as pre-roll over the announcer's countdown → the
  match → a jump to the score reveal, skipping referee deliberation
- ✅ Replay console (`/s/replay`): match-clock timeline, automatic markers, cut/preview,
  and a frame grab that pushes the frozen frame to the telestrator
- ✅ Durable publish queue → YouTube resumable upload → TBA `match_videos/add` / `media/add`,
  with official FIRST-channel naming. Credentials live in a gitignored `config.json`

**P0 is complete.** Everything above runs today; only the credentials are outstanding.

**Ship criterion:** a producer, a switcher op, and an analyst can run a full match with replay and
telestration using nothing but keyboards. *Currently met for everything except replay playback and
telestration.*

### P1 — Live data *(target: end of September)*

- `core` event bus, event log, snapshot store, WS fan-out
- **Cheesy Arena adapter** — near pass-through, low effort
- **The bridge**, hardened per [10-field-bridge.md](10-field-bridge.md): GET-only client, no
  gateway, Windows discovery protocols off, audit log, kill switch. Rehearse against a local
  `cheesy-arena -dev` instance in August
- `score.delta` synthesis → automatic replay markers (scoring bursts, lead changes, climbs), plus
  "robot dropped" markers off `arenaStatus`
- Hub state indicator + shift clock — *the* 2026-specific graphic
- Cue engine with per-cue autopilot toggles

**Ship criterion:** the score bar is correct without anyone typing, and replay markers land on
their own.

### P2 — Depth *(target: first week of October)*

- Arcade: capture, start.gg adapter, Mario Kart GP model, arcade overlay
- Statbotics pre-match prediction + alliance selection value board
- Side screens: queueing, rankings, on-deck
- Post-match social cards

### P3 — Nice to have, cut without regret

- OCR fallback for FMS live score
- Slow-mo frame interpolation
- Automatic TBA match-video upload
- Multi-camera synchronized replay (quad-split)

### The week of

Freeze code the **Monday before**. Friday is for cable-labeling, the photo session, a full
end-to-end rehearsal during practice matches, and **30 minutes looking at every graphic from the
back row of the gym**. Nothing new ships Friday.

---

## Decisions — resolved

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Field management system | ✅ **Cheesy Arena.** The `cheesy` adapter is the primary and only ingest path; the FMS adapter is not being built |
| 2 | Field bridge | ✅ **Approved.** Any software is fine as long as it can't interfere with Cheesy Arena controlling the field |
| 2b | Registering as a display | ✅ **In scope.** Unlocks live score, `score.delta`, and `arenaStatus` |

Rule 2 resolves to a hard endpoint allowlist, and the guarantee is structural rather than
procedural: `HandleNotifiers` never calls `Read()`, so display endpoints *cannot* process anything
we send. The forbidden list is short and specific — `/match_play/*` (abort match),
`/panels/scoring/*` (game-piece scoring), `/panels/referee/*`, `/setup/*`. Full spec and the FTA
sign-off sheet: [10-field-bridge.md](10-field-bridge.md).

The one genuine interference vector left is **the host, not the API** — Cheesy Arena is a single Go
process that also runs the arena loop and PLC I/O, so nothing of ours ever runs on the FMS machine.

## Open decisions

| # | Decision | Why it matters | Default if nobody decides |
| --- | --- | --- | --- |
| 3 | Server language/stack | Affects who can contribute | TypeScript + Node — surfaces are already browser pages, and one language across the whole project matters more than raw performance at this scale |
| 4 | OBS or vMix | vMix has native replay/ISO; OBS is free and scriptable | OBS + separate rolling record. Revisit if an ATEM Mini Extreme ISO is in budget |
| 5 | Budget for the ATEM Mini Extreme ISO | It collapses the whole replay ingest problem into hardware | Ask WRRF early; ~$1200 and it outlives the event |
| 6 | Who owns the robot photo session | The alliance overview is worthless without it | Assign a named photographer by September; block 2 hours Friday |
| 7 | Are Smash/Mario Kart approved by the planning committee | Venue, hardware, and stream-audio implications | Raise it at the next planning meeting — this is their call, not ours |

## Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Venue power outage** | **High** — it happened in 2025 and killed the Sunday stream | High | UPS on every production box; rolling record never stops; backup stream key pre-created and the fallback URL posted before the event |
| **Our software interferes with field control** — a stray connection to `/match_play` or `/panels/scoring`, or resource starvation on the FMS host | Low | **Severe** — the one way this project can damage the event and our standing with WRRF | Endpoint allowlist as a constant with a failing unit test; `GET`-only HTTP client; nothing of ours ever runs on the FMS machine; backoff + circuit breaker; rehearsed kill switch. See [10-field-bridge.md](10-field-bridge.md) |
| `displayId` collision reconfigures a real audience display | Low | Medium | Reserved ID agreed with the scorekeeper in writing, always passed explicitly |
| Venue internet is poor or absent | Medium | Low–Medium | Cache team lists, avatars, and Statbotics data locally on Friday. Nothing on the critical path needs internet except the stream itself |
| Too few robot photos | **High** | Low | Tier-3 fallback (gold team number on a purple plinth) must look deliberate. Ship the screen with zero photos and improve it live |
| Volunteer crew smaller than planned | High | Medium | Minimum viable crew is 3. Every surface must be operable after 20 minutes of training |
| Telestrator Wi-Fi latency | Medium | Low | Dedicated 5GHz production AP, clear of the field AP. Wired fallback: a laptop with a trackpad works, badly but adequately |
| YouTube Content ID on game audio | Medium | **High** — can kill the whole VOD | Game audio routed to venue only, never to the stream feed. Non-negotiable |
| **NVENC unavailable on the recording box** — ffmpeg's required NVENC API outruns the installed NVIDIA driver | **High** — already hit it on the dev laptop (needs driver 610.00+, had 596.49) | Medium | Test a real encode, not a capability list. Update the driver or pin a matching ffmpeg build. `libx264 veryfast` works at 2.88× realtime for one 1080p60 stream, but that only covers 1–2 cameras |
| YouTube per-channel daily upload cap (separate from API quota) | Medium | Medium | Use WRRF's established, verified channel — not a new one. Stage uploads across the weekend; queue defaults to `deferred` |
| Uploads contend with the live stream for venue uplink | Medium | Medium | Upload mode defaults to `deferred`; measure the uplink Friday before switching ([11](11-distribution.md)) |
| Graphics unreadable in the room | Medium | Medium | The venue-scale spec in [08-motion.md](08-motion.md) plus the Friday back-row walkthrough |
| Scope creep in September | **High** | High | P3 is explicitly labeled "cut without regret." Freeze Monday |

## The honest assessment

The riskiest thing here isn't technical — it's that this is a lot of surface area for a volunteer
crew, and offseason events are staffed by people who are also doing five other things.

The design is deliberately ordered so the **most visually valuable pieces have the fewest
dependencies**. The alliance overview, the telestrator, and replay are P0 and need no field
integration at all. If P1 never lands and the whole weekend runs on manual input, CalGames still
gets a broadcast that looks dramatically better than a static camera and a scoreboard — which is
the actual goal.

Build P0 completely before starting P1.
