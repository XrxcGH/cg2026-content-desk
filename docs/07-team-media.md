# 07 — Team media library + pre-match alliance overview

RSN-style: six robots on screen before the match, cut out on transparent backgrounds, three per
alliance, with team names and numbers. It's the single graphic that most makes a broadcast look
professional, and it's the one an offseason event can actually pull off because the robots are
sitting right there in the pits all weekend.

---

## The screen

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          QUALIFICATION 42                                 │
│  ┌─────────────────────────────┐ ┌──┐ ┌─────────────────────────────┐    │
│  │   ██     ██     ██          │ │  │ │          ██     ██     ██   │    │
│  │  robot  robot  robot        │ │CG│ │        robot  robot  robot  │    │
│  │  ─────  ─────  ─────        │ │  │ │        ─────  ─────  ───── │    │
│  │   846    1868    253        │ │VS│ │         100    115    670   │    │
│  │  Funky   Space   Boba       │ │  │ │        Wild-   MVRT   Home- │    │
│  │  Monkeys Cookies Bots       │ │  │ │        hats           stead │    │
│  │        RED ALLIANCE         │ └──┘ │        BLUE ALLIANCE        │    │
│  └─────────────────────────────┘      └─────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
```

**Red left, blue right — always**, matching the field as seen from the scoring table, and matching
the rule in [03-brand.md](03-brand.md) that alliance is never encoded by color alone. The gold rule
separates each alliance block from the purple chrome.

### Layout rules that make six mismatched photos look like a set

1. **Normalize by height, not width.** FRC robots vary enormously in footprint but much less in
   height. Scale each cutout so its alpha bounding box is a fixed *height*, and the six robots read
   as a family. Normalize by width and you get one robot the size of a bus next to one the size of
   a shoebox.
2. **Common floor line.** Every cutout's bottom edge sits on the same baseline, with a soft
   elliptical gradient shadow beneath it. This is the entire difference between "cut out" and
   "floating sticker."
3. **Never mirror a robot photo.** Flipping the blue side to face inward reverses bumper numbers
   and sponsor logos. Shoot every robot at the same 3/4 angle and let both alliances face the same
   direction — nobody notices, and mirrored `846` is the kind of thing that ends up on Chief Delphi.
4. **Text block is fixed height**, so a two-line team name doesn't shove the robot up. Team number
   in Archivo (tabular), name in Barlow Condensed, truncate at two lines.
5. **Optional third line** — rank, record, or EPA — driven off the event bus. Hidden entirely if the
   data is `estimated`.

Animation: robots stagger in at 60ms intervals, 250ms each, bottom-up. Total 500ms. Stop
animating in lockdown mode.

---

## Shooting the robots

Consistency beats quality. Six well-lit photos at the same angle look better than three great ones
and three phone snaps.

| | Spec |
| --- | --- |
| **Backdrop** | white seamless or foamcore, at least 2× robot width |
| **Angle** | front three-quarter, ~35° off axis, **same for every robot** |
| **Camera height** | robot mid-height, not standing eye level — shooting down makes robots look like toys |
| **Framing** | full robot, wheels to top, ~10% headroom, bumpers legible |
| **Pose** | signature configuration — arm up, intake deployed. A folded robot is unrecognizable. |
| **Resolution** | ≥3000px long edge; a cutout displayed 700px tall at 1080p needs headroom for crops |
| **Format in** | RAW or max-quality JPEG. Not a screenshot of a Slack image. |

### The white-backdrop trap — read this before shooting

**Most FRC robots are bare aluminum, white polycarbonate, and chrome.** On a pure white backdrop,
those are exactly the pixels an automated background remover will delete. You will get robots with
holes punched through their superstructure and it will not be obvious until it's on the screen at
1080p.

Two mitigations, use both:

1. **Add a rim/kicker light** — one light from behind-left or behind-right, raking the robot's
   edge. That edge highlight gives the masking tool a boundary to find. This is the fix.
2. **Expose the backdrop about one stop brighter than the robot but do not blow it to 255.** A
   backdrop that reads ~235–245 still separates cleanly and preserves edge detail. Pure 255 clips
   and takes the robot's highlights with it.

If you can, shoot on **light grey (~#D8D8D8) rather than white.** It cuts out just as easily, and
white robots stop disappearing into it. Worth raising with whoever's running the photo booth.

Use subject-aware masking (Photoshop *Select Subject*, `rembg`, Remove.bg) rather than
magic-wand-on-white. Then **check every cutout at 100% against a dark background** — that's where
white fringing and punched-through polycarb show up, and it's the background this graphic actually
uses.

---

## Asset spec

| | |
| --- | --- |
| Format | PNG-24 with alpha (WebP generated server-side) |
| Color | sRGB |
| Size | long edge 1600px, alpha bounding box trimmed to content |
| Weight | <1.5MB in, ~200KB out after processing |
| Shadow | **none baked in** — the render side draws the plinth shadow so it matches across all six |
| Naming | anything; the upload UI binds it to a team |

## Upload workflow

A `/s/media` operator surface — drag a folder of PNGs, assign team numbers, done. Designed to be
usable by a volunteer photographer on Friday night with no training.

On upload, `core` automatically:

1. **Verifies there's a real alpha channel.** No alpha → reject with "this looks like a JPEG, the
   background needs to be removed first."
2. **Runs the uncut-photo check.** Warn loudly if it looks like a photo whose background was never
   removed. *Implementation note, learned the hard way:* the obvious version of this test —
   "what fraction of the bounding box is opaque?" — **false-positives on real robots.** Plenty of
   FRC robots are a chassis-shaped brick that genuinely fills their own bounding box, and flagging
   those trains volunteers to ignore the warning. The discriminating signal is the **perimeter**:
   a genuine cutout has mostly-transparent top and side edges; an uncut photo is solid backdrop all
   the way round. The bottom edge is excluded, because a correctly cut robot sits flush on its own
   floor line. Verified against a robot-shaped silhouette (passes clean) and a full-frame opaque
   image (warns).
3. **Trims to the alpha bounding box** and records the original dimensions, so height
   normalization works without re-measuring at render time.
4. **Generates 400 / 800 / 1600px** widths in PNG and WebP.
5. **Samples the edge pixels** for white fringing and flags anything above threshold for a human
   look. Fringing is invisible on white and glaring on purple.
6. **Writes a preview against `--cg-purple`** in the admin UI — the operator sees it as the
   audience will, immediately.

### Storage

```
media/
  teams/
    846/
      robot.v2.png          # source of truth
      robot.v2@400.webp
      robot.v2@800.webp
      robot.v2@1600.webp
      meta.json             # bbox, dims, uploaded, photographer, event
  manifest.json             # teamNumber -> current version + dims
```

Versioned because robots change — a team that swaps an intake Saturday morning can re-upload and
every surface picks it up on next load. Event-scoped (`2026cacg`) so the library carries forward
to CalGames 2027 without stale robots.

Preload the whole library on surface start: 42 teams × ~200KB ≈ **8MB**. Cache it Friday night and
the alliance overview never waits on the network mid-show.

## Fallback chain — this is the part that decides whether it ships

At a 42-team offseason event you will realistically get robot photos for **25–35 teams**, and some
of those will arrive Sunday morning. The graphic has to look deliberate with a hole in it.

| Priority | Asset | Rendering |
| --- | --- | --- |
| 1 | Uploaded robot cutout | full treatment |
| 2 | TBA team avatar | avatars are 40×40 — **do not upscale into the robot slot.** Render it small, centered in a purple plinth, as an obviously different treatment |
| 3 | Nothing | large gold team number on a purple plinth, in Archivo, with the team name below |

Tier 3 must look like a designed state, not a broken image. Get it right first and the whole
graphic degrades gracefully — which means you can ship the screen on Friday with zero photos
uploaded and improve it live all weekend as photos come in.

## Where this data lives on the bus

The alliance overview is a surface bound to `match.loaded` / `match.preview`. It needs:

- 6 team numbers — from `matchLoad`
- names/nicknames — from the cached team list (Cheesy `/api/rankings`, FRC Events, or TBA)
- rank/record — from `rankings.updated`, hidden when `estimated`
- robot cutouts — from the local media manifest, no network dependency

Nothing here requires a live FMS connection beyond the team numbers, so this screen works even in
fully-degraded manual mode: the producer types `Q42` and the graphic builds itself.

## Reuse

The same cutout asset drives:

- **Alliance selection** — cutouts appear as picks are made
- **Award graphics** — winner's robot beside the award name
- **Telestrator team tag** — the puck uses the cutout instead of the avatar
- **Post-match cards** — social-ready 1080×1080 with the winning alliance's three robots
- **Arcade Team vs Team** — team's robot next to their Smash player card

One photo session on Friday, used in five places all weekend. That's the argument for spending the
hour to shoot it properly.
