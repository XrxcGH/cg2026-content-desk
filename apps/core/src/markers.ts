/**
 * Automatic replay markers. See docs/04-replay-and-telestrator.md.
 *
 * The replay operator should never hunt. Automation catches the scoring; a
 * human catches the *interesting*. This module is the first half: it watches
 * the bus and drops a marker whenever something happened that someone might
 * want to see again.
 *
 * Everything here is derived from `score.delta`, which is itself synthesised
 * from consecutive realtime-score snapshots. Neither Cheesy Arena nor FMS
 * emits "team X just scored", and this is why we bother to compute it.
 */

import type { EventBus } from './bus.ts';
import { REBUILT, type Alliance, type DeskEvent } from './types.ts';

export type MarkerKind =
  | 'manual' | 'burst' | 'lead_change' | 'climb'
  | 'auto_end' | 'endgame' | 'shift' | 'foul' | 'robot_down';

export interface Marker {
  kind: MarkerKind;
  /** Wall clock. Exact, and what clip extraction actually uses. */
  ts: number;
  matchClock: number | null;
  alliance?: Alliance;
  label: string;
  /** 3 = drop everything, 1 = background colour. */
  priority: 1 | 2 | 3;
}

const BURST = {
  /** Fuel scored inside the window to count as a burst. */
  fuel: 5,
  windowMs: 1_500,
  /** One burst shouldn't emit five markers. */
  cooldownMs: 6_000,
};

export function attachMarkers(bus: EventBus): () => void {
  /** Recent fuel deltas per alliance, for the sliding burst window. */
  const recent: Record<Alliance, { ts: number; amount: number }[]> = { red: [], blue: [] };
  const lastBurst: Record<Alliance, number> = { red: 0, blue: 0 };
  let leader: Alliance | 'tie' = 'tie';

  const mark = (m: Omit<Marker, 'ts' | 'matchClock'>, ts: number): void => {
    bus.emit({
      type: 'replay.marker',
      source: 'cue',
      ts,
      payload: { ...m, ts, matchClock: bus.state.matchClock } satisfies Marker,
    });
  };

  return bus.subscribe((ev: DeskEvent) => {
    switch (ev.type) {
      case 'match.loaded': {
        recent.red = []; recent.blue = [];
        lastBurst.red = 0; lastBurst.blue = 0;
        leader = 'tie';
        break;
      }

      case 'match.auto_end':
        mark({ kind: 'auto_end', label: 'End of auto', priority: 2 }, ev.ts);
        break;

      case 'match.endgame':
        mark({ kind: 'endgame', label: 'Endgame', priority: 2 }, ev.ts);
        break;

      case 'match.shift_change': {
        const hub = bus.state.hubActive;
        if (hub === 'red' || hub === 'blue') {
          mark({ kind: 'shift', label: `${hub} hub live`, priority: 1 }, ev.ts);
        }
        break;
      }

      case 'foul.called':
      case 'card.issued':
        mark({ kind: 'foul', label: ev.type === 'foul.called' ? 'Foul' : 'Card', priority: 3 }, ev.ts);
        break;

      case 'score.delta': {
        const p = ev.payload as { alliance: Alliance; field: string; amount: number };
        if (!p || (p.alliance !== 'red' && p.alliance !== 'blue')) break;

        // A climb is worth its own marker regardless of timing: it's the
        // single most replayable thing in REBUILT.
        if (p.field === 'tower' && p.amount > 0) {
          const level = p.amount >= REBUILT.TOWER_TELEOP[3] ? 3
            : p.amount >= REBUILT.TOWER_TELEOP[2] ? 2 : 1;
          mark({
            kind: 'climb', alliance: p.alliance,
            label: `${p.alliance} climb L${level}`, priority: 3,
          }, ev.ts);
        }

        if (p.field === 'fuel' && p.amount > 0) {
          const window = recent[p.alliance];
          window.push({ ts: ev.ts, amount: p.amount });
          // Drop anything outside the sliding window.
          while (window.length && ev.ts - window[0]!.ts > BURST.windowMs) window.shift();

          const total = window.reduce((n, d) => n + d.amount, 0);
          if (total >= BURST.fuel && ev.ts - lastBurst[p.alliance] > BURST.cooldownMs) {
            lastBurst[p.alliance] = ev.ts;
            mark({
              kind: 'burst', alliance: p.alliance,
              label: `${p.alliance} ${total} fuel burst`, priority: 3,
            }, ev.ts);
          }
        }

        // Lead changes are computed from settled totals, so fouls count too.
        const { red, blue } = bus.state.score;
        const now: Alliance | 'tie' =
          red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : 'tie';
        if (now !== 'tie' && now !== leader && leader !== 'tie') {
          mark({ kind: 'lead_change', alliance: now, label: `${now} takes the lead`, priority: 3 }, ev.ts);
        }
        if (now !== leader) leader = now;
        break;
      }

      case 'arena.status': {
        // "What happened to 846?" This is the marker nobody thinks to hit
        // manually because it happens while everyone is watching the other end.
        const p = ev.payload as { down?: number[] } | undefined;
        for (const team of p?.down ?? []) {
          mark({ kind: 'robot_down', label: `${team} lost comms`, priority: 2 }, ev.ts);
        }
        break;
      }
    }
  });
}

/** Pull markers back out of the event log for the replay timeline. */
export function markersSince(bus: EventBus, sinceMs: number): Marker[] {
  return bus.recent
    .filter(ev => ev.type === 'replay.marker' && ev.ts >= sinceMs)
    .map(ev => ev.payload as Marker)
    .filter(m => m && typeof m.ts === 'number')
    .sort((a, b) => a.ts - b.ts);
}
