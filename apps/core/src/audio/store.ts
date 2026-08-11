/**
 * House audio. See the two-bus rule in docs/06-hardware-and-network.md.
 *
 * This module controls what the ROOM hears. It has no route to the stream and
 * cannot acquire one: the guarantee that keeps licensed music off the VOD is
 * that the music machine is not patched into the stream aux at all, and that is
 * a cable, not a setting. What was missing was not safety, it was a control
 * surface: the playlist lived on a laptop nobody at the desk could reach, so
 * "pause the music, the announcer is talking" was a shout across the gym.
 *
 * The model is one question: WHO OWNS THE ROOM RIGHT NOW.
 *
 *   playlist  the event playlist is up
 *   clip      a walk-up or stinger is playing, and the playlist is under it
 *   console   the arcade's game audio has the room; we are quiet on purpose
 *   silent    nothing, because an announcer, an award, or a ceremony is on
 *
 * Everything else follows. Nothing here decides volume policy on its own: a
 * cue asks for a source, an operator asks for a source, and the source decides
 * what the music service is told.
 *
 * The music service is injected rather than imported so that this file has no
 * opinion about which one it is, and so the desk runs unchanged when it is not
 * configured at all. Every call into it is best effort: the venue uplink WILL
 * be down at some point on Sunday, and a dead music service must degrade to
 * "the clips still work", never to a broken desk.
 */

import type { EventBus } from '../bus.ts';
import type { Clip, ClipLibrary } from './library.ts';

export type HouseSource = 'playlist' | 'clip' | 'console' | 'silent';

export interface NowPlaying {
  title: string;
  artist: string;
  /** Null when the service gives us none, or when art is not worth fetching. */
  art: string | null;
  durationMs: number;
  progressMs: number;
  /** When progress was sampled, so the desk can run the bar between polls. */
  sampledAt: number;
}

export interface MusicStatus {
  playing: boolean;
  /** The Spotify Connect device (or equivalent) currently selected. */
  device: string | null;
  volume: number | null;
  now: NowPlaying | null;
  context: { uri: string; name: string } | null;
}

/**
 * What the store needs from a music service. Small on purpose: this is transport
 * control, not a music browser. Anything a desk operator does mid-show has to be
 * one button, and anything more than that they can do in the service's own app.
 */
export interface MusicController {
  /** Shown on the desk: "Spotify". */
  readonly name: string;
  /** False until credentials exist and a token has been minted. */
  readonly linked: boolean;
  status(): Promise<MusicStatus>;
  play(opts?: { contextUri?: string }): Promise<void>;
  pause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setVolume(percent: number): Promise<void>;
  playlists(): Promise<{ uri: string; name: string }[]>;
}

export interface AudioAutomation {
  /** Drop the music when the field goes ready, before the countdown. */
  pauseForMatch: boolean;
  /** Bring it back once the score is posted and the moment has landed. */
  resumeAfterScore: boolean;
  /** Go quiet when the arcade takes the room. */
  yieldToConsole: boolean;
}

export interface PlayingClip {
  id: string;
  label: string;
  team: number | null;
  src: string;
  startedAt: number;
  /**
   * Changes on every fire. The house player plays a clip when the token is one
   * it has not seen; without it a page reload mid-introduction would replay the
   * walk-up of whoever was announced a minute ago.
   */
  token: string;
}

export interface HouseAudioSnapshot {
  source: HouseSource;
  /** Why, in the desk's words. Shown under the transport. */
  reason: string;
  music: {
    configured: boolean;
    linked: boolean;
    /** Last call to the service succeeded. False the moment the uplink dies. */
    reachable: boolean;
    service: string;
    device: string | null;
    volume: number;
    ducked: boolean;
    playing: boolean;
    now: NowPlaying | null;
    context: { uri: string; name: string } | null;
    playlists: { uri: string; name: string }[];
    error: string | null;
  };
  clip: PlayingClip | null;
  clips: Clip[];
  /**
   * House player pages currently alive, and how many of those have been armed
   * (a browser will not make a sound until someone has clicked the page once).
   *
   * Exactly one armed player is right. ZERO means the desk is firing walk-ups
   * into a void, which is the failure you discover during alliance
   * introductions. TWO means the player is open on a second machine, and if
   * that machine is the one OBS captures, the music is on the stream. Both are
   * worth a line on the desk, so both are counted.
   */
  players: { alive: number; armed: number };
  auto: AudioAutomation;
  updatedAt: number;
}

/** Percent. Ducking is for talk-over; the room should still feel it there. */
const DUCK_VOLUME = 22;
const FULL_VOLUME = 70;

export interface HouseAudioOptions {
  controller?: MusicController | null;
  library: ClipLibrary;
  /** Playlist started by "play" when nothing else is loaded. */
  defaultPlaylistUri?: string;
  auto?: Partial<AudioAutomation>;
}

export class HouseAudio {
  #bus: EventBus;
  #lib: ClipLibrary;
  #music: MusicController | null;
  #defaultUri: string;

  #source: HouseSource = 'silent';
  #reason = 'Nothing playing yet';
  /** What to go back to when a clip finishes. */
  #resumeTo: HouseSource = 'silent';
  #clip: PlayingClip | null = null;
  #ducked = false;
  #volume = FULL_VOLUME;
  /** id -> last heartbeat. See notePlayer(). */
  #players = new Map<string, { armed: boolean; seenAt: number }>();

  #status: MusicStatus = { playing: false, device: null, volume: null, now: null, context: null };
  #playlists: { uri: string; name: string }[] = [];
  #reachable = false;
  #error: string | null = null;
  #auto: AudioAutomation;
  #poll: NodeJS.Timeout | null = null;
  #seq = 0;

  constructor(bus: EventBus, opts: HouseAudioOptions) {
    this.#bus = bus;
    this.#lib = opts.library;
    this.#music = opts.controller ?? null;
    this.#defaultUri = opts.defaultPlaylistUri ?? '';
    this.#auto = {
      pauseForMatch: opts.auto?.pauseForMatch ?? true,
      resumeAfterScore: opts.auto?.resumeAfterScore ?? true,
      yieldToConsole: opts.auto?.yieldToConsole ?? true,
    };
  }

  get snapshot(): HouseAudioSnapshot {
    return {
      source: this.#source,
      reason: this.#reason,
      music: {
        configured: !!this.#music,
        linked: this.#music?.linked ?? false,
        reachable: this.#reachable,
        service: this.#music?.name ?? 'none',
        device: this.#status.device,
        volume: this.#volume,
        ducked: this.#ducked,
        playing: this.#status.playing,
        now: this.#status.now,
        context: this.#status.context,
        playlists: this.#playlists,
        error: this.#error,
      },
      clip: this.#clip,
      clips: this.#lib.clips,
      players: this.#livePlayers(),
      auto: this.#auto,
      updatedAt: Date.now(),
    };
  }

  #publish(): void {
    this.#bus.emit({ type: 'audio.updated', source: 'manual', payload: this.snapshot });
  }

  // ---- the music service, always best effort ----------------------------

  /**
   * Every call into the service goes through here. A failure is recorded and
   * shown; it never throws into a route handler and never stops a cue. The
   * desk's own state is what it INTENDED, which is the honest thing to show
   * when the thing we are driving has stopped answering.
   */
  async #tell(what: string, fn: (m: MusicController) => Promise<void>): Promise<void> {
    const music = this.#music;
    if (!music) return;
    try {
      await fn(music);
      this.#reachable = true;
      this.#error = null;
    } catch (err) {
      this.#reachable = false;
      this.#error = `${what} failed: ${(err as Error).message}`;
      console.warn(`[audio] ${this.#error}`);
    }
  }

  /** Poll now-playing so the desk can show what the room is hearing. */
  async refresh(): Promise<void> {
    const music = this.#music;
    if (!music?.linked) return;
    try {
      this.#status = await music.status();
      if (typeof this.#status.volume === 'number') this.#volume = this.#status.volume;
      this.#reachable = true;
      this.#error = null;
    } catch (err) {
      this.#reachable = false;
      this.#error = (err as Error).message;
    }
    this.#publish();
  }

  /**
   * Poll while somebody is watching. Slow on purpose: a track title that is two
   * seconds stale costs nothing, and every service worth driving rate-limits.
   */
  start(everyMs = 5000): void {
    if (this.#poll || !this.#music) return;
    void this.loadPlaylists();
    void this.refresh();
    this.#poll = setInterval(() => { void this.refresh(); }, everyMs);
    this.#poll.unref?.();
  }

  stop(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
  }

  async loadPlaylists(): Promise<void> {
    const music = this.#music;
    if (!music?.linked) return;
    try {
      this.#playlists = await music.playlists();
      this.#reachable = true;
    } catch (err) {
      this.#error = `playlists failed: ${(err as Error).message}`;
    }
    this.#publish();
  }

  // ---- who owns the room -------------------------------------------------

  /**
   * The one entry point everything else routes through. A cue and an operator
   * button do exactly the same thing here, which is what makes the automation
   * safe to hand over: there is no path a cue can take that a person cannot
   * immediately take back.
   */
  async setSource(source: HouseSource, reason: string): Promise<HouseAudioSnapshot> {
    if (source !== 'clip') {
      this.#clip = null;
      this.#resumeTo = source;
    }
    this.#source = source;
    this.#reason = reason;

    if (source === 'playlist') {
      this.#ducked = false;
      await this.#tell('volume', m => m.setVolume(this.#volume));
      await this.#tell('play', m => m.play(
        this.#status.context ? {} : { contextUri: this.#defaultUri || undefined },
      ));
    } else if (source === 'clip') {
      // A walk-up plays over a ducked bed rather than a hard cut: the room
      // notices silence more than it notices the track dropping 15dB.
      this.#ducked = true;
      await this.#tell('duck', m => m.setVolume(DUCK_VOLUME));
    } else {
      // console and silent both mean "not us". Pause rather than duck: the
      // arcade's audio and an announcer both need the room, not a bed.
      await this.#tell('pause', m => m.pause());
    }

    this.#publish();
    return this.snapshot;
  }

  async play(): Promise<HouseAudioSnapshot> {
    return this.setSource('playlist', 'Playlist, from the desk');
  }

  async pause(): Promise<HouseAudioSnapshot> {
    return this.setSource('silent', 'Paused from the desk');
  }

  async skip(dir: 'next' | 'previous'): Promise<HouseAudioSnapshot> {
    await this.#tell(dir, m => (dir === 'next' ? m.next() : m.previous()));
    await this.refresh();
    return this.snapshot;
  }

  /** Talk-over. Separate from the source, because who owns the room does not
   *  change when the announcer says one sentence over the top of it. */
  async duck(on: boolean): Promise<HouseAudioSnapshot> {
    this.#ducked = on;
    await this.#tell('volume', m => m.setVolume(on ? DUCK_VOLUME : this.#volume));
    this.#publish();
    return this.snapshot;
  }

  async setVolume(percent: number): Promise<HouseAudioSnapshot> {
    if (!Number.isFinite(percent)) throw new Error('Volume must be a number.');
    this.#volume = Math.max(0, Math.min(100, Math.round(percent)));
    this.#ducked = false;
    await this.#tell('volume', m => m.setVolume(this.#volume));
    this.#publish();
    return this.snapshot;
  }

  async playPlaylist(uri: string): Promise<HouseAudioSnapshot> {
    if (!uri) throw new Error('Pick a playlist first.');
    this.#source = 'playlist';
    this.#resumeTo = 'playlist';
    this.#reason = 'Playlist changed at the desk';
    this.#ducked = false;
    await this.#tell('volume', m => m.setVolume(this.#volume));
    await this.#tell('play', m => m.play({ contextUri: uri }));
    await this.refresh();
    return this.snapshot;
  }

  // ---- clips -------------------------------------------------------------

  /**
   * Fire a walk-up or a stinger. Returns immediately: the house player is the
   * thing that actually makes noise, and it is a subscriber like every other
   * surface. If no house player is connected this still succeeds and the desk
   * shows `players: 0`, which is the honest report. Silently failing here would
   * be found out during alliance introductions.
   */
  async playClip(idOrTeam: string | number): Promise<HouseAudioSnapshot> {
    const clip = typeof idOrTeam === 'number'
      ? this.#lib.forTeam(idOrTeam)
      : this.#lib.find(idOrTeam);
    if (!clip) {
      throw new Error(typeof idOrTeam === 'number'
        ? `No walk-up loaded for team ${idOrTeam}.`
        : `No clip called "${idOrTeam}".`);
    }

    this.#clip = {
      id: clip.id,
      label: clip.label,
      team: clip.team,
      src: clip.src,
      startedAt: Date.now(),
      token: `c${Date.now().toString(36)}${(this.#seq++).toString(36)}`,
    };
    return this.setSource('clip', clip.team !== null
      ? `Walk-up for ${clip.team}`
      : `Stinger: ${clip.label}`);
  }

  /**
   * The house player reporting that the clip finished (or the operator killing
   * it). Returns the room to whatever had it before, so an introduction
   * sequence needs one button per team and nothing else.
   */
  async clipEnded(token?: string): Promise<HouseAudioSnapshot> {
    // A stale report must not cancel the clip that replaced it: two walk-ups
    // fired back to back would otherwise have the first one's "done" arriving
    // during the second.
    if (token && this.#clip && this.#clip.token !== token) return this.snapshot;
    if (this.#source !== 'clip') return this.snapshot;
    this.#clip = null;
    return this.setSource(this.#resumeTo, this.#resumeTo === 'playlist'
      ? 'Back to the playlist'
      : 'Clip finished');
  }

  // ---- wiring ------------------------------------------------------------

  setAutomation(patch: Partial<AudioAutomation>): AudioAutomation {
    this.#auto = { ...this.#auto, ...patch };
    this.#publish();
    return this.#auto;
  }

  get automation(): AudioAutomation { return this.#auto; }

  /**
   * House player heartbeat.
   *
   * A heartbeat rather than a socket count because what matters is not "is a
   * page open" but "is there something on this network that will actually make
   * a noise when I press the button". A page that has never been clicked cannot
   * play audio at all (browsers refuse until a gesture), and it looks identical
   * to a working one from the server side. So the player says so itself, and
   * stops saying so the moment its machine goes to sleep.
   */
  notePlayer(id: string, armed: boolean): void {
    const before = JSON.stringify(this.#livePlayers());
    this.#players.set(id, { armed, seenAt: Date.now() });
    if (JSON.stringify(this.#livePlayers()) !== before) this.#publish();
  }

  /** Anything that has not checked in for 25s is gone: three missed beats. */
  #livePlayers(): { alive: number; armed: number } {
    const cutoff = Date.now() - 25_000;
    let alive = 0, armed = 0;
    for (const [id, p] of this.#players) {
      if (p.seenAt < cutoff) { this.#players.delete(id); continue; }
      alive++;
      if (p.armed) armed++;
    }
    return { alive, armed };
  }

  /** After an upload, so the new clip's button appears without a reload. */
  clipsChanged(): void { this.#publish(); }
}
