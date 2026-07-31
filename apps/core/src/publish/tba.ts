/**
 * The Blue Alliance Trusted API v1 client. See docs/11-distribution.md.
 *
 * Scope rule, enforced structurally:
 *
 *   Cheesy Arena owns match data on TBA. We own video only.
 *
 * The match/ranking/award endpoints require the FULL dataset: a partial write
 * doesn't merely conflict, it DELETES everything not included. Cheesy Arena
 * publishes those natively, so calling them from here would silently destroy
 * the event's results. Hence a hard path allowlist rather than a convention.
 *
 * info/update is on the allowlist for one reason: the Trusted API has no
 * webcast endpoint, the webcast list rides on info/update, and the handler
 * only touches the keys it is sent. This client only ever sends `webcasts`.
 */

import { createHash } from 'node:crypto';

const BASE = 'https://www.thebluealliance.com';
const PREFIX = '/api/trusted/v1';

/**
 * The only three paths this client may ever request. Anything else throws
 * before a request is built. These are checked against TBA's actual route
 * table (py3, trusted_api_main.py): earlier revisions listed webcasts/update
 * and match_videos/delete, which do not exist and would 404 upstream.
 */
const ALLOWED = [
  'match_videos/add',
  'media/add',
  'info/update',
] as const;

export type AllowedOp = typeof ALLOWED[number];

/**
 * The guard, exported so it can be tested directly rather than through the
 * client. Throws on anything outside the video/webcast allowlist.
 */
export function assertAllowed(op: string): asserts op is AllowedOp {
  if (!(ALLOWED as readonly string[]).includes(op)) {
    throw new Error(
      `Refusing to call TBA "${op}". Only ${ALLOWED.join(', ')} are permitted. ` +
      `Cheesy Arena owns match data on TBA, and the match/ranking/award endpoints ` +
      `require the full dataset, so a partial write would delete everything not included.`,
    );
  }
}

export interface TbaAuth { authId: string; authSecret: string }

/**
 * X-TBA-Auth-Sig = md5(authSecret + requestPath + requestBody)
 *
 * The signature covers the path AND the exact body bytes, so the body must be
 * serialized once and both signed and sent; serialize twice and you get
 * intermittent 401s that look like a credentials problem and aren't.
 */
export function signature(authSecret: string, path: string, body: string): string {
  return createHash('md5').update(authSecret + path + body).digest('hex');
}

export class TbaClient {
  #auth: TbaAuth;
  #eventKey: string;

  constructor(auth: TbaAuth, eventKey: string) {
    this.#auth = auth;
    this.#eventKey = eventKey;
  }

  get configured(): boolean {
    return !!(this.#auth.authId && this.#auth.authSecret && this.#eventKey);
  }

  #path(op: AllowedOp): string {
    assertAllowed(op);
    return `${PREFIX}/event/${this.#eventKey}/${op}`;
  }

  async #send(op: AllowedOp, payload: unknown): Promise<unknown> {
    if (!this.configured) throw new Error('TBA credentials are not configured (see config.json).');

    const path = this.#path(op);
    // Serialize exactly once (this string is both signed and sent).
    const body = JSON.stringify(payload);

    const res = await fetch(BASE + path, {
      // Every Trusted API write is POST. The API has no PATCH or DELETE.
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TBA-Auth-Id': this.#auth.authId,
        'X-TBA-Auth-Sig': signature(this.#auth.authSecret, path, body),
      },
      body,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`TBA ${op} failed (${res.status}): ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Link an uploaded video to its match. `{ "qm42": "<youtube id>" }` */
  addMatchVideo(matchKey: string, youtubeId: string): Promise<unknown> {
    return this.#send('match_videos/add', { [matchKey]: youtubeId });
  }

  /**
   * Event-level video: ceremony segments, between-match content.
   *
   * The API parses this body as a bare list of YouTube id strings. An object
   * shape ({type, foreign_key}) fails its validation with a 400, which burned
   * every attempt and left segment videos unlisted forever.
   */
  addEventMedia(youtubeId: string): Promise<unknown> {
    return this.#send('media/add', [youtubeId]);
  }

  /**
   * Register the live stream so the event shows up on TBA GameDay.
   *
   * The webcast list REPLACES whatever TBA has stored, it is not a delta:
   * send every webcast the event should show, and an empty list takes them
   * all down at end of day.
   */
  setWebcasts(urls: string[]): Promise<unknown> {
    return this.#send('info/update', { webcasts: urls.map(url => ({ url })) });
  }
}

/**
 * Match keys live in ./naming.ts alongside the title formatting. One place
 * translates a field-management display name into official naming and its TBA
 * key, so the two can never disagree.
 */
export { identify } from './naming.ts';
