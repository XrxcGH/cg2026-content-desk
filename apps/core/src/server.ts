/**
 * HTTP + WebSocket server. Serves every surface and fans out the event bus.
 *
 * Deliberately small: node:http, one `ws` dependency, no framework. This has
 * to be debuggable at 11pm on a Saturday by whoever is still awake.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventBus, EmitInit } from './bus.ts';
import type { MediaLibrary } from './media.ts';
import type { Recorder } from './recorder.ts';
import { cookie, needsAuth, safeEqual } from './access.ts';
import { chapterText, chaptersFrom } from './chapters.ts';
import { matchCut, type ClipStore, type Range } from './clips.ts';
import { markersSince } from './markers.ts';
import type { PublishQueue } from './publish/queue.ts';
import { redacted, publishReadiness, type Config } from './config.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { ALLOWED_PATHS, ALLOWED_SOCKETS } from './ingest/cheesy/client.ts';
import type { CueEngine } from './cue/engine.ts';
import type { ObsClient } from './cue/obs.ts';
import type { ArcadeStore } from './arcade/store.ts';
import type { TriviaStore } from './trivia/store.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

/** Surfaces, grouped the way an operator thinks about them. */
export const SURFACES = [
  { id: 'program', group: 'On air', name: 'Program overlay', note: 'The broadcast graphic. One OBS Browser Source, 1920x1080. Holds every screen: alliance overview, live match, final score, alliance selection board, the how-to-watch explainer loop, analysis strap and arcade bumper. They switch on their own, or take one by hand from the desk.' },
  { id: 'tele',    group: 'On air', name: 'Telestrator render', note: 'The analyst\'s drawings, transparent. Layer it over the replay in OBS.' },
  { id: 'arcade',  group: 'On air', name: 'Arcade overlay',  note: 'Game sets and standings for the gaps between matches.' },
  { id: 'trivia',  group: 'On air', name: 'Trivia overlay',  note: 'Crowd trivia: question, countdown, answers, leaderboard.' },
  { id: 'side',    group: 'On air', name: 'Side screen',     note: 'For the venue TVs: who plays next, current rankings. Rotates on its own.' },
  { id: 'desk',    group: 'Run the show', name: 'Desk console', note: 'The main control panel. Runs everything, keyboard-first, even with no field connection.' },
  { id: 'talent',  group: 'Run the show', name: 'Talent view', note: 'The announcer\'s tablet: teams, ranks, live RP progress in words, local pronunciation notes.' },
  { id: 'replay',  group: 'Run the show', name: 'Replay console', note: 'Cut replays off the match timeline. Interesting moments are already marked.' },
  { id: 'draw',    group: 'Run the show', name: 'Telestrator pad', note: 'For the analyst\'s tablet. Draw on the frame the audience is seeing.' },
  { id: 'arcadedesk', group: 'Run the show', name: 'Arcade console', note: 'Score the game sets by hand. 2 players versus, 3-4 free-for-all.' },
  { id: 'triviadesk', group: 'Run the show', name: 'Trivia host', note: 'Open a question, reveal the answer, next. That\'s the whole job.' },
  { id: 'var',     group: 'Run the show', name: 'Head referee review', note: 'Frame-step the recording. Read-only: no cut, no air, no publish, no route to the field.' },
  { id: 'media',   group: 'Before the event', name: 'Team media', note: 'Upload robot photos for the pre-match overview. Missing photos fall back gracefully.' },
  { id: 'cards',   group: 'Before the event', name: 'Post-match cards', note: 'Square result graphics for social. They build themselves when a score posts.' },
  { id: 'quiz',    group: 'For the audience', name: 'Trivia play', note: 'The phone page the crowd joins from. The trivia overlay shows this URL.' },
  { id: 'watch',   group: 'For the audience', name: 'Watch on a monitor', note: 'Put any public screen on a pit TV. Composites the field feed under the overlay, so no OBS is needed. No PIN.' },
  { id: 'next',    group: 'For the audience', name: 'When do we play?', note: 'Per-team schedule on any phone, with honest drift-adjusted start estimates. Side screens show its QR.' },
  { id: 'remote',  group: 'Run the show', name: 'Phone remote', note: 'Run the show from a phone. Big targets, PIN-gated when REMOTE_PIN is set.' },
] as const;

/** Every IPv4 the desk is reachable on, so the remote can print a real URL. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export interface ServerOpts {
  bus: EventBus;
  media: MediaLibrary;
  root: string;
  port: number;
  host: string;
  /** Absent when ffmpeg isn't installed. Everything else still runs. */
  recorder?: Recorder | null;
  clips?: ClipStore | null;
  publish?: PublishQueue | null;
  config?: Config | null;
  /** Absent unless the bridge was started with --cheesy. */
  cheesy?: CheesyAdapter | null;
  cues?: CueEngine | null;
  obs?: ObsClient | null;
  arcade?: ArcadeStore | null;
  trivia?: TriviaStore | null;
  /** LAN-reachable base URL, e.g. "http://10.0.100.23:8720", for QR codes. */
  lanBase?: string | null;
}

export function startServer(opts: ServerOpts) {
  const { bus, media, root, port, host, recorder = null, clips = null,
          publish = null, config = null, cheesy = null, cues = null, obs = null,
          arcade = null, trivia = null, lanBase = null } = opts;

  /**
   * Write the question bank back to `data/trivia.json`.
   *
   * Same atomic write the publish queue uses: a torn bank file after a power
   * cut at a venue would lose the whole set. Returns its argument so the
   * endpoints can save and respond in one expression.
   */
  async function saveBank<T>(result: T): Promise<T> {
    if (!trivia) return result;
    const file = join(root, 'data', 'trivia.json');
    // Strip the transient `live` flag; the file is a plain question array.
    const bank = trivia.bank().map(({ live, ...q }) => q);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(bank, null, 2));
      await rename(tmp, file);
    } catch (err) {
      // The edit is already live in memory; losing the file is not worth
      // failing the request the host just made mid-show.
      console.warn('[trivia] could not save the bank:', (err as Error).message);
    }
    return result;
  }

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

  /**
   * The shared event PIN, from REMOTE_PIN.
   *
   * Unset means the desk is wide open, which is right for a laptop on a
   * kitchen table in March and wrong for a venue. Startup warns when it is
   * missing, so nobody discovers it at the event.
   */
  const REMOTE_PIN = process.env['REMOTE_PIN'] ?? '';

  /**
   * One session token per process, handed out on a correct PIN.
   *
   * Regenerated on restart, which signs everyone out. That is the right
   * trade: the alternative is persisting a secret to disk on a machine that
   * gets passed between volunteers all weekend.
   */
  const SESSION = randomUUID();
  const AUTH_COOKIE = 'desk_auth';

  const isAuthed = (req: IncomingMessage): boolean =>
    !REMOTE_PIN || cookie(req.headers.cookie, AUTH_COOKIE) === SESSION;

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // ---- access control -------------------------------------------------
      // Sign in. The PIN is only ever read from a POST body: putting it in a
      // query string would write it into the server log and the browser
      // history, on a machine several volunteers share.
      if (path === '/api/auth' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
          { pin?: string };
        const ok = !!REMOTE_PIN && safeEqual(String(body.pin ?? ''), REMOTE_PIN);
        if (!ok) {
          console.warn('[auth] rejected PIN attempt');
          return json(res, 401, { error: 'That PIN was not accepted.' });
        }
        res.setHeader('Set-Cookie',
          `${AUTH_COOKIE}=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=57600`);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/auth/status') {
        return json(res, 200, { required: !!REMOTE_PIN, authed: isAuthed(req) });
      }

      if (needsAuth({ method: req.method ?? 'GET', path }) && !isAuthed(req)) {
        // A page gets the sign-in screen, so an operator opening a bookmark
        // lands somewhere useful. An API call gets a plain 401, because a
        // fetch can do nothing with a login page.
        if (path.startsWith('/s/')) {
          res.writeHead(302, {
            Location: `/signin?next=${encodeURIComponent(url.pathname + url.search)}`,
          });
          return res.end();
        }
        return json(res, 401, { error: 'PIN required' });
      }

      // Answered here so it can never fall through to a handler that only
      // matches on path. Every route below dispatches on `path`, and most do
      // not check the verb, so an unanswered OPTIONS would run the GET body.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS' });
        return res.end();
      }

      if (path === '/signin') {
        if (await sendFile(res, join(root, 'surfaces', '_shared', 'signin.html'))) return;
        res.writeHead(404).end('No sign-in page');
        return;
      }

      // ---- API ----------------------------------------------------------
      if (path === '/api/state') return json(res, 200, bus.state);
      // The LAN-reachable base URL: what phone-facing QR codes must encode
      // (a surface's own location.host may be localhost on the desk box).
      // Open, because every QR code and every pit monitor needs it, and it
      // discloses only what the network already shows.
      if (path === '/api/urls') {
        return json(res, 200, {
          base: lanBase,
          fieldStream: config?.kiosk?.fieldStreamUrl ?? '',
        });
      }

      // Lets the remote show a PIN prompt only when one is actually required.
      // Never reveals the PIN itself.
      if (path === '/api/remote') {
        return json(res, 200, {
          needsPin: !!process.env['REMOTE_PIN'],
          addresses: lanAddresses(),
          port,
        });
      }
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
      // the publish queue for match videos: same operation, different bounds.
      if (path === '/api/clips' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available: ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as {
            sourceId?: string; fromMs?: number; toMs?: number;
            ranges?: Range[]; label?: string; speed?: number;
          };
          if (!body.sourceId) return json(res, 400, { error: 'sourceId is required' });

          const ranges = body.ranges?.length
            ? body.ranges
            : (body.fromMs != null && body.toMs != null ? [{ fromMs: body.fromMs, toMs: body.toMs }] : null);
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
       * score reveal, skipping however long the referees spent on fouls.
       */
      if (path === '/api/clips/match' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available: ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as
            { sourceId?: string } | null;
          const st = bus.state;
          const startedAt = st.matchStartedAt ?? bus.lastMatchStartedAt;
          if (startedAt == null) return json(res, 409, { error: 'No match has started yet.' });

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

      // ---- crowd trivia ----------------------------------------------------
      // The answer to an open question never appears in any of these payloads;
      // scoring is entirely server-side. See trivia/store.ts.
      if (path === '/api/trivia') return json(res, 200, trivia?.snapshot() ?? null);

      // The bank with answers, for the host console's editor only. The phone
      // view is served by /api/trivia/play, which never carries an unrevealed
      // answer, so nothing here widens what a player can see.
      if (path === '/api/trivia/bank') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        return json(res, 200, trivia.bank());
      }

      if (path === '/api/trivia/play') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        return json(res, 200, trivia.playView(url.searchParams.get('player') ?? undefined));
      }

      if (path.startsWith('/api/trivia/') && req.method === 'POST') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        const action = path.slice('/api/trivia/'.length);
        try {
          const raw = await readBody(req, 16 * 1024);
          const body = raw.length ? JSON.parse(raw.toString('utf8')) as Record<string, unknown> : {};
          switch (action) {
            case 'join':
              return json(res, 200, trivia.join(String(body['name'] ?? ''), Number(body['team']) || undefined));
            case 'answer':
              return json(res, 200, trivia.answer(String(body['playerId'] ?? ''), Number(body['choice'])));
            case 'open':   return json(res, 200, trivia.open(Number(body['seconds']) || 20));
            case 'pick':   return json(res, 200, trivia.pick());
            // Editing the bank. Every one of these persists, because a host
            // who fixes a typo between matches should not lose it to a
            // restart, and restarts happen at events.
            case 'question/add':
              return json(res, 200, await saveBank(trivia.addQuestion(body)));
            case 'question/edit':
              return json(res, 200,
                await saveBank(trivia.editQuestion(Number(body['index']), body)));
            case 'question/remove':
              return json(res, 200, await saveBank(trivia.removeQuestion(Number(body['index']))));
            case 'question/move':
              return json(res, 200, await saveBank(
                trivia.moveQuestion(Number(body['index']), Number(body['delta']) || 0)));
            case 'reveal': return json(res, 200, trivia.reveal());
            case 'next':   return json(res, 200, trivia.next());
            case 'reset':  return json(res, 200, trivia.reset(body['hard'] === true));
            default: return json(res, 404, { error: `Unknown trivia action "${action}"` });
          }
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
          // Manual always wins, firing regardless of the autopilot setting.
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
      // Never returns a credential, only whether each one is present.
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
              item ?? { error: 'Nothing to queue: no match has started, or it is already queued.' });
          }
          if (action === 'release') {
            return json(res, 200, { released: await publish.release() });
          }
          // The parts of the day that are not matches: alliance selection, the
          // awards ceremony, a single award. The operator marks the bounds,
          // because nothing on the bus knows when a ceremony started.
          if (action === 'segment') {
            const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as {
              segment?: string; fromMs?: number; toMs?: number; note?: string; sourceId?: string;
            };
            if (!body.segment || body.fromMs == null || body.toMs == null) {
              return json(res, 400, { error: 'segment, fromMs and toMs are required' });
            }
            return json(res, 200, await publish.queueSegment({
              segment: body.segment,
              fromMs: body.fromMs,
              toMs: body.toMs,
              note: body.note,
              sourceId: body.sourceId,
            }));
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

      /**
       * Day-VOD chapters, as text to paste into a YouTube description.
       *
       * `startedAt` is when the recording began, which only the operator
       * knows: the stream starts before the desk does, and often before the
       * first match of the day is even loaded. Defaults to the first event we
       * still hold, which is right when the desk was started with the stream.
       */
      if (path === '/api/chapters') {
        const startedAt = Number(url.searchParams.get('startedAt'))
          || bus.recent[0]?.ts || Date.now();
        const list = chaptersFrom(bus.recent, startedAt, {
          openingTitle: url.searchParams.get('title') || undefined,
        });
        const text = chapterText(list);
        return json(res, 200, {
          startedAt,
          chapters: list,
          text,
          // An honest empty: YouTube silently ignores a list this short, so
          // saying "not enough yet" beats handing over something inert.
          usable: text !== '',
        });
      }

      if (path === '/api/markers') {
        const since = Number(url.searchParams.get('since') || 0)
          || (bus.lastMatchStartedAt ?? Date.now() - 20 * 60_000) - 60_000;
        return json(res, 200, markersSince(bus, since));
      }

      // Grab a frame and hand it to the telestrator as its backdrop.
      if (path === '/api/frame' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available: ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as
            { sourceId?: string; atMs?: number; analyst?: string; send?: boolean };
          if (body.atMs == null) return json(res, 400, { error: 'atMs is required' });

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
          // Reject anything that isn't actually a PNG, since the byte we serve
          // back as image/png must be one.
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
    const groups = [...new Set(SURFACES.map(s => s.group))];
    const sections = groups.map(g =>
      `<h2>${g}</h2>` + SURFACES.filter(s => s.group === g).map(s =>
        `<a class="row" href="/s/${s.id}"><b>${s.name}</b><code>/s/${s.id}</code><i>${s.note}</i></a>`,
      ).join('')).join('');
    const html = `<!doctype html><html lang="en" data-surface="console"><head><meta charset="utf-8">
<title>CalGames 2026 Content Desk</title>
<link rel="stylesheet" href="/theme/tokens.css">
<link rel="stylesheet" href="/shared/fonts.css">
<style>
body{padding:48px;max-width:860px;margin:0 auto;font-size:var(--font-ui-body)}
h1{font-size:38px;font-variation-settings:"wdth" 118;margin:0 0 4px}
p.sub{color:var(--text-dim);margin:0 0 26px}
h2{font-family:var(--font-cond);font-weight:700;font-size:13px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--accent);margin:30px 0 10px}
.row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:16px 20px;
  margin-bottom:10px;background:var(--surface-raised);text-decoration:none;color:var(--text);
  clip-path:var(--chamfer);--ch:12px;transition:background var(--dur-tap) linear}
.row:hover{background:var(--btn-hover)}
.row:focus-visible{outline:3px solid var(--focus-ring)}
.row b{font-size:19px}
.row code{font-family:var(--font-mono);color:var(--accent);font-size:13px}
.row i{grid-column:1/-1;color:var(--text-dim);font-style:normal;font-size:13px}
</style></head><body>
<h1>CalGames 2026 Content Desk</h1>
<p class="sub">Core is running. Open a surface below, or point an OBS Browser Source at it.</p>
${sections}</body></html>`;
    res.writeHead(200, { 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-store' });
    res.end(html);
  }

  // ---- WebSocket fan-out -------------------------------------------------
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const send = (ws: WebSocket, msg: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  /**
   * Who may write on the socket.
   *
   * The read path is always open, because overlays and pit TVs must never need
   * a credential and can only observe. Anything that CHANGES the show (emit,
   * relay) requires the PIN once one is set. That matters the moment a phone
   * can reach the desk: without it, anyone on the same Wi-Fi can take the
   * broadcast.
   */
  const authed = new WeakSet<WebSocket>();
  const mayWrite = (ws: WebSocket): boolean => !REMOTE_PIN || authed.has(ws);

  wss.on('connection', (ws, req) => {
    const who = new URL(req.url ?? '/', 'http://x').searchParams.get('surface') ?? 'anon';
    // A console that signed in over HTTP arrives with the session cookie, so
    // it is never asked twice. The phone remote, which can be opened straight
    // to its own page, still authenticates over the socket below.
    if (cookie(req.headers.cookie, AUTH_COOKIE) === SESSION) authed.add(ws);
    send(ws, { t: 'snapshot', state: bus.state, media: media.manifest, needsPin: !!REMOTE_PIN });

    ws.on('message', raw => {
      let msg: { t?: string; init?: EmitInit; channel?: string; data?: unknown; pin?: string };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }

      if (msg.t === 'auth') {
        // Constant-time-ish: compare full strings, and never echo the PIN back.
        const ok = !!REMOTE_PIN && safeEqual(String(msg.pin ?? ''), REMOTE_PIN);
        if (ok) authed.add(ws);
        send(ws, { t: 'auth', ok });
        if (!ok) console.warn(`[ws:${who}] rejected PIN attempt`);
        return;
      }

      if ((msg.t === 'emit' || msg.t === 'relay') && !mayWrite(ws)) {
        send(ws, { t: 'denied', reason: 'PIN required' });
        return;
      }

      // Surfaces may inject events. Source is forced to 'manual', so a surface
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

    // Said at startup rather than left to be discovered. At a venue the desk
    // is reachable by every phone in the building, and the trivia QR code
    // puts its address on a projector in front of the whole gym.
    if (REMOTE_PIN) {
      console.log('[auth] control surfaces are PIN-gated; audience surfaces are open');
    } else {
      console.warn('[auth] NO PIN SET: anyone who can reach this desk can run the show.');
      console.warn('[auth] Set REMOTE_PIN before putting it on the venue network.');
    }
  });

  return {
    close: () => { unsubscribe(); wss.close(); http.close(); },
    broadcastCount: () => wss.clients.size,
  };
}
