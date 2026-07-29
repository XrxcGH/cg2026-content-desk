/**
 * Arcade: side-tournament state for the gaps between matches.
 * See docs/05-arcade.md.
 *
 * CalGames 2025's schedule had a one-hour lunch on both competition days, a
 * ~30-minute alliance selection window, plus the gaps around awards — roughly
 * three hours of dead air across the weekend. A stream that goes to a slate for
 * three hours loses its audience and doesn't get it back.
 *
 * The architectural point: an arcade overlay is just another surface bound to
 * another source. Same bus, same theme tokens, same components. If this were
 * expensive to build, the architecture would be wrong.
 */

import type { Alliance } from '../types.ts';

export type ArcadeGame = 'smash' | 'mariokart' | 'other';

export interface ArcadePlayer {
  id: string;
  name: string;
  /**
   * Entrants can register by FRC team, which is the whole crossover: the card
   * reads "846 The Funky Monkeys" with the team's avatar rather than a gamertag.
   */
  team?: number;
  teamName?: string;
  seed?: number;
  /** Only set for the Alliance GP format during alliance selection. */
  alliance?: Alliance;
}

export interface ArcadeSet {
  id: string;
  game: ArcadeGame;
  /** "Winners Semifinal", "Grand Final", "Race 3 of 4". */
  round: string;
  players: ArcadePlayer[];
  /** Index-aligned with `players`. */
  scores: number[];
  state: 'upcoming' | 'live' | 'complete';
  /**
   * start.gg reflects what a TO has typed in, which lags reality by anywhere
   * from thirty seconds to a full round. Bracket metadata is authoritative;
   * the live score is not, unless an operator has confirmed it.
   */
  scoreConfidence: 'authoritative' | 'estimated';
}

/**
 * Mario Kart 8 Deluxe grand-prix points. There is no external data source for
 * MK8D, so the model is the product: an operator types the finishing order and
 * standings fall out.
 */
export const MK_POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const;

export interface GrandPrix {
  game: 'mariokart';
  name: string;
  racers: ArcadePlayer[];
  /** One entry per race: racer ids in finishing order. */
  races: string[][];
  raceCount: number;
}

export interface Standing {
  player: ArcadePlayer;
  points: number;
  /** Finishing positions so far, for the "3rd, 1st, 5th" detail line. */
  positions: number[];
}

/**
 * Cumulative standings across the races run so far. Ties break on best single
 * finish, which is how Mario Kart itself resolves them and what the room will
 * expect.
 */
export function standings(gp: GrandPrix): Standing[] {
  const byId = new Map(gp.racers.map(r => [r.id, r]));
  const table = new Map<string, Standing>();
  for (const racer of gp.racers) {
    table.set(racer.id, { player: racer, points: 0, positions: [] });
  }

  for (const race of gp.races) {
    race.forEach((id, index) => {
      const row = table.get(id) ?? (byId.has(id)
        ? { player: byId.get(id)!, points: 0, positions: [] }
        : null);
      if (!row) return;                    // unknown racer id — ignore rather than crash
      row.points += MK_POINTS[index] ?? 0;
      row.positions.push(index + 1);
      table.set(id, row);
    });
  }

  return [...table.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const bestA = Math.min(...(a.positions.length ? a.positions : [99]));
    const bestB = Math.min(...(b.positions.length ? b.positions : [99]));
    return bestA - bestB;
  });
}

/** A set is decided when someone reaches the win threshold (best of N). */
export function setWinner(set: ArcadeSet, bestOf = 3): ArcadePlayer | null {
  const needed = Math.floor(bestOf / 2) + 1;
  const top = set.scores.indexOf(Math.max(...set.scores));
  return set.scores[top] !== undefined && set.scores[top]! >= needed
    ? set.players[top] ?? null
    : null;
}
