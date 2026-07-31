/**
 * Show automation. See the show flow table in docs/06-hardware-and-network.md.
 *
 * Two rules govern everything here:
 *
 *   1. Manual always wins. Every cue has its own autopilot toggle, so the
 *      producer can trust the parts that work and drive the parts that don't.
 *      A global on/off would be useless: on day one you trust nothing, and by
 *      Sunday you trust most of it.
 *
 *   2. A disabled cue still reports that it WOULD have fired. That is what
 *      makes a producer comfortable turning it on: they watch it be right for
 *      a session first.
 */

import type { EventBus } from '../bus.ts';
import type { DeskEvent, DeskState } from '../types.ts';
import { REBUILT } from '../types.ts';
import type { ObsClient } from './obs.ts';

export interface CueContext {
  bus: EventBus;
  obs: ObsClient | null;
  event: DeskEvent;
  state: DeskState;
  scene: (name: keyof typeof DEFAULT_SCENES) => Promise<void>;
}

export interface Cue {
  id: string;
  name: string;
  /** What the producer sees when deciding whether to trust it. */
  does: string;
  when: (ev: DeskEvent, state: DeskState) => boolean;
  run: (ctx: CueContext) => void | Promise<void>;
}

export interface CueStatus {
  id: string;
  name: string;
  does: string;
  autopilot: boolean;
  firedAt: number | null;
  /** Times it matched while switched off ("it would have been right N times"). */
  wouldHaveFired: number;
  lastError: string | null;
}

/** Scene names to create in OBS. Overridable at construction. */
export const DEFAULT_SCENES = {
  intro: 'CG_INTRO',
  match: 'CG_MATCH',
  score: 'CG_SCORE',
  replay: 'CG_REPLAY',
  desk: 'CG_DESK',
  arcade: 'CG_ARCADE',
} as const;

export type SceneMap = Record<keyof typeof DEFAULT_SCENES, string>;

/** Gap after which we assume there's no match imminent and fill. */
const GAP_MS = 3 * 60_000;

export function defaultCues(): Cue[] {
  return [
    {
      id: 'on-deck',
      name: 'On deck',
      does: 'Show the alliance overview when a match is loaded.',
      when: ev => ev.type === 'match.loaded',
      run: async ctx => {
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'overview' } });
        await ctx.scene('intro');
      },
    },
    {
      id: 'armed',
      name: 'Armed',
      does: 'Cut to the field and bring the score bar in when the field goes ready, before the countdown.',
      when: ev => ev.type === 'match.armed',
      run: async ctx => {
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'match' } });
        await ctx.scene('match');
      },
    },
    {
      id: 'live',
      name: 'Live',
      does: 'Score bar live, hub indicator on, replay markers armed.',
      when: ev => ev.type === 'match.start',
      run: async ctx => {
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'match' } });
        await ctx.scene('match');
      },
    },
    {
      id: 'endgame',
      name: 'Endgame',
      does: 'Endgame chip and tight camera as the towers come into play.',
      when: (ev, state) =>
        ev.type === 'match.endgame'
        || (ev.type === 'score.delta' && (state.matchClock ?? -999) >= REBUILT.ENDGAME_START),
      run: ctx => {
        ctx.bus.emit({ type: 'graphic.show', source: 'cue', payload: { graphic: 'endgame' } });
      },
    },
    {
      id: 'hold-celebration',
      name: 'Hold on the buzzer',
      does: 'Stay on the field wide for four seconds after the buzzer. Do not cut early.',
      when: ev => ev.type === 'match.end',
      run: async ctx => { await ctx.scene('match'); },
    },
    {
      id: 'result',
      name: 'Score reveal',
      does: 'Reveal the final score, RP badges, and ranking movement.',
      when: ev => ev.type === 'match.score_posted',
      run: async ctx => {
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'score' } });
        await ctx.scene('score');
      },
    },
    {
      id: 'replay',
      name: 'Take replay',
      does: 'Cut to the replay scene when the operator takes a clip.',
      when: ev => ev.type === 'replay.play',
      run: async ctx => { await ctx.scene('replay'); },
    },
    {
      id: 'gap-filler',
      name: 'Fill the gap',
      does: 'Cut to the arcade when there is no match for three minutes.',
      when: (ev, state) =>
        ev.type === 'match.score_posted'
        && state.matchStartedAt === null
        && Date.now() - (state.scorePostedAt ?? 0) > GAP_MS,
      run: async ctx => { await ctx.scene('arcade'); },
    },
  ];
}

export class CueEngine {
  #bus: EventBus;
  #obs: ObsClient | null;
  #scenes: SceneMap;
  #cues: Cue[];
  #autopilot = new Map<string, boolean>();
  #firedAt = new Map<string, number>();
  #would = new Map<string, number>();
  #errors = new Map<string, string | null>();
  #unsubscribe: (() => void) | null = null;

  constructor(bus: EventBus, obs: ObsClient | null,
              opts: { cues?: Cue[]; scenes?: Partial<SceneMap>; autopilot?: boolean } = {}) {
    this.#bus = bus;
    this.#obs = obs;
    this.#scenes = { ...DEFAULT_SCENES, ...opts.scenes };
    this.#cues = opts.cues ?? defaultCues();
    // Off by default. Nobody should discover automation by having it happen to
    // them mid-match; the producer switches cues on once they've watched them
    // be right.
    for (const cue of this.#cues) this.#autopilot.set(cue.id, opts.autopilot ?? false);
  }

  get status(): CueStatus[] {
    return this.#cues.map(c => ({
      id: c.id, name: c.name, does: c.does,
      autopilot: this.#autopilot.get(c.id) ?? false,
      firedAt: this.#firedAt.get(c.id) ?? null,
      wouldHaveFired: this.#would.get(c.id) ?? 0,
      lastError: this.#errors.get(c.id) ?? null,
    }));
  }

  setAutopilot(id: string, on: boolean): boolean {
    if (!this.#cues.some(c => c.id === id)) return false;
    this.#autopilot.set(id, on);
    return true;
  }

  setAll(on: boolean): void {
    for (const cue of this.#cues) this.#autopilot.set(cue.id, on);
  }

  /** Run a cue by hand, ignoring its autopilot setting. */
  async fire(id: string): Promise<boolean> {
    const cue = this.#cues.find(c => c.id === id);
    if (!cue) return false;
    await this.#run(cue, {
      id: 'manual', ts: Date.now(), matchClock: this.#bus.state.matchClock,
      source: 'manual', confidence: 'authoritative', type: 'graphic.show', payload: {},
    });
    return true;
  }

  attach(): () => void {
    this.#unsubscribe = this.#bus.subscribe((ev, state) => {
      // Cue-sourced events must never re-trigger cues.
      if (ev.source === 'cue') return;

      for (const cue of this.#cues) {
        let matches = false;
        try { matches = cue.when(ev, state); }
        catch (err) { this.#errors.set(cue.id, (err as Error).message); continue; }
        if (!matches) continue;

        if (!this.#autopilot.get(cue.id)) {
          this.#would.set(cue.id, (this.#would.get(cue.id) ?? 0) + 1);
          continue;
        }
        void this.#run(cue, ev);
      }
    });
    return this.#unsubscribe;
  }

  detach(): void { this.#unsubscribe?.(); this.#unsubscribe = null; }

  async #run(cue: Cue, event: DeskEvent): Promise<void> {
    const ctx: CueContext = {
      bus: this.#bus,
      obs: this.#obs,
      event,
      state: this.#bus.state,
      scene: async name => {
        const sceneName = this.#scenes[name];
        // The community's #1 production rule: program never cuts away from
        // the full-field shot while a match is LIVE. "Every close-up action
        // stream ever missed the cool stuff." Autopilot honors the lock;
        // operator-driven events (manual fire, the replay console) still win.
        const live = this.#bus.state.matchStartedAt !== null;
        const operatorDriven = event.source === 'manual' || event.source === 'replay';
        if (live && !operatorDriven && name !== 'match') {
          console.log(`[cue] held scene "${sceneName}": match live, wide-shot lock`);
          return;
        }
        this.#bus.emit({ type: 'scene.change', source: 'cue', payload: { scene: sceneName } });
        // A missing OBS is not a failure. The graphics still switch; only the
        // camera cut is lost, and the switcher operator covers that.
        if (this.#obs?.connected) await this.#obs.setScene(sceneName);
      },
    };

    try {
      await cue.run(ctx);
      this.#firedAt.set(cue.id, Date.now());
      this.#errors.set(cue.id, null);
    } catch (err) {
      this.#errors.set(cue.id, (err as Error).message);
      console.warn(`[cue] ${cue.id} failed: ${(err as Error).message}`);
    }
  }
}
