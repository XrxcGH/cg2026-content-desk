/**
 * Arcade store. Holds the current set / grand prix and republishes it on the
 * bus so the overlay is just another subscriber.
 *
 * Operator-authoritative by design. start.gg (when it's wired) supplies names,
 * seeds and round labels; it does NOT supply the live score, because start.gg
 * reflects what a TO has typed in and lags reality by anywhere from thirty
 * seconds to a full round. See docs/05-arcade.md.
 */

import type { EventBus } from '../bus.ts';
import {
  standings, setWinner,
  type ArcadeGame, type ArcadePlayer, type ArcadeSet, type GrandPrix, type Standing,
} from './model.ts';

export interface ArcadeSnapshot {
  set: ArcadeSet | null;
  gp: GrandPrix | null;
  standings: Standing[];
  /** Drives the "up next" line during a break. */
  upNext: string;
}

export class ArcadeStore {
  #bus: EventBus;
  #set: ArcadeSet | null = null;
  #gp: GrandPrix | null = null;
  #upNext = '';

  constructor(bus: EventBus) { this.#bus = bus; }

  get snapshot(): ArcadeSnapshot {
    return {
      set: this.#set,
      gp: this.#gp,
      standings: this.#gp ? standings(this.#gp) : [],
      upNext: this.#upNext,
    };
  }

  #publish(type: 'arcade.set_start' | 'arcade.score' | 'arcade.set_end' | 'arcade.bracket_updated'): void {
    this.#bus.emit({ type, source: 'manual', payload: this.snapshot });
  }

  startSet(init: {
    game: ArcadeGame; round: string; players: ArcadePlayer[];
  }): ArcadeSet {
    this.#set = {
      id: `s${Date.now().toString(36)}`,
      game: init.game,
      round: init.round,
      players: init.players,
      scores: init.players.map(() => 0),
      state: 'live',
      scoreConfidence: 'estimated',
    };
    this.#publish('arcade.set_start');
    return this.#set;
  }

  /** Operator adjusts a score. Clamped at zero — negatives are always a typo. */
  score(playerIndex: number, delta: number): ArcadeSet | null {
    if (!this.#set) return null;
    const current = this.#set.scores[playerIndex];
    if (current === undefined) return this.#set;

    this.#set.scores[playerIndex] = Math.max(0, current + delta);
    this.#set.scoreConfidence = 'authoritative';   // a human just confirmed it

    const winner = setWinner(this.#set);
    if (winner) {
      this.#set.state = 'complete';
      this.#publish('arcade.set_end');
    } else {
      this.#publish('arcade.score');
    }
    return this.#set;
  }

  endSet(): void {
    if (!this.#set) return;
    this.#set.state = 'complete';
    this.#publish('arcade.set_end');
  }

  startGrandPrix(name: string, racers: ArcadePlayer[], raceCount = 4): GrandPrix {
    this.#gp = { game: 'mariokart', name, racers, races: [], raceCount };
    this.#publish('arcade.bracket_updated');
    return this.#gp;
  }

  /** Record a race result as racer ids in finishing order. */
  recordRace(order: string[]): GrandPrix | null {
    if (!this.#gp) return null;
    this.#gp.races.push(order);
    this.#publish('arcade.score');
    return this.#gp;
  }

  undoRace(): GrandPrix | null {
    if (!this.#gp?.races.length) return this.#gp;
    this.#gp.races.pop();
    this.#publish('arcade.score');
    return this.#gp;
  }

  setUpNext(text: string): void {
    this.#upNext = text;
    this.#publish('arcade.bracket_updated');
  }

  clear(): void {
    this.#set = null;
    this.#gp = null;
    this.#upNext = '';
    this.#publish('arcade.bracket_updated');
  }
}
