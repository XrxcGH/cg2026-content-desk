/**
 * HTTP + WebSocket server. Serves every surface and fans out the event bus.
 *
 * Deliberately small: node:http, one `ws` dependency, no framework. This has
 * to be debuggable at 11pm on a Saturday by whoever is still awake.
 */

import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventBus, EmitInit } from './bus.ts';
import type { MediaLibrary } from './media.ts';
import type { Recorder } from './recorder.ts';
import { matchCut, type ClipStore, type Range } from './clips.ts';
import { markersSince } from './markers.ts';
import type { PublishQueue } from './publish/queue.ts';
import { redacted, publishReadiness, type Config } from './config.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { ALLOWED_PATHS, ALLOWED_SOCKETS } from './ingest/cheesy/client.ts';
import type { CueEngine } from './cue/engine.ts';
import type { ObsClient } from './cue/obs.ts';
import type { ArcadeStore } from './arcade/store.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

/** Surfaces, in the order they appear on the index page. */
export const SURFACES = [
  { id: 'program', name: 'Program overlay', note: 'OBS Browser Source, 1920x1080. Overview, match, and final score in one — screens switch on state, so the switcher never changes sources.' },
  { id: 'desk',    name: 'Desk console',    note: 'Keyboard-first. Runs the whole show with every integration dead.' },
  { id: 'media',   name: 'Team media',      note: 'Upload robot cutouts for the alliance overview.' },
  { id: 'draw',    name: 'Telestrator pad', note: 'Tablet + stylus. Draws on the frozen frame the audience is seeing.' },
  { id: 'tele',    name: 'Telestrator render', note: 'OBS Browser Source, layered over the replay. Strokes only, transparent.' },
  { id: 'replay',  name: 'Replay console',  note: 'Match-clock timeline with automatic markers. Cut, preview, send to the analyst.' },
  { id: 'arcade',  name: 'Arcade overlay',  note: 'OBS Browser Source. Smash sets and Mario Kart standings for the gaps.' },
  { id: 'arcadedesk', name: 'Arcade console', note: 'Run the side tournament. Operator-authoritative scoring.' },
  { id: 'side',    name: 'Side screen',     note: 'Venue TVs. On deck and rankings, rotating on a timer. Venue scale by default.' },
  { id: 'cards',   name: 'Post-match cards', note: '1080x1080 result graphics, auto-built when the score posts. Download or save to the desk.' },
] as const;

export interface ServerOpts {
  bus: EventBus;
  media: MediaLibrary;
  root: string;
  port: number;
  host: string;
  /** Absent when ffmpeg isn't installed — everything else still runs. */
  recorder?: Recorder | null;
  clips?: ClipStore | null;
  publish?: PublishQueue | null;
  config?: Config | null;
  /** Absent unless the bridge was started with --cheesy. */
  cheesy?: CheesyAdapter | null;
  cues?: CueEngine | null;
  obs?: ObsClient | null;
  arcade?: ArcadeStore | null;
}

export function startServer(opts: ServerOpts) {
  const { bus, media, root, port, host, recorder = null, clips = null,
          publish = null, config = null, cheesy = null, cues = null, obs = null,
          arcade = null } = opts;

  /** Never let a path escape its mount point. */
  function safeJoin(base: string, urlPath: string): string | null {
    const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
    const full = resolve(base, rel);
    return full === base || full.startsWith(base + sep) ? full : null;
  }

  async function sendFile(res: ServerResponse, path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      if (!s.isFile()) return false;
      res.writeHead(200, {
        'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': s.size,
        // Surfaces are edited live during rehearsal; never cache them.
        'Cache-Control': 'no-store',
      });
      createReadStream(path).pipe(res);
      return true;
    } catch { return false; }
  }

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    const b = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(b),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(b);
  };

  const readBody = (req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> =>
    new Promise((ok, fail) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > limit) { fail(new Error('Upload too large (32MB max)')); req.destroy(); return; }
        chunks.push(c as Buffer);
      });
      req.on('end', () => ok(Buffer.concat(chunks)));
      req.on('error', fail);
    });

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // ---- API ----------------------------------------------------------
      if (path === '/api/state') return json(res, 200, bus.state);
      if (path === '/api/media/manifest') return json(res, 200, media.manifest);
      if (path === '/api/events/recent') return json(res, 200, bus.recent.slice(-200));

      if (path === '/api/recorder') {
        return json(res, 200, {
          available: !!recorder,
          encoder: recorder?.encoder ?? null,
          sources: recorder?.status ?? [],
        });
      }

      // Extract a clip. Used by the replay console for replays, and later by
      // the publish queue for match videos — same operation, different bounds.
      if (path === '/api/clips' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available — ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as {
            sourceId?: string; fromMs?: number; toMs?: number;
            ranges?: Range[]; label?: string; speed?: number;
          };
          if (!body.sourceId) return json(res, 400, { error: 'sourceId is required' });

          const ranges = body.ranges?.length
            ? body.ranges
            : (body.fromMs && body.toMs ? [{ fromMs: body.fromMs, toMs: body.toMs }] : null);
          if (!ranges) return json(res, 400, { error: 'ranges, or fromMs and toMs, are required' });

          const clip = await clips.extract({
            sourceId: body.sourceId, ranges, label: body.label, speed: body.speed,
          });
          bus.emit({ type: 'replay.clip_ready', source: 'replay', payload: clip });
          return json(res, 200, clip);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      /**
       * Cut the current (or just-finished) match as a broadcast-framed video:
       * pre-roll over the announcer's countdown, the match, then a jump to the
       * score reveal — skipping however long the referees spent on fouls.
       */
      if (path === '/api/clips/match' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available — ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as
            { sourceId?: string } | null;
          const st = bus.state;
          const startedAt = st.matchStartedAt ?? bus.lastMatchStartedAt;
          if (!startedAt) return json(res, 409, { error: 'No match has started yet.' });

          const ranges = matchCut({
            startedAt,
            endedAt: st.matchEndedAt,
            scorePostedAt: st.scorePostedAt,
          });

          const clip = await clips.extract({
            sourceId: body?.sourceId ?? 'program',
            ranges,
            label: st.match?.displayName ?? 'match',
          });
          bus.emit({ type: 'replay.clip_ready', source: 'replay', payload: { ...clip, kind: 'match' } });
          return json(res, 200, { ...clip, parts: ranges.length });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- arcade ----------------------------------------------------------
      if (path === '/api/arcade') return json(res, 200, arcade?.snapshot ?? null);

      if (path.startsWith('/api/arcade/') && req.method === 'POST') {
        if (!arcade) return json(res, 503, { error: 'Arcade is not available.' });
        const action = path.slice('/api/arcade/'.length);
        try {
          const raw = await readBody(req, 32 * 1024);
          const body = raw.length ? JSON.parse(raw.toString('utf8')) as Record<string, unknown> : {};

          switch (action) {
            case 'set':
              arcade.startSet(body as unknown as Parameters<ArcadeStore['startSet']>[0]);
              break;
            case 'score':
              arcade.score(Number(body['player'] ?? 0), Number(body['delta'] ?? 1));
              break;
            case 'end': arcade.endSet(); break;
            case 'gp':
              arcade.startGrandPrix(
                String(body['name'] ?? 'Grand Prix'),
                (body['racers'] ?? []) as Parameters<ArcadeStore['startGrandPrix']>[1],
                Number(body['raceCount'] ?? 4),
              );
              break;
            case 'race': arcade.recordRace((body['order'] ?? []) as string[]); break;
            case 'undo': arcade.undoRace(); break;
            case 'upnext': arcade.setUpNext(String(body['text'] ?? '')); break;
            case 'clear': arcade.clear(); break;
            default: return json(res, 404, { error: `Unknown arcade action "${action}"` });
          }
          return json(res, 200, arcade.snapshot);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- show automation -------------------------------------------------
      if (path === '/api/cues') {
        return json(res, 200, {
          available: !!cues,
          obs: { connected: obs?.connected ?? false, attached: !!obs },
          cues: cues?.status ?? [],
        });
      }

      if (path.startsWith('/api/cues/') && req.method === 'POST') {
        if (!cues) return json(res, 503, { error: 'Cue engine is not running.' });
        const [id, action] = path.slice('/api/cues/'.length).split('/');

        if (id === 'all' && (action === 'arm' || action === 'disarm')) {
          cues.setAll(action === 'arm');
          return json(res, 200, { cues: cues.status });
        }
        if (!id) return json(res, 400, { error: 'Cue id required' });

        if (action === 'arm' || action === 'disarm') {
          const ok = cues.setAutopilot(id, action === 'arm');
          return json(res, ok ? 200 : 404, ok ? { cues: cues.status } : { error: `No cue "${id}"` });
        }
        if (action === 'fire') {
          // Manual always wins — fires regardless of the autopilot setting.
          const ok = await cues.fire(id);
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: `No cue "${id}"` });
        }
        return json(res, 404, { error: `Unknown cue action "${action}"` });
      }

      // ---- field bridge ---------------------------------------------------
      // docs/10 promises the FTA a printable list of every request we make.
      // This is that list, plus the allowlist it is constrained to.
      if (path === '/api/cheesy') {
        return json(res, 200, {
          bridged: !!cheesy,
          connected: cheesy?.client.connected ?? false,
          allowedSockets: ALLOWED_SOCKETS,
          allowedPaths: ALLOWED_PATHS,
          requests: cheesy?.client.audit.length ?? 0,
        });
      }

      if (path === '/api/cheesy/audit') {
        const rows = cheesy?.client.audit ?? [];
        if (url.searchParams.get('format') === 'text') {
          const text = rows.map(r =>
            `${new Date(r.ts).toISOString()}  ${r.method.padEnd(4)} ${r.status}  ${r.url}`).join('\n');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(text + (rows.length ? '\n' : 'No requests made.\n'));
          return;
        }
        return json(res, 200, rows);
      }

      // ---- publishing ----------------------------------------------------
      // Never returns a credential — only whether each one is present.
      if (path === '/api/publish') {
        return json(res, 200, {
          available: !!publish,
          config: config ? redacted(config) : null,
          missing: config ? publishReadiness(config) : null,
          ready: publish?.ready ?? null,
          items: publish?.items ?? [],
        });
      }

      if (path.startsWith('/api/publish/') && req.method === 'POST') {
        if (!publish) return json(res, 503, { error: 'Publishing is not available.' });
        const action = path.slice('/api/publish/'.length);
        try {
          if (action === 'match') {
            const item = await publish.queueMatch();
            return json(res, item ? 200 : 409,
              item ?? { error: 'Nothing to queue — no match has started, or it is already queued.' });
          }
          if (action === 'release') {
            return json(res, 200, { released: await publish.release() });
          }
          if (action.startsWith('retry/')) {
            await publish.retry(action.slice('retry/'.length));
            return json(res, 200, { ok: true });
          }
          return json(res, 404, { error: `Unknown publish action "${action}"` });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      if (path === '/api/markers') {
        const since = Number(url.searchParams.get('since') || 0)
          || (bus.lastMatchStartedAt ?? Date.now() - 20 * 60_000) - 60_000;
        return json(res, 200, markersSince(bus, since));
      }

      // Grab a frame and hand it to the telestrator as its backdrop.
      if (path === '/api/frame' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available — ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as
            { sourceId?: string; atMs?: number; analyst?: string; send?: boolean };
          if (!body.atMs) return json(res, 400, { error: 'atMs is required' });

          const frame = await clips.frameAt(body.sourceId ?? 'program', body.atMs);
          if (body.send !== false) {
            bus.emit({
              type: 'telestrator.frame',
              source: 'replay',
              payload: { frame: frame.url, ...(body.analyst ? { analyst: body.analyst } : {}) },
            });
          }
          return json(res, 200, frame);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      if (path.startsWith('/api/segments/')) {
        if (!clips) return json(res, 503, { error: 'Recording is not available.' });
        const sourceId = path.slice('/api/segments/'.length);
        const segs = await clips.index(sourceId);
        return json(res, 200, segs.map(s => ({
          startMs: s.startMs, seconds: s.seconds,
          file: s.file.split(/[\\/]/).pop(),
        })));
      }

      if (path.startsWith('/api/media/') && req.method === 'POST') {
        const team = Number(path.slice('/api/media/'.length));
        if (!Number.isInteger(team) || team <= 0) {
          return json(res, 400, { error: 'Bad team number' });
        }
        try {
          return json(res, 200, await media.ingest(team, await readBody(req)));
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // Save a rendered post-match card PNG to the desk, so it's on disk for
      // batch posting or the publish flow rather than only in a browser tab.
      if (path.startsWith('/api/cards/') && req.method === 'POST') {
        const raw = decodeURIComponent(path.slice('/api/cards/'.length));
        const name = (raw.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'match');
        try {
          const body = await readBody(req, 8 * 1024 * 1024);
          // Reject anything that isn't actually a PNG — the byte we serve back
          // as image/png must be one.
          if (body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) {
            return json(res, 422, { error: 'Body is not a PNG.' });
          }
          const dir = join(root, 'rec', 'cards');
          await mkdir(dir, { recursive: true });
          const file = `${name}.png`;
          await writeFile(join(dir, file), body);
          return json(res, 200, { url: `/cards/${file}`, bytes: body.length });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- Static mounts -------------------------------------------------
      const mounts: [string, string][] = [
        ['/theme/',  join(root, 'packages', 'theme')],
        ['/shared/', join(root, 'surfaces', '_shared')],
        ['/media/',  join(root, 'media')],
        ['/clips/',  join(root, 'rec', 'clips')],
        ['/cards/',  join(root, 'rec', 'cards')],
      ];
      for (const [prefix, base] of mounts) {
        if (!path.startsWith(prefix)) continue;
        const file = safeJoin(base, path.slice(prefix.length));
        if (file && await sendFile(res, file)) return;
        res.writeHead(404).end('Not found');
        return;
      }

      // ---- Surfaces: /s/{id} and /s/{id}/asset ---------------------------
      if (path.startsWith('/s/')) {
        const [id, ...rest] = path.slice(3).split('/');
        const base = safeJoin(join(root, 'surfaces'), id ?? '');
        if (base) {
          const file = rest.length && rest[0]
            ? safeJoin(base, rest.join('/'))
            : join(base, 'index.html');
          if (file && await sendFile(res, file)) return;
        }
        res.writeHead(404).end('No such surface');
        return;
      }

      if (path === '/') return sendIndex(res);

      res.writeHead(404).end('Not found');
    } catch (err) {
      console.error('[http]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    }
  });

  function sendIndex(res: ServerResponse): void {
    const rows = SURFACES.map(s =>
      `<a class="row" href="/s/${s.id}"><b>${s.name}</b><code>/s/${s.id}</code><i>${s.note}</i></a>`,
    ).join('');
    const html = `<!doctype html><html data-surface="light"><head><meta charset="utf-8">
<title>CalGames 2026 Content Desk</title>
<link rel="stylesheet" href="/theme/tokens.css">
<style>
body{padding:48px;max-width:860px;margin:0 auto;font-size:var(--font-ui-body)}
h1{font-size:38px;font-variation-settings:"wdth" 118;margin:0 0 4px}
p.sub{color:var(--text-dim);margin:0 0 32px}
.row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:16px 20px;
  margin-bottom:10px;background:var(--surface-raised);text-decoration:none;color:var(--text);
  clip-path:var(--chamfer);--ch:12px;transition:background var(--dur-tap) linear}
.row:hover{background:var(--surface-sunken)}
.row b{font-size:19px}
.row code{font-family:var(--font-mono);color:var(--accent);font-size:13px}
.row i{grid-column:1/-1;color:var(--text-dim);font-style:normal;font-size:13px}
</style></head><body>
<h1>CalGames 2026 Content Desk</h1>
<p class="sub">Core is running. Open a surface below, or point an OBS Browser Source at it.</p>
${rows}</body></html>`;
    res.writeHead(200, { 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-store' });
    res.end(html);
  }

  // ---- WebSocket fan-out -------------------------------------------------
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const send = (ws: WebSocket, msg: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws, req) => {
    const who = new URL(req.url ?? '/', 'http://x').searchParams.get('surface') ?? 'anon';
    send(ws, { t: 'snapshot', state: bus.state, media: media.manifest });

    ws.on('message', raw => {
      let msg: { t?: string; init?: EmitInit; channel?: string; data?: unknown };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }

      // Surfaces may inject events. Source is forced to 'manual' — a surface
      // can never claim to be the field.
      if (msg.t === 'emit' && msg.init?.type) {
        bus.emit({ ...msg.init, source: 'manual' });
        return;
      }

      // Relay: ephemeral, high-frequency data that must NOT go through the
      // bus. Telestrator strokes arrive at pointer rate; putting them in the
      // event log would bloat a 3-day NDJSON archive with hundreds of
      // thousands of coordinate pairs and add a reduce+serialise step to every
      // frame of a stroke. Relayed messages are broadcast and forgotten.
      // The durable record of a stroke is emitted separately, once, on finish.
      if (msg.t === 'relay' && msg.channel) {
        const out = JSON.stringify({ t: 'relay', channel: msg.channel, data: msg.data });
        for (const peer of wss.clients) {
          if (peer !== ws && peer.readyState === peer.OPEN) peer.send(out);
        }
      }
    });

    ws.on('error', err => console.error(`[ws:${who}]`, err.message));
  });

  const unsubscribe = bus.subscribe((ev, state) => {
    for (const ws of wss.clients) send(ws, { t: 'event', ev, state });
  });

  http.listen(port, host, () => {
    console.log(`[core] http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    for (const s of SURFACES) console.log(`         /s/${s.id.padEnd(9)} ${s.name}`);
  });

  return {
    close: () => { unsubscribe(); wss.close(); http.close(); },
    broadcastCount: () => wss.clients.size,
  };
}
