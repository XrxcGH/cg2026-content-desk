# 06. Hardware, network, and show flow

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
   not dead. Design for this: it's a realistic Friday-morning outcome.

## Access: the shared PIN

Core itself isn't as private as owning the production LAN suggests. The desk runs on the venue
network, and at an event that network has a few hundred phones on it; the trivia QR code puts
core's address on a projector in front of the whole gym, so being on the content desk's own LAN is
not the same as being hard to reach. `apps/core/src/access.ts` gates every operator console and
every request that changes something (starting a match segment, cutting a clip, arming a cue)
behind one shared PIN, while leaving the overlays, the venue TVs, the two audience phone pages
(`/s/quiz`, `/s/next`), and the pit monitor kiosk (`/s/watch`, which only wraps screens that are
already open) open, since an OBS Browser Source cannot type a PIN and a spectator should not
have to.

The gate is on by default with the PIN `0864`, which is printed in this repo and therefore
public. Set the event's own before the desk goes anywhere near the venue network, not after.
With the launcher ([13-deployment.md](13-deployment.md)) that is `/pin:4726`; from the source it
is one line in the PowerShell window you start the desk from (the README's
"[Where these commands go](../README.md#where-commands-go)" note says how to open one):

```powershell
$env:REMOTE_PIN = "4726"; npm start -- --cheesy --cheesy-host 10.0.100.5:8080 --display-id contentdesk1
```

Startup logs which mode it's in and warns loudly if a venue-facing box comes up with the gate
off (an explicit empty `REMOTE_PIN`, the kitchen-table escape hatch).
It's one PIN, not per-volunteer accounts: the crew is a handful of people who arrive on the day, and
a password reset at 8am on a Saturday gets worked around by propping the door open. Hand it out to
crew the way you would a radio channel, not somewhere a phone camera in the stands could catch it.
Sign in once at `/signin` and the session lasts the day. Full open/gated surface list in
[README.md](../README.md).

## Machines

| Box | Job | Spec notes |
| --- | --- | --- |
| **bridge** | field-side ingest | anything with 2 NICs, like an Intel NUC or a mini PC. Low stakes. |
| **core** | event bus, surfaces, cue engine | modest; SSD for the NDJSON log. Can co-locate with bridge if budget is tight. |
| **program** | OBS, stream encode, all browser sources | the expensive one. NVENC-capable GPU (RTX 3060+), 32GB, NVMe. |
| **replay** | rolling record + clip extraction | **separate box.** Recording is I/O-heavy and a crash here must not take program down. Big fast NVMe: 4 cams × 1080p60 at 12Mbps ≈ 22GB/hour total. |
| **arcade** | console capture | can be the program box if it has the USB bandwidth; separate is safer |
| **tablet** | telestrator draw pad | iPad + Apple Pencil. Pressure sensitivity is a genuine upgrade over a finger. |

Getting the desk software onto the core box (or any borrowed laptop) is one exe and a
double-click: the launcher in [13-deployment.md](13-deployment.md) installs nothing system-wide
and needs no admin rights, which matters on AV loaner machines that arrive locked down.

## Video

| Item | Recommendation | Why |
| --- | --- | --- |
| **Switcher** | Blackmagic **ATEM Mini Extreme ISO** | 8 HDMI in, multiview out, and it **ISO-records every input separately**, which is exactly the replay ingest described in [04](04-replay-and-telestrator.md), in hardware, for free. If you buy one thing, buy this. |
| **Field cameras** | 2× PTZ, HDMI or NDI | one wide (whole field, from the scoring table side), one tight/tracking |
| **Alliance cameras** | 2× fixed | one per alliance station: these are the angles that answer "did they actually climb?" |
| **Desk camera** | 1× on the analyst desk | needed the moment you have a telestrator; the audience should see who's talking |
| **Handheld** | 1× roaming | pits, celebrations, awards. Highest-value B-roll per dollar. |
| **Overlay path** | OBS Browser Source (alpha) **and** a keyed feed into the ATEM DSK (luma) | see the dual-key rule in [03-brand.md](03-brand.md) |

**One overlay system on air.** When the content desk's program overlay is live, Cheesy Arena's own
overlay pages must never composite with it. Two scorebugs clip and contradict each other. Three
rules enforce this:

1. **In OBS it's automatic.** Name any source that shows a Cheesy Arena page with `cheesy` in the
   source name (e.g. `Cheesy audience display`). The desk sweeps every scene at connect and once a
   minute, and switches those sources off. This is deliberate: keep the naming convention.
2. **On the ATEM DSK**, only one fill is ever keyed: ours. The Cheesy audience display machine
   feeds the *venue projector* (the field's own screen), never the stream chain.
3. **The scorekeeper keeps the audience display in "Blank" mode** on any machine that IS in the
   stream chain. Put it on the FTA checklist ([10-field-bridge.md](10-field-bridge.md)).

**Cable discipline:** HDMI over 25ft is unreliable. Use HDMI-over-Cat6 extenders or SDI converters
for the field camera runs. Label every cable at both ends on Friday. This advice is boring and it
is the difference between a good Saturday and a bad one.

## Audio: two buses, and music never leaves the room

Copyrighted music on the stream bus is the single most common way FRC event streams die:
muted mid-match, VODs unpublished, channels struck, and it would Content-ID-flag every
match video this desk uploads. The fix is structural rather than a matter of vigilance. The
venue console runs **two mixes**, and the music source is physically absent from one of them.

| Source | HOUSE bus (PA) | STREAM bus (OBS / recordings) |
| --- | --- | --- |
| **Event Spotify playlist** (the DJ machine) | ✅ | ❌ **never** |
| MC / GA / emcee mics | ✅ | ✅ |
| Desk mics (commentary/analysis), ducked under the announcer | ✅ optional | ✅ |
| Match sounds from the Audience Display machine (charge, endgame, buzzer) | ✅ | ✅ |
| Field ambience mic (crowd + robots) | n/a | ✅ |
| Console game audio (arcade) | ✅ | ❌ **never** (see [05-arcade.md](05-arcade.md)) |

Rules that make it hold up all weekend:

1. **The stream bus is a mix-minus**: an aux send on the venue console that simply has no
   music or console channels routed to it. Nobody has to remember to mute anything: the
   fader that could ruin the stream doesn't exist on that bus.
2. **The event playlist plays through Spotify in-house only.** That keeps the PA energy
   without putting a single licensed track on YouTube. Nothing from that machine patches
   anywhere near the OBS input.
3. **Duck music under the announcer on the HOUSE bus** so the room can hear explanations
   (the perennial "announcer buried under music" complaint).
4. **No aggressive gating/compression on the stream bus.** Over-processed event recordings
   that chop crowd noise in and out are a documented community complaint; light leveling only.
5. **Rehearse both mixes Friday** and listen to the stream return feed from a phone.
   Echo and balance problems get called out by chat within minutes on show day.

**Closed captions** ride on this for free: enable YouTube Live automatic captions. With a
clean mic bus (no music bleed) auto-captioning is respectable, it's an accessibility win the
community has explicitly asked for, and it makes the archived VOD searchable.

## Power: learn from 2025

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
| **Graphics/data op** | lower thirds, team facts, corrections (merge into producer if short-staffed) |

Minimum viable crew is **three**: producer, switcher, analyst. Everything else is upside. Design
every surface so it's operable by someone who has been trained for 20 minutes on Friday night,
because that is who will be operating it.

## Show flow (per match)

| Cue | Trigger | Action |
| --- | --- | --- |
| **On deck** | `match.loaded` | queueing graphic on side screens, alliance overview up |
| **Intro** | `match.preview` | *planned, not built:* the 6-team intro card with the EPA form line is blocked behind the Statbotics feed ([03-brand.md](03-brand.md)), and no cue fires on `match.preview` yet. PxP reads teams off the overview instead |
| **Armed** | `match.armed` (every robot linked, before the announcer's countdown) | switch to field wide, score bar in, lockdown motion |
| **Live** | `match.start` | score bar live, hub indicator on, replay markers arm |
| **Endgame** | `matchClock` 110 | endgame chip. The camera stays wherever the switcher has it: the wide-shot lock stops autopilot from cutting away from the field mid-match, so a tight tower shot is the switcher op's call |
| **End** | `match.end` | hold field wide 4s for the celebration. Don't cut early |
| **Result** | `match.score_posted` | score reveal, RP pips, ranking movement |
| **Replay** | operator | gold wipe → clip → telestrate → back to desk |
| **Gap** | 3 min after a posted score, no match running | auto-cut to arcade |

Every row except Intro maps to a cue in the engine, each with a manual override. The autopilot
toggle is per-cue, not global, so the producer can trust the parts that work and drive the parts
that don't.
