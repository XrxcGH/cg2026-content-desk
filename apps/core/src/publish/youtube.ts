/**
 * YouTube Data API v3 upload client. See docs/11-distribution.md.
 *
 * Resumable uploads, because a venue uplink at a high-school gym will drop
 * mid-file and restarting a 2GB match video from byte zero is not acceptable.
 *
 * Quota note: videos.insert cost dropped from ~1600 units to ~100 in December
 * 2025, so the default 10,000/day project quota supports ~100 uploads a day
 * rather than six. The limit that actually bites is the per-CHANNEL daily
 * upload cap, which is separate and low for unverified channels — use an
 * established, verified channel.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API_URL = 'https://www.googleapis.com/youtube/v3';

export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube';

export interface YouTubeAuth { clientId: string; clientSecret: string; refreshToken: string }

export interface VideoMeta {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus: 'private' | 'unlisted' | 'public';
  /** 28 = Science & Technology. */
  categoryId?: string;
}

export class YouTubeClient {
  #auth: YouTubeAuth;
  #token: string | null = null;
  #tokenExpiry = 0;

  constructor(auth: YouTubeAuth) { this.#auth = auth; }

  get configured(): boolean {
    return !!(this.#auth.clientId && this.#auth.clientSecret && this.#auth.refreshToken);
  }

  /** Access tokens last an hour; refresh a minute early to avoid a race. */
  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#tokenExpiry - 60_000) return this.#token;
    if (!this.configured) throw new Error('YouTube credentials are not configured (see config.json).');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.#auth.clientId,
        client_secret: this.#auth.clientSecret,
        refresh_token: this.#auth.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const body = await res.json() as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`YouTube token refresh failed: ${body.error_description ?? body.error ?? res.status}`);
    }
    this.#token = body.access_token;
    this.#tokenExpiry = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.#token;
  }

  /** Begin a resumable session. Returns the URL to PUT bytes to. */
  async #startSession(meta: VideoMeta, size: number): Promise<string> {
    const token = await this.#accessToken();
    const res = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title: meta.title.slice(0, 100),          // hard API limit
          description: meta.description.slice(0, 5000),
          tags: meta.tags?.slice(0, 30),
          categoryId: meta.categoryId ?? '28',
        },
        status: { privacyStatus: meta.privacyStatus, selfDeclaredMadeForKids: false },
      }),
    });

    const location = res.headers.get('location');
    if (!res.ok || !location) {
      throw new Error(`YouTube upload session failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return location;
  }

  /** Ask how many bytes the server already has, so we resume rather than restart. */
  async #committed(sessionUrl: string, size: number): Promise<number> {
    const res = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${size}` },
    });
    if (res.status === 200 || res.status === 201) return size;
    if (res.status === 308) {
      const range = res.headers.get('range');           // e.g. "bytes=0-12345"
      return range ? Number(range.split('-')[1]) + 1 : 0;
    }
    throw new Error(`Could not query upload progress (${res.status})`);
  }

  /**
   * Upload a file, resuming across interruptions. Returns the video id.
   * `onProgress` is fed committed-byte counts so the desk can show something
   * honest while a 40-minute upload runs.
   */
  async upload(
    file: string, meta: VideoMeta,
    opts: { sessionUrl?: string; onProgress?: (sent: number, total: number) => void;
            onSession?: (url: string) => void; attempts?: number } = {},
  ): Promise<string> {
    const size = (await stat(file)).size;
    let sessionUrl = opts.sessionUrl ?? await this.#startSession(meta, size);
    opts.onSession?.(sessionUrl);

    const maxAttempts = opts.attempts ?? 5;
    let offset = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) offset = await this.#committed(sessionUrl, size);
        if (offset >= size) break;

        const stream = createReadStream(file, { start: offset });
        const res = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(size - offset),
            'Content-Range': `bytes ${offset}-${size - 1}/${size}`,
            'Content-Type': 'video/mp4',
          },
          body: Readable.toWeb(stream) as ReadableStream,
          // Node requires this for a streaming request body.
          duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        if (res.status === 200 || res.status === 201) {
          const body = await res.json() as { id?: string };
          if (!body.id) throw new Error('Upload finished but YouTube returned no video id');
          opts.onProgress?.(size, size);
          return body.id;
        }
        if (res.status === 308) {                  // more bytes wanted
          offset = await this.#committed(sessionUrl, size);
          opts.onProgress?.(offset, size);
          attempt--;                               // progress isn't a failure
          continue;
        }
        // 404 means the session expired — start a fresh one and try again.
        if (res.status === 404) {
          sessionUrl = await this.#startSession(meta, size);
          opts.onSession?.(sessionUrl);
          offset = 0;
          continue;
        }
        throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        // Backoff, then resume from whatever the server actually has.
        await new Promise(r => setTimeout(r, Math.min(30_000, 2 ** attempt * 1000)));
      }
    }

    throw new Error('Upload did not complete');
  }

  /** Flip privacy — used to publish only once TBA linking has succeeded. */
  async setPrivacy(videoId: string, privacyStatus: VideoMeta['privacyStatus']): Promise<void> {
    const token = await this.#accessToken();
    const res = await fetch(`${API_URL}/videos?part=status`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: videoId, status: { privacyStatus } }),
    });
    if (!res.ok) throw new Error(`Privacy update failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  async addToPlaylist(videoId: string, playlistId: string): Promise<void> {
    if (!playlistId) return;
    const token = await this.#accessToken();
    const res = await fetch(`${API_URL}/playlistItems?part=snippet`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
      }),
    });
    // Non-fatal: a video in the wrong playlist still beats no video.
    if (!res.ok) console.warn(`[youtube] playlist insert failed (${res.status})`);
  }
}

export const watchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;
