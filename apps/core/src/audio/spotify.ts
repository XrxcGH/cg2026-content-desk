/**
 * Spotify as the house playlist, driven over Spotify Connect.
 *
 * The desk does NOT play the audio. The Spotify desktop app on the music
 * machine plays it, exactly as it did before this existed, and this file only
 * sends it transport commands. That split is deliberate and load-bearing:
 *
 *   - The audio path does not change, so the two-bus guarantee does not change.
 *     The machine that was wired to the house bus is still the machine making
 *     the sound. Nothing new is patched anywhere.
 *   - Spotify's own app handles login, device output, and, for a Premium
 *     account with the playlist downloaded, offline playback. When the venue
 *     uplink dies, the music keeps playing; we simply lose the ability to
 *     change it, which is a much better failure than silence.
 *   - Nothing here needs a browser, an SDK, or DRM playback in a page.
 *
 * The whole surface is transport control. Anything more than play, pause, skip,
 * volume, and pick-a-playlist is something an operator can do in Spotify's own
 * app, and mid-show they will not want to.
 *
 * Every method throws on failure and the store catches. A dead music service
 * must degrade to "the walk-up clips still work", never to a broken desk.
 */

import type { MusicController, MusicStatus, NowPlaying } from './store.ts';

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/**
 * What the refresh token has to have been minted with. Kept here next to the
 * calls that need them so a 403 has one obvious place to look.
 *
 *   user-read-playback-state     what is playing, and which device is active
 *   user-read-currently-playing  the current track. NOT covered by the above:
 *                                the two read endpoints take different scopes,
 *                                which is the kind of asymmetry you find out
 *                                about from a 403 at the worst moment
 *   user-modify-playback-state   play, pause, skip, volume
 *   playlist-read-private        list the event playlist when it is not public
 */
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

export interface SpotifyConfig {
  clientId: string;
  refreshToken: string;
  deviceName: string;
  playlistUri: string;
}

interface Device { id: string; name: string; is_active: boolean; volume_percent: number | null }

export class SpotifyController implements MusicController {
  readonly name = 'Spotify';
  #clientId: string;
  #refresh: string;
  #deviceName: string;

  #token = '';
  #tokenExpires = 0;
  /** Resolved from deviceName, re-resolved whenever it stops working. */
  #deviceId: string | null = null;

  constructor(cfg: SpotifyConfig) {
    this.#clientId = cfg.clientId;
    this.#refresh = cfg.refreshToken;
    this.#deviceName = cfg.deviceName;
  }

  get linked(): boolean { return !!this.#clientId && !!this.#refresh; }

  // ---- auth --------------------------------------------------------------

  /**
   * Access tokens last an hour. Refreshed 60s early so a token never expires
   * between the check and the call, which is the kind of race that only ever
   * shows up during the one command that mattered.
   *
   * PKCE clients send no secret, and Spotify may hand back a NEW refresh token
   * on any refresh. Adopting it in memory keeps a long weekend working; the one
   * in config.json stays valid as the cold-start token.
   */
  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#tokenExpires) return this.#token;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.#refresh,
        client_id: this.#clientId,
      }),
    });
    const body = await res.json().catch(() => ({})) as {
      access_token?: string; expires_in?: number; refresh_token?: string;
      error?: string; error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new Error(body.error_description ?? body.error ??
        `token refresh failed (${res.status}). Re-run npm run auth:spotify.`);
    }
    this.#token = body.access_token;
    this.#tokenExpires = Date.now() + ((body.expires_in ?? 3600) - 60) * 1000;
    if (body.refresh_token) this.#refresh = body.refresh_token;
    return this.#token;
  }

  // ---- requests ----------------------------------------------------------

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.#accessToken();
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(6000),
    });

    // 204 is the normal answer to every transport command, and to "nothing is
    // playing" on the state read.
    if (res.status === 204) return null;

    if (res.status === 429) {
      // Spotify's own guidance is to honour Retry-After rather than guess. We
      // do not sleep and retry here: a mid-show command that is a few seconds
      // late is worse than one that failed and said so.
      const wait = res.headers.get('Retry-After') ?? '?';
      throw new Error(`rate limited by Spotify, retry after ${wait}s`);
    }
    if (res.status === 404) {
      // The specific and very common one: no device is active, because the
      // Spotify app on the music machine has been closed or logged out.
      this.#deviceId = null;
      throw new Error('no active Spotify device. Open Spotify on the music ' +
        'machine and play something once, so it registers as a device.');
    }
    if (res.status === 403) {
      throw new Error('Spotify refused that (403). Remote control needs a ' +
        'Premium account on the device being driven.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Spotify ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * The device to drive, by name.
   *
   * By name rather than by id because ids change whenever the Spotify app
   * restarts, and a volunteer can read a name off a screen and type it into
   * config.json. With no name configured we drive whatever is active, which is
   * right for the common case of exactly one machine running Spotify.
   */
  async #device(): Promise<string | null> {
    if (this.#deviceId) return this.#deviceId;
    if (!this.#deviceName) return null;
    const body = await this.#call('GET', '/me/player/devices') as { devices?: Device[] } | null;
    const want = this.#deviceName.trim().toLowerCase();
    const found = (body?.devices ?? []).find(d => d.name.trim().toLowerCase() === want);
    if (!found) {
      const names = (body?.devices ?? []).map(d => d.name).join(', ') || 'none';
      throw new Error(`no Spotify device called "${this.#deviceName}". Visible now: ${names}.`);
    }
    this.#deviceId = found.id;
    return found.id;
  }

  /** `?device_id=` on the transport calls, when we know which one we mean. */
  async #target(): Promise<string> {
    const id = await this.#device();
    return id ? `?device_id=${encodeURIComponent(id)}` : '';
  }

  // ---- MusicController ---------------------------------------------------

  async status(): Promise<MusicStatus> {
    const body = await this.#call('GET', '/me/player') as {
      is_playing?: boolean;
      device?: Device;
      progress_ms?: number;
      context?: { uri?: string };
      item?: {
        name?: string; duration_ms?: number;
        artists?: { name?: string }[];
        album?: { name?: string; images?: { url?: string; width?: number }[] };
      };
    } | null;

    if (!body) {
      return { playing: false, device: null, volume: null, now: null, context: null };
    }

    const item = body.item;
    let now: NowPlaying | null = null;
    if (item) {
      // Smallest image that is still recognizable: this is a 78px tile on the
      // house player and a thumbnail on the desk, and the desk is on venue
      // wifi. Spotify returns them largest first.
      const images = item.album?.images ?? [];
      const art = images.length ? (images[images.length - 1]?.url ?? null) : null;
      now = {
        title: item.name ?? '',
        artist: (item.artists ?? []).map(a => a.name ?? '').filter(Boolean).join(', '),
        art,
        durationMs: item.duration_ms ?? 0,
        progressMs: body.progress_ms ?? 0,
        sampledAt: Date.now(),
      };
    }

    return {
      playing: body.is_playing === true,
      device: body.device?.name ?? null,
      volume: typeof body.device?.volume_percent === 'number' ? body.device.volume_percent : null,
      now,
      // The playlist name costs a second request, so the uri alone rides here
      // and the store shows the configured playlist's name from its own list.
      context: body.context?.uri ? { uri: body.context.uri, name: '' } : null,
    };
  }

  async play(opts?: { contextUri?: string }): Promise<void> {
    const target = await this.#target();
    // An empty body resumes whatever was loaded; context_uri starts a playlist.
    // Sending context_uri on a plain resume would restart the playlist from the
    // top, which sounds exactly like a mistake to a room that was mid-song.
    const body = opts?.contextUri ? { context_uri: opts.contextUri } : undefined;
    await this.#call('PUT', `/me/player/play${target}`, body);
  }

  async pause(): Promise<void> {
    await this.#call('PUT', `/me/player/pause${await this.#target()}`);
  }

  async next(): Promise<void> {
    await this.#call('POST', `/me/player/next${await this.#target()}`);
  }

  async previous(): Promise<void> {
    await this.#call('POST', `/me/player/previous${await this.#target()}`);
  }

  async setVolume(percent: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(percent)));
    const id = await this.#device();
    const q = `?volume_percent=${v}` + (id ? `&device_id=${encodeURIComponent(id)}` : '');
    await this.#call('PUT', `/me/player/volume${q}`);
  }

  async playlists(): Promise<{ uri: string; name: string }[]> {
    const body = await this.#call('GET', '/me/playlists?limit=50') as {
      items?: { uri?: string; name?: string }[];
    } | null;
    return (body?.items ?? [])
      .filter(p => !!p.uri)
      .map(p => ({ uri: p.uri!, name: p.name ?? p.uri! }));
  }
}

/** Null when it is not configured, which is a supported way to run: the clip
 *  player needs no service at all. */
export function createSpotify(cfg: SpotifyConfig): SpotifyController | null {
  if (!cfg.clientId || !cfg.refreshToken) return null;
  return new SpotifyController(cfg);
}
