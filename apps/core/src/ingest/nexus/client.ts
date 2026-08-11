/**
 * Minimal FRC Nexus client. GET-only.
 *
 * Nexus (frc.nexus) is what the queuers at the event are actually typing into,
 * which makes it the only source that knows a match is being called BEFORE the
 * field knows. Cheesy Arena can tell us a match was loaded; Nexus can tell us
 * six teams were asked to start walking four minutes earlier, which is the
 * difference between "on deck" being a graphic and being useful.
 *
 * This talks to frc.nexus over the internet, not to the field network, so none
 * of the field-bridge safety machinery applies. It is GET-only anyway, because
 * this project does not write to other people's event systems.
 *
 * Nexus asks that anything using their data links back to frc.nexus. The
 * surfaces that show queue data carry that credit.
 */

export const NEXUS_BASE = 'https://frc.nexus/api/v1';

export interface NexusClientOpts {
  apiKey: string;
  eventKey: string;
  base?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/** One scheduled match as Nexus sees it. Every field is optional on the wire. */
export interface NexusMatch {
  label?: string;
  /** "Now queuing", "On deck", "On field", "Completed", ... free text. */
  status?: string;
  redTeams?: (string | null)[];
  blueTeams?: (string | null)[];
  times?: {
    estimatedQueueTime?: number;
    estimatedOnDeckTime?: number;
    estimatedOnFieldTime?: number;
    estimatedStartTime?: number;
    actualQueueTime?: number;
    actualOnDeckTime?: number;
    actualOnFieldTime?: number;
  };
}

export interface NexusAnnouncement {
  id?: string;
  announcement?: string;
  postedTime?: number;
}

export interface NexusEventStatus {
  eventKey?: string;
  /** Nexus recomputes on every request; the newest wins. */
  dataAsOfTime?: number;
  nowQueuing?: string | null;
  matches?: NexusMatch[];
  announcements?: NexusAnnouncement[];
  partsRequests?: unknown[];
}

export class NexusClient {
  #key: string;
  #event: string;
  #base: string;
  #fetch: typeof fetch;
  #lastRequestAt = 0;

  constructor(opts: NexusClientOpts) {
    this.#key = opts.apiKey;
    this.#event = opts.eventKey;
    this.#base = opts.base ?? NEXUS_BASE;
    this.#fetch = opts.fetchFn ?? fetch;
  }

  get eventKey(): string { return this.#event; }

  async #get<T>(path: string): Promise<T> {
    // Nexus does not publish a rate limit. A one-second floor costs nothing at
    // a 20s poll and stops a polling bug from turning into a ban mid-event.
    const since = Date.now() - this.#lastRequestAt;
    if (since < 1000) await new Promise(r => setTimeout(r, 1000 - since));
    this.#lastRequestAt = Date.now();

    const res = await this.#fetch(`${this.#base}${path}`, {
      method: 'GET',
      headers: { 'Nexus-Api-Key': this.#key },
      signal: AbortSignal.timeout(12_000),
    });

    if (res.status === 403) {
      throw new Error('Nexus refused the API key (403). Check it at frc.nexus/api, ' +
        'and that it has not been disabled.');
    }
    if (res.status === 404) {
      throw new Error(`Nexus has no event "${this.#event}". Check the event key, ` +
        'and that the event is registered on Nexus.');
    }
    if (!res.ok) throw new Error(`Nexus HTTP ${res.status}`);
    return await res.json() as T;
  }

  /**
   * Live queue status. Only meaningful for events actually using Nexus to
   * manage queuing: for anything else Nexus returns the schedule with no
   * useful timing, which is worse than nothing because it looks authoritative.
   */
  status(): Promise<NexusEventStatus> {
    return this.#get<NexusEventStatus>(`/event/${encodeURIComponent(this.#event)}`);
  }

  /** Team number -> pit address. Static for the weekend; fetched once. */
  pits(): Promise<{ pits?: Record<string, string> }> {
    return this.#get(`/event/${encodeURIComponent(this.#event)}/pits`);
  }
}
