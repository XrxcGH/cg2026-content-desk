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
    // A write failure mid-show (disk full, media ejected) raises the stream's
    // 'error' event, and an unhandled one kills the whole process. Losing the
    // log is survivable; losing the overlay is not.
    this.#log.on('error', err => {
      console.error('[bus] event log write failed, logging disabled:', err.message);
      this.#log = null;
    });
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
    // The Cheesy adapter emits match.end straight from the field's own
    // notifier, outside of advance()'s tick. If we didn't sync #lastPhase
    // here too, the next 10Hz tick would find the clock-derived phase
    // already at 'post' but #lastPhase still stuck on 'endgame', read that
    // as a fresh transition, and fire a second, duplicate match.end (and
    // the same for match.auto_end/match.endgame/match.shift_change) a
    // moment after the real one, double-firing every subscriber downstream
    // (scene cuts, replay markers). This only closes the race when the
    // authoritative event lands before the ticker's own estimate does; see
    // the review notes for the remaining direction. match.teleop_start is in
    // the list because re-anchoring can pull the clock back across a boundary
    // the ticker already crossed, which would otherwise read as a fresh
    // transition and re-fire it.
    if (ev.type === 'match.auto_end' || ev.type === 'match.endgame'
      || ev.type === 'match.end' || ev.type === 'match.shift_change'
      || ev.type === 'match.teleop_start') {
      this.#lastPhase = this.#state.phase;
    }
    this.#record(ev);
    return ev;
  }

  /**
   * Phase boundaries have to fire even when nothing else is happening.
   * Endgame lockdown and the auto-end marker are both time-driven, not
   * event-driven. Called at 10Hz by the server.
   */
  advance(now = Date.now()): void {
    const before = this.#state;
    const after = tick(before, now);
    if (after.phase === this.#lastPhase) { this.#state = after; return; }

    this.#state = after;
    const phase = after.phase;
    this.#lastPhase = phase;

    // Source 'clock', never 'cue': the cue engine drops cue-sourced events to
    // break feedback loops, so stamping these 'cue' made every clock-driven
    // boundary invisible to cues. The endgame trigger was dead code and the
    // buzzer hold could not fire at all in desk-only or demo operation.
    if (phase === 'transition') this.emit({ type: 'match.auto_end', source: 'clock', ts: now });
    else if (phase === 'endgame') this.emit({ type: 'match.endgame', source: 'clock', ts: now });
    else if (phase === 'post') this.emit({ type: 'match.end', source: 'clock', ts: now });
    else if (phase.startsWith('shift')) {
      this.emit({ type: 'match.shift_change', payload: { phase }, source: 'clock', ts: now });
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
    console.log(`[bus] replaying ${lines.length} events from ${path} at ` +
      (speed ? `${speed}x` : 'max speed'));
    let prev: number | null = null;
    let offset: number | null = null;

    for (const line of lines) {
      let ev: DeskEvent;
      try { ev = JSON.parse(line) as DeskEvent; }
      catch {
        // A truncated last line (e.g. the process was killed mid-write) is
        // normal; anything else silently dropping here would make replay
        // quietly skip real events with nothing in the console to explain it.
        console.error('[bus] skipping unparseable log line:', line.slice(0, 200));
        continue;
      }

      // attachMarkers and attachPace stay attached during replay and re-derive
      // from the primary events, so re-emitting the logged copies doubled
      // every automatic marker and mixed the recording's stale pace numbers
      // with fresh ones. Manual markers are primary: nothing regenerates
      // them, so they must replay.
      if (ev.type === 'pace.updated') continue;
      if (ev.type === 'replay.marker' && ev.source !== 'manual') continue;

      if (speed > 0 && prev !== null) {
        const wait = (ev.ts - prev) / speed;
        if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
      }
      prev = ev.ts;

      // Re-stamp by a constant offset so the clock runs live rather than in
      // 2026-10-17. The offset preserves the recording's own spacing: the
      // reducer attributes score deltas by ev.ts, so re-stamping each event
      // to its delivery time pushed auto scores into teleop at any pacing
      // other than exact 1x.
      offset ??= Date.now() - ev.ts;
      this.emit({
        type: ev.type, payload: ev.payload, source: ev.source,
        confidence: ev.confidence, ts: ev.ts + offset,
      });
    }
    console.log('[bus] replay complete');
  }
}

export const logPathFor = (dir: string, d = new Date()): string =>
  join(dir, `${d.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ndjson`);
