# 06 — Hardware, network, and show flow

## Network: the field is sacred

The FMS field network is VLAN-segmented so every team's driver station is isolated from every
other team's and from field electronics. FMS lives at `10.0.100.5`. **The content desk does not
live on that network.**

```
   ┌──────────────────────── FIELD NETWORK (FTA owns) ────────────────────┐
   │  FMS / Cheesy Arena  ·  team VLANs  ·  field AP  ·  station cabinets │
   └──────────────────────────────┬───────────────────────────────────────┘
                                  │  ONE cable. Read-only. FTA-approved.
                        ┌─────────▼──────────┐
                        │      bridge        │  2 NICs, no routing, no NAT
                        │  eth0: field side  │  · reads Cheesy Arena WS
                        │  eth1: production  │  · receives FMS Companion POSTs
                        └─────────┬──────────┘  · publishes to production only
                                  │
   ┌──────────────────────────────▼────────────────────────────────────────┐
   │            PRODUCTION LAN  10.20.0.0/24  (content desk owns)          │
   │  core · replay · OBS · ATEM · telestrator AP · consoles · side screens│
   └───────────────────────────────────────────────────────────────────────┘
```

Rules:

1. **Never touch a team VLAN. Ever.** Not to debug, not "just to check."
2. The bridge is the **only** machine with a foot in both networks, it initiates no writes to the
   field side, and IP forwarding is off. It is a consumer, not a router.
3. Get **written FTA sign-off** on the bridge before load-in, and bring a printed diagram. "Can I
   plug this into your field network" answered at 8am on Friday goes better with a diagram.
4. The production Wi-Fi AP runs on **5GHz, channels well clear of the field AP**, and is separate
   from the venue/team Wi-Fi. The telestrator tablet lives on it and nothing else does. 40 teams
   on a shared SSID will destroy your <80ms latency budget.
5. If the FTA says no to the bridge: the whole system still runs on manual desk input. Degraded,
   not dead. Design for this — it's a realistic Friday-morning outcome.

## Machines

| Box | Job | Spec notes |
| --- | --- | --- |
| **bridge** | field-side ingest | anything with 2 NICs — an Intel NUC or a mini PC. Low stakes. |
| **core** | event bus, surfaces, cue engine | modest; SSD for the NDJSON log. Can co-locate with bridge if budget is tight. |
| **program** | OBS, stream encode, all browser sources | the expensive one. NVENC-capable GPU (RTX 3060+), 32GB, NVMe. |
| **replay** | rolling record + clip extraction | **separate box.** Recording is I/O-heavy and a crash here must not take program down. Big fast NVMe — 4 cams × 1080p60 at 12Mbps ≈ 22GB/hour total. |
| **arcade** | console capture | can be the program box if it has the USB bandwidth; separate is safer |
| **tablet** | telestrator draw pad | iPad + Apple Pencil. Pressure sensitivity is a genuine upgrade over a finger. |

## Video

| Item | Recommendation | Why |
| --- | --- | --- |
| **Switcher** | Blackmagic **ATEM Mini Extreme ISO** | 8 HDMI in, multiview out, and it **ISO-records every input separately** — which is exactly the replay ingest described in [04](04-replay-and-telestrator.md), in hardware, for free. If you buy one thing, buy this. |
| **Field cameras** | 2× PTZ, HDMI or NDI | one wide (whole field, from the scoring table side), one tight/tracking |
| **Alliance cameras** | 2× fixed | one per alliance station — these are the angles that answer "did they actually climb?" |
| **Desk camera** | 1× on the analyst desk | needed the moment you have a telestrator; the audience should see who's talking |
| **Handheld** | 1× roaming | pits, celebrations, awards. Highest-value B-roll per dollar. |
| **Overlay path** | OBS Browser Source (alpha) **and** a keyed feed into the ATEM DSK (luma) | see the dual-key rule in [03-brand.md](03-brand.md) |

**Cable discipline:** HDMI over 25ft is unreliable. Use HDMI-over-Cat6 extenders or SDI converters
for the field camera runs. Label every cable at both ends on Friday. This advice is boring and it
is the difference between a good Saturday and a bad one.

## Audio

- Venue mixer feed → program (field sound, announcer, music)
- 2× desk mics (commentary/analysis) on their own channel, so they can be ducked under the
  announcer
- **Game audio from consoles routed to venue only, never to the stream** — see the Content ID note
  in [05-arcade.md](05-arcade.md)
- Match sounds (charge, endgame warning, buzzer) come from the Audience Display machine and go to
  the venue mixer; the stream gets them via the venue feed, not duplicated

## Power — learn from 2025

The CalGames 2025 Sunday stream died to a **venue power outage** and had to restart on a new
YouTube URL mid-event. That's the single most likely failure mode at a high school gym.

- **UPS on**: program, replay, core, bridge, switcher, and the network switch. Not the monitors.
  15 minutes of runtime is enough to survive a blip and to shut down cleanly if it isn't one.
- **Local recording never stops.** Even if the stream drops, the rolling record continues, so the
  archive and the replays survive. This is a second reason to prefer rolling record over the OBS
  replay buffer.
- **Pre-create the backup stream key** and have the fallback URL posted before the event, not
  scrambled for during it.
- Know which circuits the gym's outlets are on. Ask the facilities contact on Friday.

## Crew

| Role | Responsibility |
| --- | --- |
| **Producer / desk** | runs the rundown, calls cuts, owns the desk console. Can run the whole show alone in degraded mode. |
| **Switcher op** | ATEM, cameras |
| **Replay op** | markers, clip selection, TAKE |
| **Analyst** | on camera, drives the telestrator |
| **Play-by-play** | the other voice |
| **Arcade op** | brackets, station resets, arcade overlay |
| **Graphics/data op** | lower thirds, team facts, corrections — merge into producer if short-staffed |

Minimum viable crew is **three**: producer, switcher, analyst. Everything else is upside. Design
every surface so it's operable by someone who has been trained for 20 minutes on Friday night,
because that is who will be operating it.

## Show flow (per match)

| Cue | Trigger | Action |
| --- | --- | --- |
| **On deck** | `match.loaded` | queueing graphic on side screens, intro card armed |
| **Intro** | `match.preview` | 6-team intro card, EPA form line, PxP reads teams |
| **Armed** | `match.prestart` | switch to field wide, score bar in, lockdown motion |
| **Live** | `match.start` | score bar live, hub indicator on, replay markers arm |
| **Endgame** | `matchClock` 110 | endgame chip, tight camera on the towers |
| **End** | `match.end` | hold field wide 4s for the celebration — do not cut early |
| **Result** | `match.score_posted` | score reveal, RP pips, ranking movement |
| **Replay** | operator | gold wipe → clip → telestrate → back to desk |
| **Gap** | no match for >3 min | auto-cut to arcade or sponsor loop |

Every one of these has a manual override. The autopilot toggle is per-cue, not global, so the
producer can trust the parts that work and drive the parts that don't.
