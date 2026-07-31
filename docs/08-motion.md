# 08: Motion + venue legibility

Every graphic ships to **two audiences with incompatible requirements**, and pretending otherwise
is the most common way community broadcasts end up unreadable in the room:

| | Stream viewer | Venue audience |
| --- | --- | --- |
| Distance | 12-24 inches | 30-90 feet |
| Effective resolution | 720p on a phone | ~10 pixels per physical inch |
| Elements they can parse | 12-15 | **5-7** |
| Ambient light | dark room | gym lights on, windows, projector washout |
| Minimum type | 28px | **72px** |
| Minimum motion travel | 12px | **190px** |

The way this system resolves the conflict: **one broadcast layout, ordered so its largest
elements are the venue elements.** The score, clock, and alliance blocks (the only things the
back row can read) are already the biggest objects on the program overlay, so the same layout
serves the stream and the venue projector. Everything smaller (team lists, fuel/tower detail,
RP badges) is stream-only information the room is free to ignore, exactly as the sightline math
below predicts it will.

The one surface that exists *only* for the room (the `/s/side` pit and queueing screens) keeps
a brutally reduced layout with its own 72px type floor, set locally on that surface.

---

## The sightline math

Woodside's gym is a standard high-school court; the back row of spectators is realistically
**70-90 feet** from the audience screen. Take 90 ft (1080 inches) as worst case.

**Screen size.** A realistic gym projection is 12-16 ft wide → **81-108 inches tall**. That puts
the back row at roughly **10× image height**. AVIXA DISCAS treats 8× image height as the limit for
*Basic Decision Making* content, meaning the back of the gym is already past the threshold where
detailed content is legible at all.

> **Consequence, and it should drive every venue layout:** only the largest 2-3 elements on screen
> are readable from the back row. Decide what those are: **score, clock, alliance**. Make them
> enormous, and treat everything else as a bonus for the front half of the room. A venue graphic
> that tries to show ranking, RP progress, team names, and score is showing none of them.

**Type height.** The standard legibility ratios are 1:150 (comfortable) and 1:200 (threshold) of
viewing distance.

| | 90 ft viewer | On a 108" tall 1080p image (10 px/in) | On an 81" tall image (13.3 px/in) |
| --- | --- | --- | --- |
| Comfortable (1:150) | 7.2 in | 72 px | 96 px |
| Threshold (1:200) | 5.4 in | 54 px | 72 px |

**→ 72px is the hard floor for any text on a venue surface.** Primary data gets 96px+, the score
gets 140px+.

**Motion amplitude.** Peripheral vision detects movement long before it resolves detail, but the
movement has to subtend enough visual angle to register. **1° of visual angle** at 90 ft is about
19 inches ≈ **190 px** on our screen.

**→ Entrance animations on venue surfaces travel at least 190px, or nobody in the back half
notices they happened.** A 12px slide-and-fade (the default in every web UI kit) is completely
invisible at 90 feet. So is a 250ms opacity fade, because projector gamma crushes the midpoint of
a fade into mush.

---

## What works at distance, and what doesn't

| ✗ Invisible from the back row | ✓ Reads from anywhere |
| --- | --- |
| Opacity-only fades | **Hard-edged wipes**: a gold bar with a crisp leading edge sweeping across purple |
| Subtle scale (1.0 → 1.02) | **Scale from 0.85** with an overshoot |
| 12-48px slides | **190px+ travel** |
| Thin 1-2px accent lines animating | **Solid color-block reveals**, 12px+ bars |
| Blur, glow, soft shadows | **Contrast changes** between two high-contrast states |
| Subtle easing bounces | **Visible overshoot** (`back-out`, ~8% past target) |
| Small counters ticking | **Digit rolls** at 140px, where the shape change is the signal |
| Anything under 300ms | **380-600ms**, long enough for an eye to travel and land |

The unifying principle: **at distance you perceive changes in large areas of contrast, not
positions of small objects.** Design motion as blocks of color moving, not elements sliding.

---

## The motion system

Seven named transitions. Everything on the broadcast is one of these: no bespoke animations,
because a volunteer needs to be able to add a graphic in October and have it match.

### 1. Gold Sweep: the signature move

A solid `--cg-gold` bar wipes across the element; content changes behind it; the bar exits the far
side. **480ms**, `cubic-bezier(.65,0,.35,1)`.

This is CalGames' visual signature and it's used everywhere a screen changes: score bar in, replay
wipe, alliance overview build, screen-to-screen transitions. It works at 90 feet because it's a
full-height block of maximum-contrast color crossing the entire element. It's the highest-amplitude
motion available.

### 2. Block Reveal: panels and cards

Scale `0.85 → 1`, travel `--travel-lg` (320px) from the nearest screen edge. **380ms**,
`cubic-bezier(.16,1,.3,1)` (expo-out: fast start, long settle, reads as decisive at distance).

### 3. Number Roll: scores and counters

Digits count from previous to current value over **600ms**, ease-out, with `tabular-nums` so
nothing reflows. At 140px, changing digit *shapes* are visible across the gym even when the exact
value isn't. The audience sees "the score is climbing fast" before they can read it, which is
exactly the emotional information you want during a fuel burst.

### 4. Pip Pop: ranking points

Radial wipe fill + scale to 1.25 and back. **340ms**, `cubic-bezier(.34,1.56,.64,1)` (back-out).
The overshoot is what makes an 18px element register at distance. It's the only case where we
animate something small, and the pop is how it gets away with it.

### 5. Stagger Build: the alliance overview

Six robots, **90ms stagger**, each a Block Reveal with 120px of vertical travel, bottom-up. Total
~880ms. The stagger reads as choreography rather than a pop-in, and the sequential motion pulls
attention left-to-right across the screen.

### 6. Alert Pulse: endgame and E-stop

Full-width `--cg-gold` bar, opacity 1 → 0.45 → 1, **1200ms period** (0.83 Hz), 3 cycles then hold.

Deliberately slow. **Never exceed 3 flashes per second** (WCAG 2.3.1). This is a public venue
full of kids, and a photosensitive-seizure risk is not a design trade-off. 0.83 Hz is well clear
and, at that amplitude, far more visible than a fast flicker anyway.

### 7. Slide Third: lower thirds

Full off-screen travel from the left edge, **420ms**, expo-out. A lower third that fades in is
invisible in the room; one that flies in from off-screen is unmissable. Exits by the same path,
260ms.

---

## Buttons and operator feedback

Two very different distances, so two treatments:

**Operator surfaces** (desk console, replay console, media admin), viewed at 2 ft: fast and
tactile. `120ms`, scale `0.96` on press, 3px `--cg-gold` focus ring, instant color change on
hover. Speed *is* the feedback here; anything over 150ms feels laggy to someone hitting a button
40 times a match.

**Audience-facing interactive elements** (side screens, kiosk displays): full Block Reveal
treatment, 72px minimum type, and state changes are color-block swaps, not subtle tints.

**Stream Deck / physical buttons**: the on-screen confirmation must be *unambiguous within 200ms*,
because the operator is looking at program, not at their hands. A gold flash on the affected zone.

---

## Timing budget during a match

The earlier rule, "nothing animates in the last 30 seconds," was too blunt. Corrected:

`data-lockdown` (set automatically from `matchClock` ≥ 110, i.e. endgame):

- **Suppressed:** lower thirds, sponsor cards, panel reveals, anything decorative
- **Still animating:** the match clock, the score Number Roll, RP Pip Pops, the endgame Alert Pulse

The score climbing during endgame is the most important motion on the screen all weekend. Freezing
it to "reduce distraction" would be exactly backwards. What we suppress is *competing* motion.

`prefers-reduced-motion` collapses every transition to an instant state change, never to a
half-speed version.

---

## Frame rate and rendering

- **Never drive a clock or a counter from `requestAnimationFrame` alone.** rAF does not fire in a
  hidden page, and OBS throttles (with *shutdown source when not visible*, effectively pauses)
  Browser Sources that aren't on a live scene. A clock on rAF freezes the moment the source goes
  off-scene and snaps forward when it comes back, which on a scoreboard is very visible. Every
  surface uses `startTicker()` from `desk-client.js`: rAF while visible, a 250ms interval backstop
  while hidden, and an immediate repaint on `visibilitychange`. Animated counters jump straight to
  their final value while hidden rather than stranding on a stale number.
  *(Found by testing against a backgrounded tab: it is not a test artifact, it is exactly what OBS
  does.)*
- Animate **`transform` and `opacity` only.** Animating `width`, `top`, or `background-position`
  drops browser-source frames, and a dropped frame in a 480ms sweep is visible as a stutter on a
  large screen.
- `will-change: transform` on anything that sweeps; remove it after.
- Target a locked **60fps** in the OBS Browser Source. Set the source to 60fps explicitly. It
  defaults to 30 in some OBS versions, which halves the smoothness of every sweep.
- Venue projectors are usually 60Hz. Don't design anything that depends on 120Hz smoothness.
- Test on the actual projector. Gym projectors are frequently dimmer and lower-contrast than the
  spec sheet, and a sweep that looks great on an OLED monitor can vanish. **Budget 30 minutes on
  Friday to look at every graphic from the back row.** This is the single highest-value QA step in
  the whole project and it costs half an hour.

---

## Implementation

All of it lives in [packages/theme/tokens.css](../packages/theme/tokens.css) as duration, easing,
travel, and type-scale tokens plus seven keyframe sets. The broadcast overlay runs one scale;
the room-only side screens override the type tokens locally in their own stylesheet:

```css
/* surfaces/side/index.html: the one room-only surface */
:root { --t-title: 84px; --t-body: 76px; --t-label: 72px; /* … */ }
```

Nothing else changes. If a component needs bespoke CSS to survive on a room-only surface, the
component is too complicated for that surface. Cut it instead.
