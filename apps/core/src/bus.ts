/**
 * The event bus: append-only log + snapshot + fan-out.
 *
 * The log is the point. Record Friday's practice matches to NDJSON, then
 * `npm run replay -- data/events/friday.ndjson 4` and every graphic can be
 * built and tested on a laptop in March with no field. Volunteer-run systems
 * live or die on whether people can practice without hardware.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { phaseAt } from './clock.ts';
import { reduce, tick } from './state.ts';
import {
  eventId, initialState,
  type Confidence, type DeskEvent, type DeskEventType, type DeskState, type Source,
} from './types.ts';

export type Subscriber = (ev: DeskEvent, state: DeskState) => void;

export interface EmitInit<T = unknown> {
  type: DeskEventType;
  payload?: T;
  source?: Source;
  confidence?: Confidence;
  ts?: number;
}

export class EventBus {
  #state: DeskState = initialState();
  #subscribers = new Set<Subscriber>();
  #log: WriteStream | null = null;
  /** Recent history, for late-joining surfaces and the replay timeline. */
  #ring: DeskEvent[] = [];
  #ringMax = 5000;
  #lastPhase = phaseAt(null);

  get state(): DeskState { return this.#state; }
  get recent(): readonly DeskEvent[] { return this.#ring; }

  /** Where the current (or just-finished) match began. Survives the buzzer. */
  get lastMatchStartedAt(): number | null { return this.#state.lastMatchStartedAt; }

  async openLog(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    this.#log = createWriteStream(path, { flags: 'a' });
  }

  emit<T>(init: EmitInit<T>): DeskEvent<T> {
    const ts = init.ts ?? Date.now();
    const ev: DeskEvent<T> = {
      id: eventId(),
      ts,
      matchClock: this.#state.matchClock,
      source: init.source ?? 'manual',
      confidence: init.confidence ?? 'authoritative',
      type: init.type,
      payload: (init.payload ?? {}) as T,
    };

    this.#state = reduce(this.#state, ev);
    this.#record(ev);
    return ev;
  }

  /**
   * Phase boundaries have to fire even when nothing else is happening —
   * endgame lockdown and the auto-end marker are both time-driven, not
   * event-driven. Called at 10Hz by the server.
   */
  advance(now = Date.now()): void {
    const before = this.#state;
    const after = tick(before, now);
    if (after.phase === this.#lastPhase) { this.#state = after; return; }

    this.#state = after;
    const phase = after.phase;
    this.#lastPhase = phase;

    if (phase === 'transition') this.emit({ type: 'match.auto_end', source: 'cue', ts: now });
    else if (phase === 'endgame') this.emit({ type: 'match.endgame', source: 'cue', ts: now });
    else if (phase === 'post') this.emit({ type: 'match.end', source: 'cue', ts: now });
    else if (phase.startsWith('shift')) {
      this.emit({ type: 'match.shift_change', payload: { phase }, source: 'cue', ts: now });
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  #record(ev: DeskEvent): void {
    this.#ring.push(ev);
    if (this.#ring.length > this.#ringMax) this.#ring.shift();
    this.#log?.write(JSON.stringify(ev) + '\n');
    for (const fn of this.#subscribers) {
      try { fn(ev, this.#state); }
      catch (err) { console.error('[bus] subscriber threw:', err); }
    }
  }

  /** Replay a recorded log. speed=0 replays as fast as possible. */
  async replay(path: string, speed = 1): Promise<void> {
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    console.log(`[bus] replaying ${lines.length} events from ${path} at ${speed || 'max'}x`);
    let prev: number | null = null;

    for (const line of lines) {
      let ev: DeskEvent;
      try { ev = JSON.parse(line) as DeskEvent; }
      catch { continue; }

      if (speed > 0 && prev !== null) {
        const wait = (ev.ts - prev) / speed;
        if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
      }
      prev = ev.ts;

      // Re-stamp to now so the clock runs live rather than in 2026-10-17.
      this.emit({ type: ev.type, payload: ev.payload, source: ev.source, confidence: ev.confidence });
    }
    console.log('[bus] replay complete');
  }
}

export const logPathFor = (dir: string, d = new Date()): string =>
  join(dir, `${d.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ndjson`);
