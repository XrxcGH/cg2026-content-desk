/**
 * Durable publish queue: cut -> upload -> link on TBA.
 *
 * Deliberately boring. A JSON file, a state machine, exponential backoff, and
 * a panel showing what's stuck. It has to survive a crash, the venue internet
 * dropping, and the event ending. Nobody should have to SSH into anything on
 * a Sunday.
 *
 * See docs/11-distribution.md.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../config.ts';
import type { EventBus } from '../bus.ts';
import { matchCut, type ClipStore, type Range } from '../clips.ts';
import { TbaClient } from './tba.ts';
import { description, identify, isPractice, segmentDescription, segmentName, videoTitle } from './naming.ts';
import { YouTubeClient, watchUrl, type VideoMeta } from './youtube.ts';

export type ItemKind = 'match' | 'analysis' | 'segment';

export type ItemState =
  | 'pending'    // queued, nothing done
  | 'cut'        // clip exists on disk
  | 'uploaded'   // on YouTube, not yet linked
  | 'done'
  | 'failed'
  | 'held';      // deferred mode, waiting for the go-ahead

export interface QueueItem {
  id: string;
  kind: ItemKind;
  label: string;
  sourceId: string;
  ranges: Range[];
  /** TBA match key, when this is a match video. */
  matchKey: string | null;
  meta: { title: string; description: string };
  state: ItemState;
  clipPath: string | null;
  videoId: string | null;
  sessionUrl: string | null;
  attempts: number;
  error: string | null;
  progress: number;
  createdAt: number;
  updatedAt: number;
}

const MAX_ATTEMPTS = 6;

/**
 * Plausible durations, per kind of video.
 *
 * FIRST's own auto-uploader has shipped 11-second "match videos" and whole
 * wrong matches, which is what this guards against. The bounds have to differ
 * by kind: 15 minutes is far too long for a match and far too short for an
 * awards ceremony, and one set of numbers would either wave through a broken
 * match cut or hold every ceremony.
 */
export const QC_BOUNDS: Record<ItemKind, { minSec: number; maxSec: number }> = {
  match: { minSec: 60, maxSec: 900 },
  analysis: { minSec: 20, maxSec: 1800 },
  segment: { minSec: 30, maxSec: 7200 },
};

/** The hold reason, or null when the cut looks like what it claims to be. */
export function qcHold(kind: ItemKind, cutSeconds: number): string | null {
  const { minSec, maxSec } = QC_BOUNDS[kind];
  const seconds = Math.round(cutSeconds);
  if (seconds < minSec || seconds > maxSec) {
    return `QC hold: cut totals ${seconds}s, outside ${minSec}-${maxSec}s for a ${kind}. `
      + 'Check the clip, then release';
  }
  return null;
}

export class PublishQueue {
  #file: string;
  #items: QueueItem[] = [];
  #cfg: Config;
  #bus: EventBus;
  #clips: ClipStore | null;
  #yt: YouTubeClient;
  #tba: TbaClient;
  #running = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(root: string, cfg: Config, bus: EventBus, clips: ClipStore | null) {
    this.#file = join(root, 'data', 'publish-queue.json');
    this.#cfg = cfg;
    this.#bus = bus;
    this.#clips = clips;
    this.#yt = new YouTubeClient(cfg.youtube);
    this.#tba = new TbaClient(cfg.tba, cfg.event.key);
  }

  get items(): readonly QueueItem[] { return this.#items; }
  get ready(): { youtube: boolean; tba: boolean } {
    return { youtube: this.#yt.configured, tba: this.#tba.configured };
  }

  async load(): Promise<void> {
    try {
      this.#items = JSON.parse(await readFile(this.#file, 'utf8')) as QueueItem[];
      const unfinished = this.#items.filter(i => i.state !== 'done').length;
      if (this.#items.length) {
        console.log(`[publish] restored ${this.#items.length} item(s), ${unfinished} unfinished`);
      }
    } catch { this.#items = []; }
  }

  /** Atomic write: a torn queue file on a power cut would be worse than none. */
  async #save(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#items, null, 2));
    await rename(tmp, this.#file);
  }

  async add(init: Omit<QueueItem, 'id' | 'state' | 'clipPath' | 'videoId' | 'sessionUrl'
    | 'attempts' | 'error' | 'progress' | 'createdAt' | 'updatedAt'>): Promise<QueueItem> {
    const item: QueueItem = {
      ...init,
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      // In deferred mode items are cut but parked. The live stream must never
      // compete with an upload for the venue uplink.
      state: 'pending',
      clipPath: null, videoId: null, sessionUrl: null,
      attempts: 0, error: null, progress: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.#items.push(item);
    await this.#save();
    this.#bus.emit({ type: 'graphic.show', source: 'cue', payload: { publish: item.id } });
    this.kick();
    return item;
  }

  /** Queue the current or just-finished match, framed for broadcast. */
  async queueMatch(): Promise<QueueItem | null> {
    const st = this.#bus.state;
    const startedAt = st.lastMatchStartedAt;
    if (!startedAt) return null;

    const displayName = st.match?.displayName ?? 'Match';
    // Practice matches are explicitly never published (docs/11-distribution.md):
    // queueing one would cut, upload, and link a scrimmage as tournament play.
    if (isPractice(displayName)) return null;

    // Official FIRST-channel naming: "Qualification 42 - CalGames".
    const { name, key } = identify(displayName);
    const title = videoTitle(name, this.#cfg.event.name);

    if (this.#items.some(i => i.kind === 'match' && i.label === name && i.state !== 'failed')) {
      return null;                                   // already queued
    }

    const ranges = matchCut({
      startedAt, endedAt: st.matchEndedAt, scorePostedAt: st.scorePostedAt,
    });

    const teams = (side: 'red' | 'blue'): number[] =>
      (st.match?.[side] ?? []).map(t => t.number);

    // A cut whose duration is implausible goes up HELD, not published. The
    // operator eyeballs it and releases, reusing the deferred-mode go-ahead.
    const hold = qcHold('match', ranges.reduce((s, r) => s + (r.toMs - r.fromMs) / 1000, 0));

    const item = await this.add({
      kind: 'match',
      label: name,
      sourceId: this.#cfg.publish.sourceId,
      ranges,
      matchKey: key,
      meta: {
        title,
        description: description({
          title,
          red: { teams: teams('red'), score: st.score.red.total },
          blue: { teams: teams('blue'), score: st.score.blue.total },
          resultsUrl: this.#cfg.event.resultsUrl,
          credit: this.#cfg.publish.credit,
          copyright: this.#cfg.publish.copyright,
        }),
      },
    });

    if (hold) await this.#hold(item, hold);
    return item;
  }

  /**
   * Queue one of the parts of the day that is not a match: alliance selection,
   * an awards ceremony, a single award. The operator marks the start and the
   * end, because nothing on the bus knows when a ceremony began.
   *
   * These carry no TBA match key, so the queue links them to the event as
   * media rather than to a match, which is the same path the analysis desk
   * clips already take.
   */
  async queueSegment(opts: {
    /** A `SEGMENTS` id, or any literal title such as an award name. */
    segment: string;
    fromMs: number;
    toMs: number;
    note?: string;
    sourceId?: string;
  }): Promise<QueueItem> {
    if (!(opts.toMs > opts.fromMs)) {
      throw new Error('The segment ends before it starts.');
    }

    const name = segmentName(opts.segment);
    const title = videoTitle(name, this.#cfg.event.name);
    const ranges: Range[] = [{ fromMs: opts.fromMs, toMs: opts.toMs }];

    const item = await this.add({
      kind: 'segment',
      label: name,
      sourceId: opts.sourceId ?? this.#cfg.publish.sourceId,
      ranges,
      matchKey: null,
      meta: {
        title,
        description: segmentDescription({
          title,
          note: opts.note,
          resultsUrl: this.#cfg.event.resultsUrl,
          credit: this.#cfg.publish.credit,
          copyright: this.#cfg.publish.copyright,
        }),
      },
    });

    const hold = qcHold('segment', (opts.toMs - opts.fromMs) / 1000);
    if (hold) await this.#hold(item, hold);
    return item;
  }

  async #hold(item: QueueItem, reason: string): Promise<void> {
    item.state = 'held';
    item.error = reason;
    item.updatedAt = Date.now();
    await this.#save();
    console.warn(`[publish] ${item.label} held for QC`);
  }

  /** Nudge the worker. Safe to call from anywhere, any number of times. */
  kick(): void {
    if (this.#running || this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#work(); }, 250);
  }

  /** Release everything parked in deferred mode: "the venue is closed, go". */
  async release(): Promise<number> {
    let n = 0;
    for (const item of this.#items) {
      if (item.state === 'held') { item.state = item.clipPath ? 'cut' : 'pending'; n++; }
    }
    if (n) { await this.#save(); this.kick(); }
    return n;
  }

  async retry(id: string): Promise<void> {
    const item = this.#items.find(i => i.id === id);
    if (!item) return;
    item.state = item.videoId ? 'uploaded' : item.clipPath ? 'cut' : 'pending';
    item.attempts = 0;
    item.error = null;
    await this.#save();
    this.kick();
  }

  #next(): QueueItem | undefined {
    return this.#items.find(i =>
      (i.state === 'pending' || i.state === 'cut' || i.state === 'uploaded')
      && i.attempts < MAX_ATTEMPTS);
  }

  async #work(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        const item = this.#next();
        if (!item) break;
        const advanced = await this.#step(item);
        await this.#save();
        if (!advanced) break;                        // backoff or blocked
      }
    } finally {
      this.#running = false;
    }
  }

  /** Returns true if it made progress and the loop should continue. */
  async #step(item: QueueItem): Promise<boolean> {
    const fail = (err: unknown): boolean => {
      item.attempts++;
      item.error = (err as Error).message;
      item.updatedAt = Date.now();
      if (item.attempts >= MAX_ATTEMPTS) item.state = 'failed';
      console.warn(`[publish] ${item.label}: ${item.error}`);
      // Back off before the next sweep rather than hammering.
      this.#timer = setTimeout(() => { this.#timer = null; void this.#work(); },
        Math.min(120_000, 2 ** item.attempts * 1000));
      return false;
    };

    try {
      if (item.state === 'pending') {
        if (!this.#clips) throw new Error('Recording is unavailable, so nothing can be cut.');
        const clip = await this.#clips.extract({
          sourceId: item.sourceId, ranges: item.ranges, label: item.label,
        });
        item.clipPath = clip.path;
        item.state = 'cut';
        item.error = null;
        item.updatedAt = Date.now();
        this.#bus.emit({ type: 'replay.clip_ready', source: 'replay', payload: { ...clip, kind: item.kind } });
        return true;
      }

      if (item.state === 'cut') {
        if (!this.#cfg.publish.enabled) { item.state = 'held'; return true; }
        if (this.#cfg.publish.mode === 'deferred') { item.state = 'held'; return true; }
        if (!this.#yt.configured) throw new Error('YouTube credentials are not configured.');

        const meta: VideoMeta = {
          title: item.meta.title,
          description: item.meta.description,
          privacyStatus: this.#cfg.publish.privacy,
          tags: ['FRC', 'FIRST Robotics', this.#cfg.event.name],
        };
        item.videoId = await this.#yt.upload(item.clipPath!, meta, {
          sessionUrl: item.sessionUrl ?? undefined,
          onSession: url => { item.sessionUrl = url; },
          onProgress: (sent, total) => { item.progress = total ? sent / total : 0; },
        });
        item.progress = 1;
        item.state = 'uploaded';
        item.error = null;
        item.updatedAt = Date.now();

        const playlist = this.#cfg.publish.playlists[item.kind];
        if (playlist) await this.#yt.addToPlaylist(item.videoId, playlist);
        return true;
      }

      if (item.state === 'uploaded') {
        if (this.#tba.configured) {
          if (item.kind === 'match' && item.matchKey) {
            await this.#tba.addMatchVideo(item.matchKey, item.videoId!);
          } else {
            await this.#tba.addEventMedia(item.videoId!);
          }
        }
        // Publish only after linking succeeds, so a failed link never leaves
        // an orphan video with no context.
        if (this.#cfg.publish.publicAfterLink && this.#cfg.publish.privacy !== 'public') {
          await this.#yt.setPrivacy(item.videoId!, 'public');
        }
        item.state = 'done';
        item.error = null;
        item.updatedAt = Date.now();
        console.log(`[publish] ${item.label} -> ${watchUrl(item.videoId!)}`);
        return true;
      }
    } catch (err) {
      return fail(err);
    }
    return false;
  }
}
