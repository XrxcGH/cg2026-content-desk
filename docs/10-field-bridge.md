# 10 — The field bridge

**Operating rule:** any software is fine as long as it cannot interfere with Cheesy Arena actually
controlling the field. Reading data for overlays is fine. Accidentally stopping a match or
corrupting game-piece scoring is not.

That's a much better bar than "don't mutate anything," because it's the one that actually matters —
and because Cheesy Arena's code splits along exactly that line.

---

## The safety boundary is structural, not a promise

`websocket.HandleNotifiers()` **never calls `Read()`**. It selects over notifier channels, writes
outbound frames, and pings every 10s to detect a dead client. That's the entire loop.

So any handler whose body is `ws.HandleNotifiers(...)` is **incapable of processing anything we
send.** Not "won't" — *can't*. We could fire arbitrary frames at it all weekend and nothing would
be read. That is a far stronger guarantee than a code review of our own client.

Command-capable handlers are the ones with a read loop, and they are exactly the ones that can hurt
the event:

| Endpoint | Commands it accepts | Why it's forbidden |
| --- | --- | --- |
| `/match_play/websocket` | `startMatch`, **`abortMatch`**, `loadMatch`, `substituteTeams`, `toggleBypass`, `commitAndPost`, `discardResults`, `startTimeout`, `signalReset`, … | **Literally stops a match.** Also discards results |
| `/panels/scoring/{position}/websocket` | **`autoTower`**, **`endgame`**, **`addFoul`**, `commitMatch` | **Literally is game-piece scoring.** Corrupts the official score |
| `/panels/referee/websocket` | fouls, cards | corrupts the official score |
| `/alliance_selection/websocket` + POSTs | picks, finalize, reset | destroys alliance selection |
| `POST /setup/*` | everything | `POST /setup/db/clear/{type}` and `/setup/db/restore` **wipe or replace the event database** |

## The allowlist

Hard-coded in the client. Not a config file, not a convention — a constant, with a unit test that
fails if anything else appears.

**Allowed — WebSocket (all `HandleNotifiers`-only, verified):**

| Endpoint | Gives us |
| --- | --- |
| `/api/arena/websocket` | `matchTiming`, `matchLoad`, `matchTime` |
| `/displays/audience/websocket` | `realtimeScore`, `scorePosted`, `lowerThird`, `audienceDisplayMode`, `allianceSelection`, `playSound`, `matchLoad`, `matchTime` |
| `/displays/queueing/websocket` | queueing + `eventStatus` |
| `/displays/field_monitor/websocket` | `arenaStatus` — station health, robot comms. Powers the "what happened to 846?" replay marker |
| `/displays/rankings/websocket` | live rankings |
| `/displays/bracket/websocket` | playoff bracket state |

**Allowed — HTTP, `GET` only:**
`/api/matches/{type}` · `/api/rankings` · `/api/alliances` · `/api/teams/{id}/avatar` ·
`/api/bracket/svg` · `/api/sponsor_slides`

**Forbidden — everything else**, and specifically every path in the table above.

### Verifying a new endpoint before adding it

One command. If it prints nothing, the handler cannot read from us:

```bash
sed -n '/WebsocketHandler/,/^}/p' web/<name>.go | grep -n '\.Read(' || echo SAFE
```

Do this for any endpoint someone wants to add in September. It takes ten seconds and it's the
whole safety argument.

---

## Client rules

1. **Receive-only websockets.** Our WS client never sends an application frame. Protocol-level
   pong is handled by the library; nothing above that layer can write. Belt-and-suspenders on top
   of the structural guarantee.
2. **`GET`-only HTTP, enforced in the wrapper.** The client physically cannot construct another
   method. `POST /setup/db/clear/matches` is one typo away from ending the event; make it
   unreachable rather than merely unwise.
3. **Path allowlist checked at call time**, against the constant above. Reject and log, don't warn.
4. **Reserved `displayId`, coordinated with the scorekeeper.** This is now the top *real* risk:
   registering with an ID a genuine audience display uses could reconfigure that display. Agree
   `contentdesk1`…`contentdesk4` (or whatever they prefer) in advance, and always pass it
   explicitly — connecting without one makes Cheesy allocate an ID and redirect.
5. **Connection budget:** one WS per allowed endpoint, one concurrent HTTP request. Polling floors
   of 60s (3s only in the post-match window).
6. **Exponential backoff with jitter, 1s → 60s, plus a circuit breaker.** A reconnect storm during
   a field reset is now the most plausible way this project causes a problem.

## The one remaining way we could actually interfere

Not the API — **the host**.

Cheesy Arena is a *single Go process* that runs the web server, the arena loop talking to driver
stations, PLC I/O, and LED/DMX output. Starve that process of CPU, disk, or NIC and you are
genuinely affecting field control.

So:

- **Never run any of our software on the FMS machine.** Not the bridge, not OBS, not a "small"
  helper script. The bridge is our box.
- **Don't co-locate our recording or encoding** anywhere near it — those are the I/O-hungry ones.
- Our UPS, our power, our switch. If our rack browns out, the field doesn't notice.
- Keep the field-side NIC quiet: no default gateway, no DNS, and disable NetBIOS/LLMNR/mDNS/network
  discovery on that adapter. Windows will otherwise broadcast discovery chatter across the field
  network all weekend. It won't stop a match, but it's free to avoid.
- **Kill switch**, documented and rehearsed: `Disable-NetAdapter -Name "Field" -Confirm:$false`, or
  pull the cable. Everything downstream degrades to manual and keeps running.

## What the relaxed constraint buys us

Registering as a display was the blocker on live data, and it's now in scope. That restores:

- **Live in-match score** on the broadcast, `authoritative`, not a shadow-scorer guess.
- **`score.delta` synthesis** → automatic replay markers for scoring bursts, lead changes, and
  climbs — see [02-architecture.md](02-architecture.md). This was the single highest-value derived
  signal in the design and it's back.
- **`arenaStatus`** → "robot dropped" markers and a station-health strip on the desk console.
- **`playSound` / `audienceDisplayMode`** → our cue engine can follow the scorekeeper's screen
  changes instead of guessing at them.

It also means the rest of the stack is unconstrained: OBS, vMix, NodeCG, Companion, ffmpeg,
whatever fits. The only line is the allowlist above.

---

## FTA sign-off sheet

*Print it. Get it initialed Friday. Keep a copy at the field.*

> **CalGames 2026 Content Desk — field network connection**
>
> **What:** one host, one Ethernet cable, into a port you designate on the Cheesy Arena network.
> **Purpose:** read match data to drive broadcast graphics and replay.
>
> **Guarantee — structural, not procedural.** We connect only to Cheesy Arena endpoints whose
> handlers are `HandleNotifiers`-only. That function never calls `Read()`, so those endpoints
> cannot process anything we send, by construction.
>
> **We never connect to:** `/match_play/*` (start/abort match), `/panels/scoring/*` (game-piece
> scoring), `/panels/referee/*` (fouls/cards), `/alliance_selection/*`, or any `/setup/*`.
> The HTTP client cannot construct a non-`GET` request.
>
> **Endpoints we do use:** `/api/arena/websocket`, `/displays/{audience,queueing,field_monitor,rankings,bracket}/websocket`,
> and `GET` on `/api/matches`, `/api/rankings`, `/api/alliances`, `/api/teams/*/avatar`, `/api/bracket/svg`.
>
> **Display registration:** we register as display ID `________` (agreed with the scorekeeper) so
> we can't collide with a real audience display. Listener only.
>
> **Load:** one websocket per endpoint, one HTTP request at a time, 60s polling (3s post-match),
> exponential backoff and a circuit breaker on failure.
>
> **Isolation:** nothing of ours runs on the FMS machine. Separate host, separate UPS, separate
> switch. No default gateway or DNS on the field NIC; Windows discovery protocols disabled.
>
> **Full request audit log available at any time.**
>
> **If anything looks wrong:** pull the cable. Nothing on the field depends on us; we fall back to
> manual operation and the event is unaffected.
>
> Contact: ______________ · Display ID: ______ · FTA initials: ______ · Date: ______

---

## Verify before October

- [ ] Run the whole ingest against a local `cheesy-arena -dev` instance through a simulated match.
      One evening, de-risks everything.
- [ ] Unit test asserting the endpoint allowlist — it should fail if anyone adds a `/panels/` or
      `/match_play/` path.
- [ ] Unit test asserting the HTTP client rejects every method except `GET`.
- [ ] Kill Cheesy Arena mid-match; confirm we back off cleanly instead of hammering.
- [ ] Wireshark the field NIC for five minutes; confirm nothing but allowlisted traffic. Bring the
      capture to the FTA conversation — more persuasive than any promise.
- [ ] Agree the reserved `displayId` with the scorekeeper, in writing.
- [ ] Rehearse the kill switch.
