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
import { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { CueEngine } from './cue/engine.ts';
import { ObsClient } from './cue/obs.ts';
import { loadConfig, publishReadiness } from './config.ts';
import { PublishQueue } from './publish/queue.ts';
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

// ---- Cheesy Arena field bridge ---------------------------------------------
// Deliberately a launch flag rather than a config setting: the bridge needs FTA
// sign-off, and turning it on should be an explicit act at the point of use,
// not something inherited from a file that got copied between machines.
//
//   --cheesy [--cheesy-host 10.0.100.5:8080] [--display-id contentdesk1]
//
// See docs/10-field-bridge.md. Only HandleNotifiers-only sockets are reachable.
let cheesy: CheesyAdapter | null = null;
if (has('cheesy')) {
  cheesy = new CheesyAdapter({
    bus,
    host: arg('cheesy-host') || '10.0.100.5:8080',
    displayId: arg('display-id') || 'contentdesk1',
  });
  cheesy.start();
  console.log(`[cheesy] bridging ${arg('cheesy-host') || '10.0.100.5:8080'} ` +
    `as display "${arg('display-id') || 'contentdesk1'}"`);
} else {
  console.log('[cheesy] bridge off — pass --cheesy to connect to the field');
}

// ---- show automation --------------------------------------------------------
// OBS password comes from the environment, never a CLI arg — argv is visible
// in `ps` and in the shell history of whoever launched it.
//
//   --obs [--obs-host 127.0.0.1:4455]   OBS_PASSWORD=…
//   --autopilot                          arm every cue at boot (default: off)
let obs: ObsClient | null = null;
if (has('obs')) {
  obs = new ObsClient({
    host: arg('obs-host') || '127.0.0.1:4455',
    ...(process.env['OBS_PASSWORD'] ? { password: process.env['OBS_PASSWORD'] } : {}),
    onStatus: (up, detail) => console.log(`[obs] ${up ? 'connected' : 'down'} — ${detail}`),
  });
  obs.connect();
}

// Cues start disarmed. Nobody should discover automation by having it happen
// to them mid-match — the producer arms each cue after watching it be right.
const cues = new CueEngine(bus, obs, { autopilot: has('autopilot') });
cues.attach();
console.log(`[cue] ${cues.status.length} cues loaded, autopilot ` +
  `${has('autopilot') ? 'ARMED' : 'off'} — arm per-cue from the desk`);

// ---- publishing -----------------------------------------------------------
const config = await loadConfig(ROOT);
const publish = new PublishQueue(ROOT, config, bus, clips);
await publish.load();

{
  const missing = publishReadiness(config);
  if (!config.publish.enabled) {
    console.log('[publish] disabled — set publish.enabled in config.json to turn it on');
  } else if (missing.youtube.length || missing.tba.length) {
    console.warn('[publish] enabled but incomplete: missing ' +
      [...missing.youtube, ...missing.tba].join(', '));
  } else {
    console.log(`[publish] ready · mode=${config.publish.mode} · event=${config.event.key}`);
  }
}

// A match video is queued when the score is posted, not at the buzzer — the
// cut needs the score-reveal timestamp to know where its second part starts.
if (config.publish.autoQueueMatches) {
  bus.subscribe(ev => {
    if (ev.type !== 'match.score_posted') return;
    void publish.queueMatch().then(item => {
      if (item) console.log(`[publish] queued ${item.label} (${item.ranges.length} part(s))`);
    }).catch(err => console.warn('[publish] auto-queue failed:', (err as Error).message));
  });
}

const server = startServer({
  bus, media, root: ROOT, port, host, recorder, clips, publish, config, cheesy, cues, obs,
});

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
  cheesy?.stop();
  cues.detach();
  obs?.close();
  server.close();
  // Give ffmpeg a moment to finalise the segment it's mid-way through —
  // SIGKILL would leave the most recent file unplayable, which is exactly the
  // one you'd want after a crash.
  void recorder?.stop().finally(() => process.exit(0));
  if (!recorder) process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
