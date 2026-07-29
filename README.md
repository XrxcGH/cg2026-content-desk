# CalGames 2026 Content Desk

An in-house analysis / broadcast content desk for **CalGames 2026** — Woodside High School,
**October 16–18, 2026**, presented by the Western Region Robotics Forum (WRRF).

The goal: give CalGames a broadcast layer that behaves like a real sports desk — instant replay,
an analyst who can draw on the field, RSN-style pre-match alliance overviews with real robot
photos, live data-driven graphics, and something worth watching in the gaps (side-tournament Smash
Bros. and Mario Kart on the same overlay system). All CalGames-branded, all runnable by volunteers.

## Design principle

> **One event bus, many surfaces.**

Every data source (Cheesy Arena, Off-Season FMS, FRC Events API, The Blue Alliance, Statbotics, a
Switch running Mario Kart, the desk operator's keyboard) is normalized into a single timestamped
event stream. Every output (broadcast overlay, telestrator, replay console, alliance overview,
venue side screens, arcade scoreboard, post-match cards) is a *subscriber* to that stream.

That's the whole architecture. Everything else is adapters and CSS.

## Repo map

| Path | What |
| --- | --- |
| [docs/01-research.md](docs/01-research.md) | How FMS, Cheesy Arena, RSN, FRC AV, and the public APIs actually work |
| [docs/02-architecture.md](docs/02-architecture.md) | System architecture, data contracts, ingest adapters |
| [docs/03-brand.md](docs/03-brand.md) | CalGames design system: WRRF palette, type, broadcast rules |
| [docs/04-replay-and-telestrator.md](docs/04-replay-and-telestrator.md) | Match replay pipeline + analyst drawing overlay |
| [docs/05-arcade.md](docs/05-arcade.md) | Smash Bros. / Mario Kart integration |
| [docs/06-hardware-and-network.md](docs/06-hardware-and-network.md) | AV rack, cameras, network segmentation, show flow |
| [docs/07-team-media.md](docs/07-team-media.md) | Robot photo library + pre-match alliance overview |
| [docs/08-motion.md](docs/08-motion.md) | Motion system + gym legibility math |
| [docs/09-roadmap-and-risks.md](docs/09-roadmap-and-risks.md) | Build phases, open decisions, risk register |
| [docs/10-field-bridge.md](docs/10-field-bridge.md) | Cheesy Arena field bridge: endpoint allowlist + FTA sign-off sheet |
| [docs/11-distribution.md](docs/11-distribution.md) | Recording, YouTube live + upload, TBA video/webcast publishing |
| [packages/theme/tokens.css](packages/theme/tokens.css) | Design tokens + motion system, shared by every surface |
| [prototypes/overlay.html](prototypes/overlay.html) | Runnable proof-of-concept |

## Look

Palette is mandated, so the character comes from **typography and geometry**: expanded **Archivo**
for display, **Chivo** for scores, **Saira Condensed** for team names — and a "field-built" form
language of chamfered plates, perforated-aluminum texture, and blueprint tick rules. Details in
[docs/03-brand.md](docs/03-brand.md).

Official **WRRF** palette, with **official FIRST** alliance colors reserved as semantic-only:

| | |
| --- | --- |
| Purple `#560F6B` | primary surface and chrome |
| Gold `#F0AF00` | primary accent |
| Green `#006549` | secondary accent |
| Black `#000000` / White `#FFFFFF` | text, and black is the luma-key background |
| Red `#ED1C24` / Blue `#0066B3` | **alliance only** — never decorative |

## Run it

Needs Node 22.6+ (uses native TypeScript type stripping — no build step) and **ffmpeg** for
recording and replay (`winget install Gyan.FFmpeg` — take the full build, it carries the `segment`
muxer and `minterpolate`). Everything except recording runs without ffmpeg.

```bash
npm install
```

```bash
npm start -- --demo
```

Then open <http://localhost:8720>. `--demo` runs a simulated match loop so graphics can be
built without a field. Drop it to run on desk input alone.

| Surface | URL | Runs on |
| --- | --- | --- |
| Program overlay | `/s/program` | OBS Browser Source, 1920×1080 |
| Desk console | `/s/desk` | Operator laptop, keyboard-first |
| Team media | `/s/media` | Drag-drop robot cutouts |
| Telestrator pad | `/s/draw` | iPad + Pencil, on the production Wi-Fi |
| Telestrator render | `/s/tele` | OBS Browser Source, layered over the replay |
| Replay console | `/s/replay` | Match-clock timeline, markers, cut and send |

Recording and replay need ffmpeg. Add `--record --test-sources` to exercise the whole pipeline
without cameras:

```bash
npm start -- --demo --record --test-sources
```

Program takes `?key=alpha|luma` and `?scale=stream|venue`. It contains the alliance overview, live
match, and final score in one page — screens switch on state, so the switcher operator never
changes sources.

Replay a recorded event log instead of running live:

```bash
npm run replay -- data/events/2026-10-17-09-14-02.ndjson 4
```

```bash
npm test
```

## Connecting to the field

The Cheesy Arena bridge is a **launch flag, never a config setting** — it needs FTA sign-off, so
switching it on should be an explicit act at the point of use rather than something inherited from
a file copied between machines.

```bash
npm start -- --cheesy --cheesy-host 10.0.100.5:8080 --display-id contentdesk1
```

Agree the display id with the scorekeeper in advance so it can't collide with a real audience
screen. `GET /api/cheesy/audit?format=text` prints every request the bridge has made, which is what
[docs/10-field-bridge.md](docs/10-field-bridge.md) promises the FTA.

Show automation and OBS are separate flags. Cues start **disarmed** — nobody should discover
automation by having it happen to them mid-match — and are armed individually from `/api/cues`.
The OBS password comes from the environment, never a CLI argument, because `argv` is visible in
`ps` and in shell history.

```bash
OBS_PASSWORD=… npm start -- --cheesy --obs --obs-host 127.0.0.1:4455
```

To rehearse without a field, build [Cheesy Arena](https://github.com/Team254/cheesy-arena), run it
with `-dev`, and drive a real scored match through it:

```bash
node harness.mjs
```

## Publishing

Copy [config.example.json](config.example.json) to `config.json` (gitignored — it holds
credentials) and fill it in. `npm run auth:youtube` walks through getting a YouTube refresh token.
Nothing uploads until `publish.enabled` is true, and the default `deferred` mode queues during the
event and uploads afterwards so nothing competes with the live stream for the venue uplink.

Titles follow the official FIRST channel convention — `Qualification 42 - CalGames`,
`Match 5 (R2) - CalGames`, `Final Tiebreaker - CalGames`. Details in
[docs/11-distribution.md](docs/11-distribution.md).

## Try the standalone prototype

Open [prototypes/overlay.html](prototypes/overlay.html) in a browser. Standalone, fake match
driver, no server or build step.

**Query params**

| | |
| --- | --- |
| `?key=alpha` (default) | transparent — for an OBS Browser Source |
| `?key=luma` | black background — for a Blackmagic downstream luma keyer |
| `?scale=stream` (default) | phone/laptop viewing, 28px type floor |
| `?scale=venue` | 30–90 ft across a gym, 72px type floor, reduced element count |
| `?demo=0` | freeze the fake match driver |
| `?ui=0` | hide the control bar |

**Keys** — `P` pen · `A` arrow · `E` ellipse · `S` spotlight · `Z` undo · `C` clear ·
`H` toggle telestrator · `U` toggle the control bar

It demonstrates the Gold Sweep transition, the alliance overview with its tier-3 photo fallback,
the live score bar with the 2026 hub-state indicator and RP pips, Number Roll counters, endgame
lockdown, and the telestrator.

## Status

**P0 and P1 are built and validated.** The bridge has been run against a real `cheesy-arena -dev`
build of the 2026 source through a genuine scored match. Outstanding: YouTube and TBA credentials,
and P2 (see [docs/09-roadmap-and-risks.md](docs/09-roadmap-and-risks.md)).

Two decisions shaped everything:

- **CalGames 2026 runs Cheesy Arena.** The `cheesy` adapter is the only ingest path.
- **The field bridge is approved**, on the condition that nothing can interfere with Cheesy Arena
  controlling the field.

That condition resolves to a hard endpoint allowlist, and the guarantee behind it is **structural
rather than procedural**: Cheesy Arena's `HandleNotifiers` never calls `Read()`, so the display
endpoints we subscribe to *cannot* process anything we send. What's forbidden is short and
specific — `/match_play/*` (abort match), `/panels/scoring/*` (game-piece scoring),
`/panels/referee/*`, and every `/setup/*`. The remaining interference vector is the *host*, not
the API, so nothing of ours runs on the FMS machine. Spec and a printable FTA sign-off sheet:
[docs/10-field-bridge.md](docs/10-field-bridge.md).

Running the bridge against the real thing was worth more than the code it checked — it found the
hub alternation inverted, the auto winner decided on fuel count rather than points, and a tied auto
settled by a **coin flip**. Hub state now comes from the field rather than any local inference.

Next up is P0 in [docs/09-roadmap-and-risks.md](docs/09-roadmap-and-risks.md) — none of it needs
the bridge.
