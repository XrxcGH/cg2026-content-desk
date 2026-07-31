# 01. Research: how the FRC broadcast/field ecosystem actually works

Everything below is what the design in [02-architecture.md](02-architecture.md) is built on.
Sources are linked inline and collected at the bottom.

---

## 1. FIRST Field Management System (FMS)

**What it is.** The electronics core of an FRC field: hardware (road case, field router, smart
router, managed switches, access point, station cabinets, E-stops) plus software (Event Manager,
Field Monitor, Audience Display, FTA Notepad, Field Server Website).

**Network model.** Ethernet-based. One physical network split into **VLANs** so each team's
driver-station traffic is isolated from every other team's and from field electronics. Robots
talk over Wi-Fi; everything else is wired. The FMS server lives at **10.0.100.5**.

**What this means for us:** *you cannot casually plug the content desk into the field network.*
The design has to assume a segregated production LAN with a single, tightly-scoped bridge. See
[06-hardware-and-network.md](06-hardware-and-network.md).

### Off-Season FMS

FIRST distributes an off-season build of FMS to registered off-season events. Requirements are
modest (Win10 x64, a laptop, an AP, a few unmanaged switches). It provides schedule generation,
real-time scoring, field control, and drives the **Audience Display**.

### Audience Display: the important part

Audience Display is a **separate Windows app on a separate machine**, wired to FMS at 10.0.100.5.
It owns all audience-facing graphics *and all the game audio* (the match-start charge, the endgame
warning, the buzzer). At many events the A/V crew owns this machine.

Two documented automation hooks make it a usable data source:

**(a) OBS WebSocket integration.** Audience Display connects to OBS and switches scenes by name as
the event progresses:

| Scene name | Fires when |
| --- | --- |
| `FMS_PREVIEW` | Match preview is up |
| `FMS_SCORE` | Match is live (score bar shown) |
| `FMS_RESULT` | Post-match score reveal |
| `FMS_ALLIANCE` | Alliance selection |
| `FMS_AWARDS` | Awards ceremony |
| `FMS_FULL` | Full-screen FMS content (required fallback) |
| `FMS_HIDDEN` | Between triggers (required) |

**(b) BitFocus Companion integration.** Audience Display POSTs to a Companion HTTP endpoint
(default `http://127.0.0.1:8000`) on **state change only** (it tracks state internally and
de-dupes). Documented states:

`Prestart` · `Match Preview` · `Set Audience` · `Match Start` · `Teleop Start` ·
`Endgame Start` · `Match End` · `Post Result` · `Alliance Selection` · `Award Ceremony`

Each maps to a Companion page/row/column button press (down + up).

> **The key insight for this project.** Companion's trigger API is plain HTTP. If we point
> Audience Display's Companion URL at *our own* service (or run Companion and mirror its
> presses), we get **frame-accurate, official-FMS match state with zero field-network
> intrusion**. `Match Start` and `Endgame Start` alone are enough to drive automatic replay
> markers and every scene cue. This is the single highest-leverage integration available when
> the event runs official FMS.
>
> Caveat to verify on-site: exact Companion API path differs between Companion v2
> (`/press/bank/{page}/{bank}`) and v3 (`/api/location/{page}/{row}/{col}/press`). Test in
> August, not on load-in day.

**What FMS does *not* give you:** a public local match-data API. Post-match data goes to a FIRST
Azure database and comes back out through the public FRC Events API (internet required, and
delayed). So live *numbers* must come from either Cheesy Arena, screen-scraping, or our own
manual scoring, while live *state* comes from the Companion/OBS hooks above.

---

## 2. Cheesy Arena (Team 254)

Open-source alternative FMS, free for off-season events, scrimmages, and practice. Written in
**Go**, embedded Bolt DB, entirely browser-driven. Server binds `10.0.100.5:8080` in production
(`-dev` flag for a laptop). Supports real FRC-style networking (per-team SSIDs/WPA keys, VLANs),
Allen-Bradley PLC field sensors, Advatek LEDs, DMX, and direct publishing to The Blue Alliance.

**The main branch is already on 2026 REBUILT**: `game/hub.go`, fuel/tower scoring, and the
audience display reads `EnergizedBonus` / `Supercharged` / `Traversal` bonus RPs.

### Cheesy Arena is a far better data source than FMS

It exposes a real HTTP + WebSocket surface, CORS-enabled:

```
GET  /api/arena/websocket      # live push: matchTiming, matchLoad, matchTime
GET  /api/matches/{type}       # schedule + results
GET  /api/rankings             # rankings + nicknames
GET  /api/alliances            # alliance lineups
GET  /api/sponsor_slides
GET  /api/teams/{id}/avatar    # PNG
GET  /api/bracket/svg          # playoff bracket as SVG
```

Plus ~19 display pages, each with its own WebSocket
(`/displays/audience/websocket`, `/displays/announcer/websocket`, `/displays/queueing/websocket`,
`/displays/rankings/websocket`, `/displays/bracket/websocket`, `/displays/field_monitor/websocket`, …).

The **arena notifier set** is the real prize. This is the full live event vocabulary:

| Notifier | Payload highlights |
| --- | --- |
| `matchLoad` | current match, team assignments, rankings, playoff matchup, breaks |
| `matchTime` | match state + elapsed seconds |
| `matchTiming` | period lengths (auto/teleop/endgame) |
| `realtimeScore` | red/blue live score + summaries, cards, match state |
| `scorePosted` | final results, RPs, fouls, rules violated, cards, updated rankings |
| `arenaStatus` | station map, AP/switch/score-controller health, PLC, E-stop, FTA-ready |
| `audienceDisplayMode` | which screen the audience is on |
| `lowerThird` | lower-third text + visibility |
| `allianceSelection` | picks, timer, ranked pool |
| `eventStatus`, `scoringStatus`, `displayConfiguration`, `playSound`, `reload` | ancillary |

Audience display modes: `blank`, `intro`, `match`, `score`, `logo`, `logoLuma`, `sponsor`,
`bracket`, `allianceSelection`, `timeout`.

### Cheesy Arena's AV integration (worth copying)

- Audience Display runs in **Chrome fullscreen** on a Mac Mini at
  `http://10.0.100.1:8080/displays/audience`, out to a secondary monitor.
- That output goes into a **Blackmagic 4K switcher as a downstream key (using LUMA keying, not
  chroma)**, because chroma key isn't available on the DSK. **Black = transparent.**
- Overlay audio goes to the venue mixer over RCA.

> **Hard design constraint:** if any of our graphics pass through a Blackmagic DSK, they must be
> designed to be luma-keyed, with a pure `#000` background and no dark-on-dark detail that will key
> out. If they're an OBS Browser Source, true alpha is fine. **Every overlay we build must
> support both**, hence the `?key=luma|alpha` switch in the prototype.

---

## 3. RoboSports Network (RSN)

Community broadcast org. Partnered with FIRST for **PLAYxPLAY** and runs **FIRST Champs Live**:
"RedZone-style" whip-around coverage of all Championship fields on one stream, with live
commentary between matches, **instant replay and analysis**, and live alliance-selection coverage.
Their **GameSense** tooling pulls from the FRC API to drive on-air data.

**What we're borrowing:**
1. The whip-around/"desk" format is a studio position that owns the gaps between matches. At a
   one-field event like CalGames, the gaps *are* the product.
2. Instant replay + analysis as a named, staffed segment, not an accident.
3. Data-driven graphics fed by an API rather than typed by an operator.

---

## 4. FRC event A/V, as actually practiced

- **Audience Display machine**: separate box, wired to FMS, owns graphics + game audio. Often
  A/V's responsibility.
- **Switcher**: Blackmagic ATEM class. Field wide, alliance-side cameras, pit/desk cam, plus the
  overlay on a downstream key.
- **Stream**: CalGames has historically streamed on YouTube (2025 ran three separate day-long
  streams). Sound from the venue mixer, graphics from the display machine.
- **Automation**: FMS-driven via OBS scenes or Companion, as above. The community norm is
  Companion + Stream Deck for the operator surface.
- **Reality check from CalGames 2025:** a venue power outage killed the Sunday stream mid-event
  and forced a restart on a new URL. Any design that doesn't survive a power blip is a fiction.
  UPS + local recording is not optional.

---

## 5. Public data APIs

| API | Base | Auth | Use for us |
| --- | --- | --- | --- |
| **FRC Events API v3** | `https://frc-api.firstinspires.org/` | username + token (free, self-serve; non-commercial) | official schedule/results/rankings when the event runs FMS |
| **The Blue Alliance v3** | `https://www.thebluealliance.com/api/v3` | `X-TBA-Auth-Key` header | team metadata, avatars, historical data, match videos |
| **TBA Trusted API v1** | write API | event-specific auth id/secret | **publishing CalGames results live to TBA**. This is how off-season events get real-time results out. Cheesy Arena does this natively. |
| **Statbotics** | `https://api.statbotics.io` | none | EPA ratings incl. component EPAs (auto/teleop/endgame) and ranking-point EPAs, for pre-match prediction graphics |
| **start.gg** | `https://api.start.gg/gql/alpha` | bearer token, GraphQL | Smash bracket data (see [05-arcade.md](05-arcade.md)) |

TBA also runs **GameDay**, a multi-stream FRC viewing page, and the **Event Wizard** for
off-season data entry (schedules, rankings, results, match videos, awards).

---

## 6. 2026 game: REBUILT (presented by Haas)

Needed so the scoreboard graphics are correct.

**Timing.** AUTO 0:20 → TELEOP 2:20 (Transition Shift 0:10, Shifts 1-4 at 0:25 each, End Game 0:30).
Total 2:40.

**Scoring.**

| Action | AUTO | TELEOP |
| --- | --- | --- |
| FUEL into an **active** HUB | 1 | 1 |
| FUEL into an **inactive** HUB | 0 | 0 |
| TOWER Level 1 | 15 | 10 |
| TOWER Level 2 | N/A | 20 |
| TOWER Level 3 | N/A | 30 |

Max 2 robots earn Level 1 in AUTO; one level per robot in TELEOP.

**Ranking points.** Win 3 / Tie 1. Bonus RPs (regional thresholds):
`ENERGIZED` = 100 fuel · `SUPERCHARGED` = 360 fuel · `TRAVERSAL` = 50 tower points.

**Hub state.** Both hubs active in AUTO, Transition Shift, and End Game. During Shifts 1-4 the
hubs **alternate active/inactive** based on AUTO performance.

> **Broadcast implication.** The alternating hub state is the most confusing thing on the field
> for a viewer, and it's the thing our overlay can fix. A persistent "which hub is live right now"
> indicator plus a shift-clock is probably the single most valuable graphic we ship. Cheesy
> Arena's audience display already tracks a hub indicator, and we mirror that.

**Field volume.** 504 FUEL total, depots and outpost chutes at 24 each, up to 8 preloads per robot.

---

## 7. Telestration prior art

| Tool | Approach | Take |
| --- | --- | --- |
| [WebRTC-Telestrator](https://github.com/BlankSourceCode/WebRTC-Telestrator) | phone/tablet draws, OBS Browser Source renders | closest to our model; validates the two-surface split |
| [TransparentPaint](https://github.com/sam0737/TransparentPaint) | stylus on a transparent window snapped to an OBS projector, served over HTTP | good for a Windows-native fallback |
| Dewdle | OBS + broadcast keyer output | shows the keyer path matters |

All three confirm the right shape: **draw surface ≠ render surface**, and the render surface is a
transparent browser page. None of them are CalGames-themed, none know what a match clock is, and
none can freeze a replay frame. That's our delta.

---

## Sources

- [FMS Manual](https://fms-manual.readthedocs.io/en/latest/) ·
  [FMS Whitepaper](https://fms-manual.readthedocs.io/en/latest/fms-whitepaper/fms-whitepaper.html) ·
  [Network Hardware Configuration](https://fms-manual.readthedocs.io/en/latest/off-season-fms/configuration/network-hardware-configuration.html) ·
  [Off-Season FMS requirements](https://fms-manual.readthedocs.io/en/latest/off-season-fms/configuration/about-off-season-fms-and-requirements.html) ·
  [About Audience Display](https://fms-manual.readthedocs.io/en/latest/audience-display/about/about.html) ·
  [BitFocus Companion integration](https://fms-manual.readthedocs.io/en/latest/audience-display/automation/bitfocus-companion.html) ·
  [OBS WebSockets integration](https://wpilib.screenstepslive.com/s/fms/m/audience/l/1208601-obs-websockets)
- [Cheesy Arena](https://github.com/Team254/cheesy-arena) ·
  [README](https://github.com/Team254/cheesy-arena/blob/main/README.md) ·
  [Wiki](https://github.com/Team254/cheesy-arena/wiki) ·
  [Cheesy Arena Lite](https://github.com/Team254/cheesy-arena-lite) ·
  [cheesy-arena-rpi](https://github.com/Team254/cheesy-arena-rpi) ·
  [Chief Delphi announcement](https://www.chiefdelphi.com/t/team-254-presents-cheesy-arena/138158)
- [RSN + FIRST PLAYxPLAY](https://blog.thebluealliance.com/2019/03/01/first-partners-with-robosports-network-for-playxplay/) ·
  [FIRST Champs Live 2026](https://www.chiefdelphi.com/t/first-champs-live-2026-frc-and-ftc-with-rsn/519530) ·
  [RSN on GitHub](https://github.com/RoboSportsNetwork)
- [FRC Events API docs](https://frc-api-docs.firstinspires.org/) ·
  [API registration/info](https://frc-events.firstinspires.org/services/API) ·
  [TBA APIv3](https://www.thebluealliance.com/apidocs/v3) ·
  [TBA Trusted APIv1](https://www.thebluealliance.com/apidocs/trusted/v1) ·
  [TBA GameDay](https://www.thebluealliance.com/gameday) ·
  [Statbotics](https://www.statbotics.io/) ·
  [EPA model intro](https://www.statbotics.io/blog/intro)
- [2026 REBUILT game overview](https://www.frcmanual.com/2026/game-overview) ·
  [game details](https://www.frcmanual.com/2026/game-details) ·
  [official manual](https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm)
- [CalGames 2026 announcement](https://www.chiefdelphi.com/t/calgames-2026-oct-16-18/522436) ·
  [CalGames 2025 thread](https://www.chiefdelphi.com/t/calgames-2025-oct-3-5/502690) ·
  [calgames.org](https://www.calgames.org/) · [WRRF](https://wrrf.org/)
- [Nexus for FIRST guides](https://guides.frc.nexus/)
