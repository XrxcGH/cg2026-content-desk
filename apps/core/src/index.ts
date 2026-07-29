/**
 * CalGames 2026 Content Desk — core.
 *
 *   npm run dev                       start, watch, demo driver off
 *   npm start -- --demo               simulated match, for building graphics
 *   npm run replay -- data/x.ndjson 4 replay a recorded event log at 4x
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { EventBus, logPathFor } from './bus.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';
import { startDemo } from './demo.ts';
import { attachMarkers } from './markers.ts';
import { chooseEncoder, findFfmpeg } from './ffmpeg.ts';
import { Recorder, type SourceConfig } from './recorder.ts';
import { ClipStore } from './clips.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}
const has = (name: string): boolean => arg(name) !== undefined;

const port = Number(arg('port') || process.env['PORT'] || 8720);
const host = arg('host') || process.env['HOST'] || '0.0.0.0';

const bus = new EventBus();
const media = new MediaLibrary(join(ROOT, 'media'));

await media.scan();
await bus.openLog(logPathFor(join(ROOT, 'data', 'events')));

// Automatic replay markers: bursts, lead changes, climbs, phase boundaries.
// The replay operator should never hunt.
attachMarkers(bus);

// ---- recording ------------------------------------------------------------
// Optional. Everything else runs without ffmpeg; only recording and replay
// need it.
const REC_ROOT = join(ROOT, 'rec');
let recorder: Recorder | null = null;
let clips: ClipStore | null = null;

const tools = await findFfmpeg(arg('ffmpeg-dir') || undefined);
if (!tools) {
  console.warn('[core] ffmpeg not found — recording and replay disabled. ' +
    '`winget install Gyan.FFmpeg`, then restart this shell.');
} else {
  const encoder = await chooseEncoder(tools.ffmpeg, arg('encoder') || undefined);
  clips = new ClipStore(tools, encoder, REC_ROOT);

  if (has('record')) {
    // `--test-sources` records synthetic colour bars so the whole pipeline can
    // be exercised without cameras plugged in.
    const sources: SourceConfig[] = has('test-sources')
      ? [
          { id: 'program', label: 'Program (test)', role: 'program',
            input: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'] },
          { id: 'cam1', label: 'Field wide (test)', role: 'iso',
            input: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'] },
        ]
      : [];

    if (!sources.length) {
      console.warn('[core] --record given with no sources. Pass --test-sources, ' +
        'or configure real inputs in recorder config.');
    } else {
      recorder = new Recorder(tools, encoder, {
        root: REC_ROOT,
        segmentSeconds: Number(arg('segment') || 6),
        bitrate: arg('bitrate') || '12M',
        sources,
      });
      await recorder.start();
      console.log(`[core] recording ${sources.length} source(s) to ${REC_ROOT}`);
    }
  }
}

const server = startServer({ bus, media, root: ROOT, port, host, recorder, clips });

// Phase boundaries are time-driven, not event-driven — endgame lockdown and
// the auto-end marker have to land even if nothing else is happening.
const ticker = setInterval(() => bus.advance(), 100);

const replayFile = arg('replay');
if (replayFile) {
  const speed = Number(process.argv[process.argv.indexOf('--replay') + 2] || 1);
  void bus.replay(resolve(ROOT, replayFile), Number.isFinite(speed) ? speed : 1);
} else if (has('demo')) {
  startDemo(bus);
}

const shutdown = (): void => {
  console.log('\n[core] shutting down');
  clearInterval(ticker);
  server.close();
  // Give ffmpeg a moment to finalise the segment it's mid-way through —
  // SIGKILL would leave the most recent file unplayable, which is exactly the
  // one you'd want after a crash.
  void recorder?.stop().finally(() => process.exit(0));
  if (!recorder) process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
