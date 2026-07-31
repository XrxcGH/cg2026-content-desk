/**
 * Ranking-point badges, shared by every surface that shows RP state.
 *
 * A bare pip answers "did they get it?" but not "which one?" or "how close?".
 * The badge pairs an icon (which bonus) with the threshold numeral (what it
 * takes), so a viewer who tuned in mid-match can read the goal off the bar.
 *
 * Icons are single filled 24x24 paths so the same data draws as inline SVG on
 * the overlays and as a Path2D on the post-match card canvas.
 */

import { REBUILT } from './desk-client.js';

/** Fallback for anything rendering before the first state frame lands. */
export const DEFAULT_THRESHOLDS = {
  energizedFuel: REBUILT.RP_ENERGIZED_FUEL,
  superchargedFuel: REBUILT.RP_SUPERCHARGED_FUEL,
  traversalTower: REBUILT.RP_TRAVERSAL_TOWER,
};

/** Icon and label are fixed; the numeral is whatever the event is playing to. */
const SHAPES = [
  {
    key: 'energized',
    label: 'Energized',
    from: 'energizedFuel',
    unit: 'fuel',
    // Lightning bolt.
    path: 'M13 2 5 13.5h4.8L8 22 19 9.5h-5.4L16 2z',
  },
  {
    key: 'supercharged',
    label: 'Supercharged',
    from: 'superchargedFuel',
    unit: 'fuel',
    // Double bolt, more of the same currency.
    path: 'M9 1 2.5 9.5H6L4.8 15 13 5.5H9.2L11 1z'
      + 'M19 9l-6.5 8.5H16L14.8 23 23 13.5h-3.8L21 9z',
  },
  {
    key: 'traversal',
    label: 'Traversal',
    from: 'traversalTower',
    unit: 'tower',
    // Three ascending bars: tower levels 1/2/3.
    path: 'M3.5 21h4.4v-5H3.5zM9.8 21h4.4V10.5H9.8zM16.1 21h4.4V4h-4.4z',
  },
];

/**
 * Badges carrying the thresholds this event is actually scored against.
 *
 * The numeral is the whole point of the badge: it tells a viewer who tuned in
 * mid-match what the goal is. Printing 100 while the reducer scores against
 * something else would be worse than printing nothing, so both read the same
 * `state.thresholds`.
 */
export function rpBadges(t) {
  const th = { ...DEFAULT_THRESHOLDS, ...(t ?? {}) };
  return SHAPES.map(b => ({ ...b, need: th[b.from] }));
}

/** Default-threshold badges, for callers with no state in hand yet. */
export const RP_BADGES = rpBadges();

/** One badge as markup. Surfaces flip `data-earned` per state frame. */
export const rpBadge = b =>
  `<span class="rp" data-rp="${b.key}" title="${b.label} · ${b.need} ${b.unit}">` +
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${b.path}"/></svg>` +
  `<span class="rp-need">${b.need}</span></span>`;

/** The full strip for one alliance, at this event's thresholds. */
export const rpStrip = t => rpBadges(t).map(rpBadge).join('');
