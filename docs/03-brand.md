# 03 — CalGames design system

## Foundation: official WRRF colors

| | Hex | Role |
| --- | --- | --- |
| **Purple** | `#560F6B` | primary brand — surfaces, chrome, base |
| **Gold** | `#F0AF00` | primary accent — key numbers, active states, edges |
| **Green** | `#006549` | secondary accent — positive/complete states, second data series |
| **Black** | `#000000` | text on light; **the luma-key background** |
| **White** | `#FFFFFF` | text on dark |

Everything below is derived from those five. CalGames has no locked logo — it's chosen by an
annual community **logo contest**, a 10+ year WRRF tradition — so the system is built so any
winning mark drops into a reserved lockup slot without disturbing the palette.

## Palette

### Brand ramps

Purple and gold each need a three-step ramp so panels can have structure without relying on
shadow (see broadcast rule 2 — shadows die under a luma key).

| Token | Hex | Use |
| --- | --- | --- |
| `--cg-purple` | `#560F6B` | primary surface, panel fill |
| `--cg-purple-hi` | `#7B2394` | raised surface, hover, active row |
| `--cg-purple-lo` | `#33073F` | recessed surface, lower-third base |
| `--cg-purple-deep` | `#1B0322` | full-bleed background, chrome |
| `--cg-black` | `#000000` | luma-key background, text on gold |
| `--cg-gold` | `#F0AF00` | primary accent |
| `--cg-gold-hi` | `#FFCA3D` | highlight, gradient top, focus ring |
| `--cg-gold-lo` | `#A87A00` | pressed, gradient bottom, gold on gold |
| `--cg-green` | `#006549` | secondary accent |
| `--cg-green-hi` | `#0D9B74` | bright green — pips, thresholds met |
| `--cg-green-lo` | `#003D2C` | recessed green |
| `--cg-white` | `#FFFFFF` | primary text on dark |
| `--cg-white-dim` | `#C9BCD0` | secondary text, labels (white tinted toward purple) |

`--cg-white-dim` is white pulled 20% toward `--cg-purple` rather than toward grey. Neutral grey
next to a saturated purple reads as dirty; a purple-tinted dim white reads as intentional.

### Alliance — official FIRST colors, reserved, never themed

| Token | Hex | |
| --- | --- | --- |
| `--alliance-red` | `#ED1C24` | official FIRST red |
| `--alliance-blue` | `#0066B3` | official FIRST blue |
| `--alliance-red-lo` | `#7A0F13` | derived shade, backgrounds only |
| `--alliance-blue-lo` | `#00375F` | derived shade, backgrounds only |

These two hex values are fixed by FIRST and are the only colors in this system we don't get to
choose. The `-lo` shades are ours, for recessed fills behind the canonical color — never used as
the alliance color itself.

> **Rule: red and blue are semantic, not decorative.** They mean *alliance* and nothing else. No
> red buttons, no blue links, no red error states in any broadcast surface. Operator-only surfaces
> may use them only when they refer to an alliance.

> **Purple/blue adjacency is the one real hazard in this palette.** `#560F6B` and `#0066B3` are
> close enough in value and hue-family that at 720p, on a phone, in motion, a purple chrome panel
> touching a blue alliance fill will blur into one shape. Mitigation, applied everywhere:
> **alliance fills are always separated from purple chrome by a 3px `--cg-gold` rule.** Gold
> between them resolves it completely, and it happens to look like the brand.

### Status

| Token | Hex | Meaning |
| --- | --- | --- |
| `--st-live` | `#F0AF00` | on air / match running |
| `--st-ok` | `#0D9B74` | connected, healthy (WRRF green, brightened for contrast) |
| `--st-warn` | `#FFCA3D` | degraded, **estimated** data |
| `--st-bad` | `#C13030` | disconnected, failed |

`--st-bad` is the only non-palette color in the system, and it appears exclusively on operator
surfaces — never on a broadcast graphic, where red means *alliance*.

### Contrast check (WCAG AA, 4.5:1 body / 3:1 large)

| Pair | Ratio | Verdict |
| --- | --- | --- |
| White on `--cg-purple` | 12.5 | pass |
| White on `--cg-purple-deep` | 19.4 | pass |
| Gold on `--cg-purple` | 6.5 | pass |
| Gold on `--cg-purple-deep` | 10.0 | pass |
| Black on `--cg-gold` | 10.8 | pass |
| White on `--cg-green` | 7.1 | pass |
| `--cg-green-hi` on `--cg-purple` | 3.6 | large text / graphics only |
| White on `--cg-gold` | 1.9 | **fail — never do this** |
| Gold on white | 1.9 | **fail — never do this** |

Gold is a *dark-background-only* accent. On any light surface it must be replaced by
`--cg-purple`. The tokens file ships a `[data-surface="light"]` block that does this swap
automatically.

## Type

The palette is mandated, so **typography and geometry are where this system gets its character.**
Three siblings from the same grotesque lineage — they cohere without matching, and none of them is
the font every other overlay uses.

| Role | Face | Why |
| --- | --- | --- |
| Display / headings | **Archivo**, variable, width axis pushed to **118–125** | expanded grotesques are the native language of scoreboards. Width reads before weight at distance — a wide 700 beats a narrow 900 across a gym |
| Numerals, scores, clocks | **Chivo** 700, `tabular-nums` | a headline face with genuinely good tabular figures. Sturdier and less anonymous than Archivo's numerals, and the two are designed to sit together |
| Condensed labels, team names | **Saira Condensed** 600 | fits `Homestead Robotics` in a lower third without ellipsis, and has more spine than Barlow |
| Console / logs | **JetBrains Mono** | operator surfaces only |

All SIL OFL. **Self-host the WOFF2s** (including the Archivo variable font — the width axis is the
whole point). An OBS Browser Source that fetches Google Fonts will render fallback type the one
time venue internet drops, which will be during finals.

**Note on Poppins:** calgames.org uses it, and it stays the *web* face. It doesn't come to
broadcast — Poppins is a geometric sans with a low-contrast, wide-aperture design that goes soft
at 90 feet, and it can't give us the width axis the scoreboard needs.

## Form language: "field-built"

Since we can't differentiate on color, we differentiate on **shape**. Three rules, applied
everywhere, that make this look machined rather than templated:

**1. Chamfer, don't round.** Every panel, chip, button, and pip is cut at two opposite corners —
a 20px chamfer at stream scale, 34px at venue scale. It reads as a lightening cut on a gusset
plate, which is exactly what the audience spends all weekend looking at on the robots. Rounded
rectangles read as "web app"; chamfers read as "fabricated."

Implemented with `clip-path`, which clips borders too — so the gold edge is a **background layer
with an inset face**, not a `border`. That's why `.panel` is a gold plate with a purple `::before`
inset by `--edge-w`.

The chamfer also happens to be perfect under a luma key: the cut corner keys straight out to black.

**2. Perforated texture, never flat fill.** Purple surfaces carry a faint white dot grid
(`--tex-perf`, 13px at stream / 22px at venue) — perforated aluminum. It's subtle enough to survive
stream compression and it stops every panel from being a dead color block.

**3. Atmosphere, not a background color.** Full-bleed backdrops use `--atmo`: an off-center purple
glow from the top-left, a gold bloom from the bottom-right, over a purple-deep-to-void gradient.
Nothing in this system is ever `background: #1B0322`.

Plus a fourth, used sparingly: the **blueprint tick rule** (`--tick`) — measurement marks along a
panel's top edge. A CAD reference that reads as texture from the back row.

The Gold Sweep inherits the geometry: its leading edge is **skewed −12°** with a brighter
highlight band, so the signature transition is visibly part of the same shape language.

## Broadcast rules

Constraints from research, not taste:

1. **Design at 1920×1080.** Title-safe 5% (96px horizontal / 54px vertical). Assume the stream is
   watched at 720p on a phone.
2. **Dual-key support is mandatory.** Cheesy Arena's audience overlay feeds a Blackmagic
   **downstream luma key** — black is transparent, and chroma key is not available on the DSK.
   Any graphic that may route through the switcher needs `?key=luma` (opaque `--cg-black`
   background) as well as `?key=alpha` for OBS Browser Sources.
   *Consequence:* under luma key, drop shadows and translucent glass panels vanish and dark purple
   detail partially keys out. Structure comes from **solid fills and gold edges**, never shadow,
   and `--cg-purple-deep` is never used as a panel fill in luma mode — only `--cg-purple` or
   lighter.
3. **White text is fine; large white fills are not.** `#FFFFFF` type at any size is correct.
   `#FFFFFF` covering more than ~10% of frame blooms on venue projectors and clips on cheap
   capture — use `--cg-purple` or `--cg-gold` panels instead.
4. **Two legibility targets, two layouts.** Stream viewers are 18 inches from a phone; the venue
   audience is up to 90 feet from a projector. Minimum type is **28px for stream surfaces** and
   **72px for venue surfaces**, and a venue layout holds 5–7 elements, not 15. Set via
   `data-scale="stream|venue"`. Full derivation in [08-motion.md](08-motion.md).
5. **Motion must be visible from the back row.** Entrances travel ≥190px (1° of visual angle at
   90 ft) and run 380–600ms — opacity fades and 12px slides are invisible in a gym. Seven named
   transitions, all in [08-motion.md](08-motion.md). During endgame, decorative motion is
   suppressed but the score, clock, and RP pips keep animating.
6. **Every graphic has a dwell timer.** Nothing waits forever on an operator who is busy. Lower
   thirds auto-retire at 8s unless pinned.
7. **Never encode alliance by color alone.** Always pair with position (red left, blue right,
   matching the field) *and* a text label — ~8% of male viewers can't reliably separate them.

## Component inventory

| Component | Notes |
| --- | --- |
| **Score bar** | persistent; red left / blue right, gold rule between each alliance block and the purple chrome; fuel count, tower points, clock, phase chip |
| **Hub state indicator** | *the* CalGames-2026 graphic — which hub is live now, plus shift countdown |
| **RP pips** | ENERGIZED / SUPERCHARGED / TRAVERSAL; empty = `--cg-purple-hi`, filled = `--cg-green-hi` |
| **Alliance overview** | pre-match, RSN-style: 3 robot cutouts per side, numbers, names — see [07-team-media.md](07-team-media.md) |
| **Match intro** | 6 teams, avatars, EPA form line, W-L-T |
| **Lower third** | one component, four variants: name/title, stat, quote, sponsor |
| **Replay wipe** | gold sweep on purple + "REPLAY" bug; reused for arcade |
| **Telestrator chrome** | analyst name + "ANALYSIS" bug while strokes are live |
| **Score reveal** | post-match delta animation, RP award, ranking movement |
| **Bracket** | consume Cheesy's `/api/bracket/svg`, restyle with tokens |
| **Queueing / on-deck** | side screens |
| **Arcade card** | player names, game logo slot, set score, bracket round |

All of them are three primitives: a **panel** (purple fill, gold edge), a **chip** (small pill),
and a **numeral block** (tabular, gold). Build those three well and the rest is composition.

### Telestrator ink

Drawing colors have to survive on top of a field that is itself red, blue, and grey carpet:

| Ink | Hex | Use |
| --- | --- | --- |
| Gold | `#F0AF00` | default — neutral analysis, highest visibility on carpet |
| Green | `#0D9B74` | "this worked" / intended path |
| White | `#FFFFFF` | annotation, text callouts |
| Red / Blue | alliance tokens | **only** when marking a specific alliance's robot |

Every stroke gets a 2px `--cg-black` outline so gold stays legible over the gold-ish field
elements and lighting. Strokes carry a 6-second auto-fade unless pinned.

## Logo lockup

Reserve `--cg-logo-slot`: a 320×120 safe box, top-left of the score bar and center of the intro
card. The contest logo drops in as SVG with a `currentColor` variant so it renders gold-on-purple
and purple-on-gold from a single asset.

## Implementation

Tokens live in [packages/theme/tokens.css](../packages/theme/tokens.css) as CSS custom properties
on `:root`, with `[data-key="luma"]` and `[data-surface="light"]` blocks that swap background and
accent respectively. Every surface imports that one file. No preprocessor, no build step — this
has to be editable by a volunteer at 11pm on a Saturday.
