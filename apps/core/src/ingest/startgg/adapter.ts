/**
 * start.gg -> arcade bracket adapter. METADATA ONLY, by design.
 *
 * What comes from start.gg: round labels, entrant names, seeds, coarse set
 * state, enough for the console to pre-fill the next set with one click and
 * for "up next" to be right.
 *
 * What never comes from start.gg: the live score. start.gg reflects whatever
 * the TO has typed in, which lags reality by thirty seconds to a full round.
 * The operator at the console is the authority; this adapter cannot touch
 * `ArcadeStore`'s live set at all: it only calls `setBracket()`.
 */

import type { ArcadeStore } from '../../arcade/store.ts';
import type { ArcadePlayer, BracketSet } from '../../arcade/model.ts';
import { StartggClient } from './client.ts';

/** start.gg ActivityState (integers on the wire). */
const SET_STATE: Record<number, BracketSet['state']> = {
  1: 'upcoming',   // CREATED
  2: 'live',       // ACTIVE
  3: 'complete',   // COMPLETED
  // 4 READY_FOR_CALL, 6 CALLED, 7 QUEUED exist in the wild; anything not
  // complete or active maps to upcoming below.
};

/** Wire shapes, read defensively: a missing field degrades, never crashes. */
export interface StartggSetNode {
  id?: number | string;
  state?: number;
  fullRoundText?: string;
  slots?: ({ entrant?: { id?: number | string; name?: string; initialSeedNum?: number } | null } | null)[];
}

export interface EventSetsResponse {
  event?: {
    name?: string;
    sets?: {
      pageInfo?: { totalPages?: number };
      nodes?: (StartggSetNode | null)[];
    };
  } | null;
}

export const EVENT_SETS_QUERY = `
query EventSets($slug: String!, $page: Int!, $perPage: Int!) {
  event(slug: $slug) {
    name
    sets(page: $page, perPage: $perPage, sortType: CALL_ORDER) {
      pageInfo { totalPages }
      nodes {
        id
        state
        fullRoundText
        slots { entrant { id name initialSeedNum } }
      }
    }
  }
}`;

/**
 * "846 | Ana" or "Ana 846" -> team 846. Smash entrants carry their sponsor
 * prefix in the name, and FRC entrants register with their team number in that
 * slot; that convention is the whole crossover. Conservative: only a 1-5
 * digit pure number in the prefix/suffix position reads as a team.
 */
export function parseEntrant(raw: string, id: string): ArcadePlayer {
  const name = raw.trim();
  const prefixed = /^(\d{1,5})\s*[|\-·]\s*(.+)$/.exec(name);
  if (prefixed) return { id, name: prefixed[2]!.trim(), team: Number(prefixed[1]) };
  const suffixed = /^(.+?)\s+(\d{1,5})$/.exec(name);
  if (suffixed) return { id, name: suffixed[1]!.trim(), team: Number(suffixed[2]) };
  return { id, name };
}

/** Pure, so the mapping is testable against realistic fixtures. */
export function mapSets(res: EventSetsResponse): BracketSet[] {
  return (res.event?.sets?.nodes ?? [])
    .filter((n): n is StartggSetNode => !!n)
    .map(n => {
      const players = (n.slots ?? [])
        .map((slot, i) => {
          const e = slot?.entrant;
          if (!e?.name) return null;   // slot not decided yet ("winner of ...")
          const p = parseEntrant(e.name, String(e.id ?? `e${i}`));
          return e.initialSeedNum ? { ...p, seed: e.initialSeedNum } : p;
        })
        .filter((p): p is ArcadePlayer => !!p);
      return {
        id: String(n.id ?? ''),
        round: n.fullRoundText ?? '',
        state: SET_STATE[n.state ?? 1] ?? 'upcoming',
        players,
      };
    })
    // A set with no decided entrants is noise for the console; drop it.
    .filter(s => s.players.length > 0);
}

export interface StartggAdapterOpts {
  arcade: ArcadeStore;
  token: string;
  /** "tournament/calgames-2026/event/smash-singles" */
  eventSlug: string;
  pollMs?: number;
  client?: StartggClient;
}

export class StartggAdapter {
  #arcade: ArcadeStore;
  #client: StartggClient;
  #eventSlug: string;
  #pollMs: number;
  #timer: NodeJS.Timeout | null = null;
  #lastError = '';

  constructor(opts: StartggAdapterOpts) {
    this.#arcade = opts.arcade;
    this.#client = opts.client ?? new StartggClient({ token: opts.token });
    this.#eventSlug = opts.eventSlug;
    // 60s: brackets change on the order of once a set, and start.gg's rate
    // limit is someone else's shared resource.
    this.#pollMs = opts.pollMs ?? 60_000;
  }

  start(): void {
    void this.poll();
    this.#timer = setInterval(() => void this.poll(), this.#pollMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * One poll. Failures log once per distinct message and retry next tick. A
   * missing bracket degrades the console's pre-fill, it does not stop the show.
   */
  async poll(): Promise<void> {
    try {
      const sets: BracketSet[] = [];
      // Two pages of 50 covers any realistic offseason side bracket; the cap
      // keeps a misconfigured slug from turning into a crawl.
      for (let page = 1; page <= 2; page++) {
        const res = await this.#client.query<EventSetsResponse>(
          EVENT_SETS_QUERY, { slug: this.#eventSlug, page, perPage: 50 });
        sets.push(...mapSets(res));
        if ((res.event?.sets?.pageInfo?.totalPages ?? 1) <= page) break;
      }
      this.#arcade.setBracket(sets);
      if (this.#lastError) {
        console.log('[startgg] recovered, bracket updated');
        this.#lastError = '';
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== this.#lastError) {
        console.warn(`[startgg] poll failed: ${msg}`);
        this.#lastError = msg;
      }
    }
  }
}
