/**
 * The Blue Alliance Trusted API v1 client. See docs/11-distribution.md.
 *
 * Scope rule, enforced structurally:
 *
 *   Cheesy Arena owns match data on TBA. We own video only.
 *
 * The match/ranking/award endpoints require the FULL dataset — a partial write
 * doesn't merely conflict, it DELETES everything not included. Cheesy Arena
 * publishes those natively, so calling them from here would silently destroy
 * the event's results. Hence a hard path allowlist rather than a convention.
 */

import { createHash } from 'node:crypto';

const BASE = 'https://www.thebluealliance.com';
const PREFIX = '/api/trusted/v1';

/**
 * The only four paths this client may ever request. Anything else throws
 * before a request is built.
 */
const ALLOWED = [
  'match_videos/add',
  'match_videos/delete',
  'media/add',
  'webcasts/update',
] as const;

export type AllowedOp = typeof ALLOWED[number];

/**
 * The guard, exported so it can be tested directly rather than through the
 * client. Throws on anything outside the video/webcast allowlist.
 */
export function assertAllowed(op: string): asserts op is AllowedOp {
  if (!(ALLOWED as readonly string[]).includes(op)) {
    throw new Error(
      `Refusing to call TBA "${op}". Only ${ALLOWED.join(', ')} are permitted — ` +
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
 * serialised once and both signed and sent — serialise twice and you get
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

  async #send(op: AllowedOp, payload: unknown, method: 'POST' | 'PATCH' | 'DELETE' = 'POST'): Promise<unknown> {
    if (!this.configured) throw new Error('TBA credentials are not configured (see config.json).');

    const path = this.#path(op);
    // Serialise exactly once — this string is both signed and sent.
    const body = JSON.stringify(payload);

    const res = await fetch(BASE + path, {
      method,
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

  /** Event-level video: analysis segments, between-match content. */
  addEventMedia(youtubeId: string): Promise<unknown> {
    return this.#send('media/add', [{ type: 'youtube', foreign_key: youtubeId }]);
  }

  /** Register the live stream so the event shows up on TBA GameDay. */
  setWebcast(url: string): Promise<unknown> {
    return this.#send('webcasts/update', { add: [{ type: 'youtube', channel: url }] }, 'PATCH');
  }

  removeWebcast(url: string): Promise<unknown> {
    return this.#send('webcasts/update', { remove: [{ type: 'youtube', channel: url }] }, 'DELETE');
  }
}

/**
 * Match keys live in ./naming.ts alongside the title formatting — one place
 * translates a field-management display name into official naming and its TBA
 * key, so the two can never disagree.
 */
export { identify } from './naming.ts';
