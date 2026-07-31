# 11: Recording, streaming, and publishing

Four requirements:

1. Auto-record every match → upload to YouTube → link on The Blue Alliance
2. Matches that got strategy analysis (some, not all) → record and upload separately
3. Between-match content (trivia, video game comps, human player matches) → optional record/upload
4. Live-stream the whole display to YouTube **and** TBA in real time on competition days

All four are the same machine with different bounds and different metadata. That's the design.

---

## One correction up front: TBA does not ingest video

**The Blue Alliance has no video ingest.** There is no RTMP endpoint, no second encoder, no
simulcast. TBA *embeds* a stream that lives somewhere else. Its GameDay page shows YouTube and
Twitch players.

So "live-stream to YouTube and TBA" is **one stream to YouTube**, plus a small API call telling TBA
where it is:

```
POST /api/trusted/v1/event/2026cacg/info/update
{ "webcasts": [{ "url": "https://youtube.com/watch?v=..." }] }
```

There is no dedicated webcast endpoint in the Trusted API: the webcast list rides as a field on
the event-info update, and that field **overwrites the existing list** every time. Registering a
stream means sending the full set of webcasts the event should have; pulling one at end of day
means sending the list without it.

That's the whole TBA side of live streaming. It simplifies the rig considerably: one encoder, one
destination, no bonded uplink, no second bitrate budget.

Same story for video-on-demand: we upload to YouTube, then hand TBA the **YouTube video id**.

---

## The Trusted API surface we use

Checked against the Trusted API v1 swagger spec in the TBA repository, July 2026. The spec has
exactly ten paths; every write is a `POST` and `GET /event/{key}/info` is the only read. An
earlier revision of this document listed `PATCH`/`DELETE` webcast endpoints and a
`match_videos/delete`; none of those exist, so nothing operational may depend on them.

| Endpoint | Method | We use it for |
| --- | --- | --- |
| `/event/{key}/info/update` | `POST` | its `webcasts` field registers the live stream on TBA/GameDay. Overwrites the whole webcast list, so always send the full desired set, and send *only* the `webcasts` key |
| `/event/{key}/match_videos/add` | `POST` | link an uploaded match video to its match key |
| `/event/{key}/media/add` | `POST` | event-level video (analysis segments, fun content) |

There is no way to *remove* a match video: per the spec, the endpoint allows addition only. A
mislinked video is fixed by adding the right one and asking a TBA admin to pull the wrong link
(see Failure handling).

**Auth** is not a bearer token. Two headers:

```
X-TBA-Auth-Id:  <auth_id>
X-TBA-Auth-Sig: md5_hexdigest(auth_secret + request_path + request_body)
```

The signature covers the path *and* the exact body bytes, so the body must be serialised once and
both signed and sent. Serialise twice and you'll get intermittent 401s that look like a
credentials problem and aren't.

### The rule that keeps us out of trouble

> **Cheesy Arena owns match data on TBA. We own video only.**

Cheesy Arena publishes teams, matches, rankings, alliances, and awards natively. We must **never**
call `matches/update`, `matches/delete`, `rankings/update`, `alliance_selections/update`,
`awards/update`, or `team_list/update`. Those endpoints require the *full* dataset, so a partial
write **deletes everything not included** rather than merely conflicting.

Our allowlist is exactly three paths: `info/update` (sent with the `webcasts` key alone, since
the same endpoint could rewrite event metadata), `match_videos/add`, and `media/add`. Same
enforcement pattern as the field bridge in [10-field-bridge.md](10-field-bridge.md): a constant,
with a test that fails if anything else appears.

---

## YouTube: the two limits that actually bite

**Quota is no longer the problem.** `videos.insert` used to cost ~1600 units against a default
10,000/day (six uploads a day, which would have killed this outright). Google cut it to roughly
**100 units** in December 2025, so the default project quota now supports on the order of 100
uploads/day. That's enough for a CalGames weekend (~80 quals + playoffs).

*Verify this in your own Cloud console before October rather than trusting this document.
It's a recent change and the number is the whole feasibility argument.*

**Channel upload limits are the real problem.** Separately from API quota, YouTube caps how many
videos a *channel* can upload per day, and the cap is low for channels without verification and
history. A brand-new CalGames channel can hit it well before the API quota. Mitigations, in order:

- Use an established channel (WRRF's existing one) rather than creating a fresh one for 2026
- Verify the channel (phone) **now**, not in October
- Stage uploads across the weekend rather than dumping Saturday's matches in one burst

**Live streaming needs enabling 24h in advance.** First-time live activation on a channel has a
waiting period. Enable it in July.

---

## Bandwidth: why uploads are deferred by default

A high-school gym uplink has to carry the live stream, and the live stream is the priority. Pushing
40 match videos up during competition hours will contend with it and put visible bitrate drops on
the broadcast.

Policy, configurable, defaulting to safe:

| Mode | Behavior |
| --- | --- |
| `deferred` **(default)** | Record and queue during the event. Upload after the venue closes, or after the event entirely. |
| `trickle` | Upload during the event, hard-capped well under the live stream's headroom, paused automatically during matches. |
| `live` | Upload as soon as a video is cut. Only if the venue has real bandwidth. Test it on Friday. |

The queue is durable either way, so `deferred` costs nothing but patience. **The stream never
competes with an upload.**

---

## Architecture

```
  cameras ──▶ ffmpeg rolling record (ISO)  ──────────────▶ replay clips
                                                            (docs/04)
  program ──▶ ffmpeg rolling record (program) ──┐
     │                                          │
     └──────▶ RTMP ──▶ YouTube Live             │
                         │                      │
                         └─▶ TBA info/update    │
                             (webcast list)     │
                                                ▼
   match.start / match.score_posted ──▶  Segment Cutter
   desk "mark analysis" / "mark in-out"        │
                                               ▼
                                     ┌──────────────────┐
                                     │  Publish Queue   │  durable, on disk
                                     │  pending →       │  survives crash,
                                     │  cut → uploading │  venue outage,
                                     │  → uploaded →    │  and the event
                                     │  linked → done   │  ending
                                     └────────┬─────────┘
                                              │
                          ┌───────────────────┴──────────────┐
                          ▼                                  ▼
                  YouTube videos.insert            TBA match_videos/add
                  (resumable upload)               or  media/add
```

### Cut from the program feed, not a camera

Match videos on TBA and YouTube should be **the broadcast**: overlay, score bar, replays and all.
That's what people actually want to watch, and it's what makes the CalGames graphics worth having
built. So the recorder captures the composited program output *in addition to* the ISO cameras.

- **Program record** → archive, match videos, uploads
- **ISO camera records** → replay source ([04](04-replay-and-telestrator.md))

### Cut bounds come from the event log, and a match video is two parts, not one

The dual-clocked event log ([02](02-architecture.md)) has exact wall-clock timestamps for
`match.start`, `match.end`, and `match.score_posted`, so a cut is a lookup rather than a guess.

**A match video must not run straight through**, because the gap between the buzzer and the score
being posted is unbounded. Referees deliberating fouls and cards routinely take minutes, and
nobody wants to watch an empty field while that happens. So the cut is two ranges with the dead
air removed:

```
   ┌─ part 1: the match ──────────────────┐        ┌─ part 2: the reveal ─┐
   │                                      │   ✂    │                      │
   ▼                                      ▼        ▼                      ▼
 start−8s ······ START ······ buzzer ··· +6s   posted−2s ······· posted+15s
   │                                                    │
   └── catches the announcer's "three, two, one, GO"    └── the score animation
```

| Window | Why |
| --- | --- |
| **pre-roll 8s** before `match.start` | `match.start` is the green light; the announcer's *"three, two, one, GO"* lands just before it. Opening on the countdown is the difference between a broadcast and a clip. |
| **post-match 6s** after `match.end` | the horn, robots coasting, the first celebration |
| **lead-in 2s** before `match.score_posted` | a beat before the score screen animates on |
| **reveal 15s** | the reveal, RP pips, ranking movement |
| **merge threshold 8s** | if scoring came through fast, run it straight through, since a jump cut over four seconds reads as a glitch, not an edit |

Tune these against the real venue on Friday; announcer cadence and field-light timing vary. They
live in `CUT` in `apps/core/src/clips.ts`.

Verified end to end against a compressed match with a deliberate 20s referee delay: two parts,
28.0s + 17.0s, 45.03s output at 1920×1080, with 12s of dead air removed. A 4-second delay collapses
to a single continuous 187s cut, and a match whose score is never posted falls back to one part.

| Content type | In | Out | Destination |
| --- | --- | --- | --- |
| **match** | two-part cut above | | YouTube + `match_videos/add` |
| **analysis** | first `telestrator.stroke` − 20s | last stroke + 15s | YouTube + `media/add` |
| **segment** | desk marks in | desk marks out | YouTube + `media/add`, optional |

Analysis segments are detected automatically. The telestrator already emits one durable
`telestrator.stroke` event per finished stroke, so "did this match get analysis?" is a query, not a
checkbox somebody has to remember to tick. The desk can still force one on or off.

Extraction is the same ffmpeg concat-and-trim the replay service uses, at different bounds. One
implementation.

### Non-match segments: the parts of the day that aren't a match

Alliance selection decides the afternoon and is never rewatchable; families who leave before the
ceremony never see their team's award. `queueSegment()` in `apps/core/src/publish/queue.ts` covers
these as their own `segment` queue items: the operator marks in and out (`POST /api/publish/segment`
with `fromMs`/`toMs`), and the clip is cut from the program recording like any other.

Four segment ids come pre-named in `apps/core/src/publish/naming.ts`'s `SEGMENTS` map, so the video
title matches the official-channel style without anyone typing it by hand:

| Id | Title |
| --- | --- |
| `selection` | Alliance Selection |
| `awards` | Awards Ceremony |
| `opening` | Opening Ceremony |
| `closing` | Closing Ceremony |

Anything else passed as the segment is taken as a literal title, which is how a single award gets
its own video (`FIRST Impact Award - CalGames`). None of these carry a TBA match key, so they link
to the event as media (`media/add`) rather than to a match.

### QC hold: an implausible cut never publishes quietly

FIRST's own auto-uploader has shipped 11-second "match videos" and whole wrong matches. The queue
guards against the same failure here: every kind of item has a plausible duration range
(`QC_BOUNDS` in `queue.ts`, e.g. 60-900s for a match, 30-7200s for a segment), and a cut outside its
range is parked in the `held` state with a reason attached instead of moving on to upload. Releasing
it is the same `POST /api/publish/release` action that lets a `deferred`-mode queue go at end of
day. There's no desk-console panel listing held items yet, so operating this in October means
someone with `GET /api/publish` open to see what's stuck (see Failure handling below).

### Day-VOD chapters

The full-day stream is exactly the unnavigable eight-hour recording the community asks a splitter
for. `apps/core/src/chapters.ts` walks the event log and turns every `match.start`, `award.presented`,
and the first `alliance_selection.update` into a chapter, backing up 15 seconds so it opens on the
announcer's countdown rather than mid-auto. `GET /api/chapters` (gated, desk-only) returns the list
and a paste-ready text block for the YouTube description.

YouTube enforces its chapter rules strictly and silently: the first chapter must sit at `0:00`,
there must be at least three, every one must run at least ten seconds, and they must be ascending.
Break any one of those and YouTube shows no chapters at all with no error, so `chapters.ts` enforces
them before handing anything back rather than leaving the operator to find out on a live VOD.

### Naming: matches the official FIRST channel

So CalGames content sits alongside official uploads instead of looking homemade. Titles are
`{match} - {event}`; livestreams are `{year} {event} - Day {n}`.

| Field system says | Title | TBA key |
| --- | --- | --- |
| `Qualification 42`, `Q42`, `qm42` | `Qualification 42 - CalGames` | `qm42` |
| `Playoff 5`, `Match 5` | `Match 5 (R2) - CalGames` | `sf5m1` |
| `Match 1 (R1)` | `Match 1 (R1) - CalGames` | `sf1m1` |
| `Final 1` | `Final 1 - CalGames` | `f1m1` |
| `Final 3`, `Final Tiebreaker` | `Final Tiebreaker - CalGames` | `f1m3` |
| `Practice 3` | *never published* | |

Playoff titles carry the `(Rn)` round suffix from the 13-match double-elimination bracket, and a
third final **is** the tiebreaker however the field system spells it.

Descriptions follow the official layout:

```
Final Tiebreaker - CalGames
Red (Teams 6238, 1323, 254) - 552
Blue (Teams 6665, 1678, 9470) - 527
https://www.thebluealliance.com/event/2026cacg

Uploaded by the CalGames Content Desk
(c) 2026 Western Region Robotics Forum
```

> **One deliberate difference.** FIRST's own descriptions close with
> *"(c) 2026 FIRST Robotics Competition"*, which is theirs to claim. CalGames is a WRRF off-season event,
> so copying that line verbatim would be inaccurate. The credit and copyright lines are
> configurable and default to WRRF.

All of it lives in `apps/core/src/publish/naming.ts` and is covered by tests, because a title
typo'd across 80 uploads is not something you fix afterwards.

Uploading **unlisted first and flipping to public only after the TBA link succeeds** means a failed
link never leaves an orphan video with no context.

---

## Live stream

- One OBS/vMix output → YouTube RTMP (`rtmp://a.rtmp.youtube.com/live2`, stream key from YouTube
  Studio).
- On stream start, register the YouTube URL on TBA: `POST info/update` with the full `webcasts`
  list. At end of day, send the list without it. Nothing fires this automatically on stream
  start or stop today, so it belongs on the day-of checklist rather than in anyone's mental
  model of "the desk handles it".
- **Local recording never stops**, independent of the stream. This is the second reason to prefer
  rolling record over a replay buffer, and the direct lesson from the CalGames 2025 power outage
  that killed the Sunday stream and forced a restart on a new URL. If the stream dies, the archive
  and every match video survive untouched.
- Pre-create the backup stream key and post the fallback URL **before** the event.
- Game audio from the arcade stays out of the stream mix ([05-arcade.md](05-arcade.md)), and the
  event's Spotify playlist exists on the HOUSE bus only ([06](06-hardware-and-network.md)). A
  Content ID claim can mute or block the archive, and the archive is what teams watch afterward.
- **Enable YouTube automatic captions** on the live stream. It's near-zero effort, a real
  accessibility win, and the clean mic bus from [06](06-hardware-and-network.md) is what makes them legible.

### The second stream: a clean static full-field feed

The community's most repeated production demand is a full-field view that never cuts away.
Remote scouts and picklist meetings depend on it, and every produced show eventually takes a
tight shot at the wrong moment. Where events run two streams, one is always a clean wide.

- Second OBS output (or a second cheap encoder box): the **static field-wide camera** plus the
  minimal score bar only. That is what `/s/program?mode=clean&key=alpha` renders. Score bar and
  clock, no screen switching, no lower thirds, no status cards, locked to the match layout.
- Second YouTube stream key on the same channel, listed on TBA as an additional webcast.
- **Shed it first** when the uplink degrades. The produced show is the product; the clean feed
  is a courtesy.

### Degraded-uplink runbook

Venue uplink trouble is a "when". Decide the moves now, not on Saturday:

1. **Watch the encoder, not chat**: OBS dropped-frames percentage is the early warning. Check it
   at every match break.
2. First move: **stop the clean feed** (frees its full bitrate).
3. Second move: switch the main stream to the pre-built **low-bitrate OBS profile**
   (720p30 @ ~2.5 Mbps). Make this profile before the event so the switch is two clicks.
4. `deferred` upload mode already keeps match uploads off the uplink during show hours.
5. **Local recording never stops** regardless: replays, match videos, and the archive do not
   depend on the internet at all.

---

## Failure handling

Every one of these is a "when", not an "if":

| Failure | Behavior |
| --- | --- |
| Venue internet drops | Queue keeps cutting and queueing. Nothing is lost. Uploads resume on reconnect. |
| Upload fails mid-file | Resumable upload, restarting from the last committed byte, not byte zero. |
| YouTube quota exhausted | Each item retries with backoff, then goes `failed` after 6 attempts, which a quota outage burns through in about two minutes. The queue does not park itself or resume on its own: recovery is per-item, `POST /api/publish/retry/{id}`, after the quota resets. `deferred` staging is the real protection. |
| Channel upload cap hit | Same failure path, same per-item retry. This is why `deferred` staging and an established channel matter. |
| TBA link fails | Video stays unlisted, item stays `uploaded`, retried. Never silently public-and-unlinked. |
| Core restarts | Queue is on disk. It reloads and carries on. |
| Wrong match linked | The Trusted API cannot remove a video. Add the correct video to the correct key, then ask a TBA admin (contact@thebluealliance.com) to pull the wrong link. |

The queue is deliberately boring: a JSON file, a state machine, and exponential backoff. Every
item's state, including anything `held`, is readable at `GET /api/publish` (gated, so an operator
needs to be signed in). Nobody should have to SSH into anything on Sunday, but there is no
desk-console panel over that endpoint yet: today, "what's stuck" means someone reading the JSON,
not a screen built for it.

---

## Open items before October

- [ ] Which YouTube channel: WRRF's existing one is strongly preferred over a new one
- [ ] Verify the channel and enable live streaming (24h activation). **Do this in July**
- [ ] Confirm `videos.insert` quota cost in the Cloud console; request an increase if it's still 1600
- [ ] Get the TBA event key (`2026cacg`) and Trusted API auth id/secret from TBA
- [ ] Confirm with the CalGames committee that Cheesy Arena's TBA credentials and ours are scoped so
      we never touch match data
- [ ] Measure the venue uplink on Friday and pick the upload mode from real numbers
- [ ] Decide whether fun content goes on the CalGames channel or stays unlisted by default
