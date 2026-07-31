/**
 * Configuration, including credentials.
 *
 * `config.json` is gitignored and never committed. `config.example.json` is
 * the template. Nothing in this file should ever be logged verbatim. See
 * `redacted()`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Config {
  event: {
    /** TBA event key, e.g. "2026cacg". Required for any TBA publishing. */
    key: string;
    /**
     * The event name as it appears in video titles, following the official
     * FIRST channel convention: "Qualification 1 - {name}".
     */
    name: string;
    /** Used in livestream titles: "{year} {name} - Day {n}". */
    year: number;
    /** Linked in every video description. Blank to omit the line. */
    resultsUrl: string;
  };
  /**
   * Bonus RP thresholds.
   *
   * Configuration rather than constants: off-season events move these, and
   * the 2026 REBUILT numbers were still being argued over while this was
   * built. They travel on the state snapshot, so changing one here changes
   * the reducer, every badge, and the talent view together.
   */
  game: {
    rpEnergizedFuel: number;
    rpSuperchargedFuel: number;
    rpTraversalTower: number;
  };
  /**
   * Screens shown on their own monitors, with no OBS in front of them.
   *
   * A pit TV opens /s/watch and gets the finished picture. The field feed can
   * be a YouTube live URL, an MJPEG stream off a capture box or IP camera, or
   * any video URL a browser plays natively. Blank is fine: the overlay then
   * draws on the CalGames backdrop instead of a black rectangle.
   */
  kiosk: {
    fieldStreamUrl: string;
  };
  publish: {
    /** Master switch. Nothing uploads while this is false. */
    enabled: boolean;
    /**
     * deferred: queue during the event, upload after the venue closes.
     * trickle:  upload during the event; no upload starts while a match is
     *           live, and there is no bandwidth cap beyond that.
     * live:     upload as soon as a video is cut.
     * Default is deferred: the live stream must never compete with an upload.
     */
    mode: 'deferred' | 'trickle' | 'live';
    /** Queue a match video automatically when the score is posted. */
    autoQueueMatches: boolean;
    /** Which recorded source to cut from. The program feed, normally. */
    sourceId: string;
    /** Uploaded unlisted, flipped to public only once TBA linking succeeds. */
    privacy: 'private' | 'unlisted' | 'public';
    publicAfterLink: boolean;
    playlists: { match: string; segment: string };
    /**
     * Closing lines of every description. FIRST's own videos end
     * "(c) 2026 FIRST Robotics Competition", theirs to claim. CalGames is a
     * WRRF off-season event, so the default credits WRRF instead.
     */
    credit: string;
    copyright: string;
  };
  // The Cheesy Arena bridge is deliberately NOT configured here. It is a
  // launch flag (`--cheesy`). It needs FTA sign-off, so switching it on should
  // be an explicit act at the point of use rather than something inherited
  // from a file copied between machines. See docs/10-field-bridge.md.
  /**
   * start.gg side-tournament bracket. Metadata only: round labels and
   * entrants for the arcade console's pre-fill; live scores stay
   * operator-authoritative (docs/05-arcade.md). Starts when both fields are
   * set; there is no field-safety concern here, so no launch flag.
   */
  startgg: {
    token: string;
    /** "tournament/calgames-2026-arcade/event/smash-singles" */
    eventSlug: string;
  };
  youtube: { clientId: string; clientSecret: string; refreshToken: string };
  tba: { authId: string; authSecret: string; readKey: string };
  stream: {
    /** Registered on TBA so the event appears on GameDay. */
    webcastUrl: string;
  };
}

export const DEFAULTS: Config = {
  event: { key: '', name: 'CalGames', year: 2026, resultsUrl: '' },
  game: { rpEnergizedFuel: 100, rpSuperchargedFuel: 360, rpTraversalTower: 50 },
  kiosk: { fieldStreamUrl: '' },
  publish: {
    enabled: false,
    mode: 'deferred',
    autoQueueMatches: true,
    sourceId: 'program',
    privacy: 'unlisted',
    publicAfterLink: true,
    playlists: { match: '', segment: '' },
    credit: 'Uploaded by the CalGames Content Desk',
    copyright: '(c) 2026 Western Region Robotics Forum',
  },
  startgg: { token: '', eventSlug: '' },
  youtube: { clientId: '', clientSecret: '', refreshToken: '' },
  tba: { authId: '', authSecret: '', readKey: '' },
  stream: { webcastUrl: '' },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-merge the user's config over the defaults, so a partial config.json is
 * valid and new settings pick up sensible values without anyone editing.
 * Keys starting with "//" are comments in the example file and merge
 * harmlessly.
 */
function merge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null || v === undefined) continue;
    out[k] = isPlainObject(base[k]) && isPlainObject(v) ? merge(base[k], v) : v;
  }
  return out;
}

export async function loadConfig(root: string): Promise<Config> {
  try {
    const raw = await readFile(join(root, 'config.json'), 'utf8');
    return merge(DEFAULTS, JSON.parse(raw)) as Config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First run on a fresh machine. Say so now, or the missing publish
      // credentials get discovered at upload time.
      console.log('[config] no config.json, using defaults. Copy config.example.json to configure publishing.');
    } else {
      console.warn(`[config] config.json could not be read (${(err as Error).message}), using defaults.`);
    }
    return structuredClone(DEFAULTS);
  }
}

/** Safe to log, and safe to send to a browser surface. */
export function redacted(cfg: Config): Record<string, unknown> {
  const has = (s: string): string => s ? 'set' : 'missing';
  return {
    event: cfg.event,
    publish: cfg.publish,
    stream: cfg.stream,
    youtube: { clientId: has(cfg.youtube.clientId), clientSecret: has(cfg.youtube.clientSecret), refreshToken: has(cfg.youtube.refreshToken) },
    tba: { authId: has(cfg.tba.authId), authSecret: has(cfg.tba.authSecret), readKey: has(cfg.tba.readKey) },
    startgg: { token: has(cfg.startgg.token), eventSlug: cfg.startgg.eventSlug },
  };
}

/** What's missing before publishing can actually work. */
export function publishReadiness(cfg: Config): { youtube: string[]; tba: string[] } {
  const youtube: string[] = [];
  if (!cfg.youtube.clientId) youtube.push('youtube.clientId');
  if (!cfg.youtube.clientSecret) youtube.push('youtube.clientSecret');
  if (!cfg.youtube.refreshToken) youtube.push('youtube.refreshToken');

  const tba: string[] = [];
  if (!cfg.event.key) tba.push('event.key');
  if (!cfg.tba.authId) tba.push('tba.authId');
  if (!cfg.tba.authSecret) tba.push('tba.authSecret');

  return { youtube, tba };
}
