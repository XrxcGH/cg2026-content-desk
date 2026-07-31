/**
 * Rolling record supervisor. See docs/04-replay-and-telestrator.md.
 *
 * One ffmpeg per source, writing wall-clock-aligned segments. Deliberately NOT
 * OBS's replay buffer: a fixed buffer can only save "the last N seconds", not
 * "0:47 to 0:53", and it composites one feed so you can't change camera angle
 * after seeing the play. Segments on disk give every angle, always, and a crash
 * costs one segment rather than the match.
 *
 * The supervisor restarts a dead encoder with backoff, because a camera that
 * gets unplugged and replugged at 11am must not need a human to notice.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnDetached, type EncoderChoice, type FfmpegTools } from './ffmpeg.ts';

export interface SourceConfig {
  id: string;
  label: string;
  /** ffmpeg input args, e.g. ['-f','dshow','-i','video=Cam1'] */
  input: string[];
  enabled?: boolean;
  /** Program feed gets recorded for upload; ISO cameras feed replay only. */
  role?: 'program' | 'iso';
}

export interface RecorderConfig {
  root: string;
  segmentSeconds: number;
  bitrate: string;
  sources: SourceConfig[];
}

export interface SourceStatus {
  id: string;
  label: string;
  role: 'program' | 'iso';
  running: boolean;
  restarts: number;
  startedAt: number | null;
  lastError: string | null;
}

export class Recorder {
  #tools: FfmpegTools;
  #encoder: EncoderChoice;
  #cfg: RecorderConfig;
  #procs = new Map<string, ChildProcess>();
  #status = new Map<string, SourceStatus>();
  #backoff = new Map<string, number>();
  #timers = new Set<NodeJS.Timeout>();
  #stopping = false;

  constructor(tools: FfmpegTools, encoder: EncoderChoice, cfg: RecorderConfig) {
    this.#tools = tools;
    this.#encoder = encoder;
    this.#cfg = cfg;
  }

  get status(): SourceStatus[] { return [...this.#status.values()]; }
  get encoder(): string { return this.#encoder.encoder; }
  dirFor(sourceId: string): string { return join(this.#cfg.root, sourceId); }

  async start(): Promise<void> {
    for (const src of this.#cfg.sources) {
      if (src.enabled === false) continue;
      this.#status.set(src.id, {
        id: src.id, label: src.label, role: src.role ?? 'iso',
        running: false, restarts: 0, startedAt: null, lastError: null,
      });
      await mkdir(this.dirFor(src.id), { recursive: true });
      this.#spawn(src);
    }
  }

  #args(src: SourceConfig): string[] {
    const pattern = join(this.dirFor(src.id), '%Y%m%d-%H%M%S.mp4');
    return [
      '-hide_banner', '-loglevel', 'warning',
      // Stamp with wall clock so a segment's filename means what it says even
      // if the source's own timestamps drift.
      '-use_wallclock_as_timestamps', '1',
      ...src.input,
      '-c:v', this.#encoder.encoder, ...this.#encoder.args,
      '-b:v', this.#cfg.bitrate,
      '-pix_fmt', 'yuv420p',
      '-f', 'segment',
      '-segment_time', String(this.#cfg.segmentSeconds),
      // Align cuts to wall-clock multiples so filename -> start time is exact.
      // Without this, boundaries drift and clip maths slowly goes wrong.
      '-segment_atclocktime', '1',
      '-reset_timestamps', '1',
      '-strftime', '1',
      pattern,
    ];
  }

  #spawn(src: SourceConfig): void {
    if (this.#stopping) return;

    const proc = spawnDetached(this.#tools.ffmpeg, this.#args(src));
    this.#procs.set(src.id, proc);

    const st = this.#status.get(src.id)!;
    st.running = true;
    st.startedAt = Date.now();

    let stderr = '';
    proc.stderr?.on('data', d => {
      stderr = (stderr + d).slice(-2000);   // keep the tail, not the whole run
    });

    proc.on('exit', (code, signal) => {
      st.running = false;
      st.startedAt = null;
      this.#procs.delete(src.id);
      if (this.#stopping) return;

      st.lastError = stderr.trim().split('\n').at(-1) ?? `exit ${code ?? signal}`;
      st.restarts++;

      // Backoff caps at 15s: a camera that is genuinely gone shouldn't spin,
      // but one that is coming back should be picked up quickly.
      const wait = Math.min(15_000, (this.#backoff.get(src.id) ?? 500) * 2);
      this.#backoff.set(src.id, wait);
      console.warn(`[rec] ${src.id} stopped (${st.lastError}), retrying in ${wait}ms`);

      const t = setTimeout(() => { this.#timers.delete(t); this.#spawn(src); }, wait);
      this.#timers.add(t);
    });

    // A source that survives a minute is healthy; forget its earlier failures.
    const settle = setTimeout(() => {
      this.#timers.delete(settle);
      if (this.#procs.get(src.id) === proc) this.#backoff.set(src.id, 500);
    }, 60_000);
    this.#timers.add(settle);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    // 'q' asks ffmpeg to finalise the current segment; SIGKILL would leave the
    // last file unplayable, which is exactly the moment you'd want it.
    for (const [, proc] of this.#procs) proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    for (const [, proc] of this.#procs) if (!proc.killed) proc.kill('SIGKILL');
    this.#procs.clear();
  }
}
