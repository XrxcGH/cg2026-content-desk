/**
 * FRC Nexus -> desk adapter. Queue lifecycle and announcements.
 *
 * The desk already knows what the FIELD is doing. What it has never known is
 * what the QUEUERS are doing, and that is where the four minutes before a
 * match live: teams are called, they walk, they arrive on deck, and only then
 * does Cheesy Arena load the match. Nexus is what the queuers type into, so it
 * is the only source that can say "1678 is being called right now".
 *
 * Three things come out of this:
 *
 *   1. A real on-deck state. "Now queuing" is a fact from a human, not an
 *      inference from a schedule, so the side screens and the phone page can
 *      stop guessing.
 *   2. Better start estimates than the desk's own pace model, because Nexus's
 *      estimates come from a queuer who knows the field is being reset. The
 *      pace model stays as the fallback for when Nexus is absent or stale.
 *   3. Announcements. Nexus is where "lunch is at 12:15" and "please clear the
 *      pit aisle" get typed, and mirroring them onto the venue screens is free.
 *
 * Trust rules, because two sources disagreeing on air is worse than one being
 * absent:
 *
 *   - Nexus NEVER touches the live match. Scores, the clock, the hub, and
 *     which match is loaded are the field's, always.
 *   - Nexus times are `derived`, never `authoritative`. They are somebody's
 *     estimate, and the desk labels estimates.
 *   - A stale payload is dropped. Nexus recomputes on every request and its
 *     own docs warn that repeated requests can arrive out of order, so
 *     anything older than the newest `dataAsOfTime` seen is ignored.
 */

import type { EventBus } from '../../bus.ts';
import type { UpcomingMatch } from '../../types.ts';
import { NexusClient, type NexusEventStatus, type NexusMatch } from './client.ts';

export interface NexusAdapterOpts {
  bus: EventBus;
  apiKey: string;
  eventKey: string;
  /** Poll interval. 20s is well inside a queuer's own update rate. */
  pollMs?: number;
  client?: NexusClient;
}

/** Statuses Nexus uses that mean the match has not been played yet. */
const PENDING = /queuing|on deck|on field|scheduled|waiting/i;

const teamNumbers = (raw: (string | null)[] | undefined): number[] =>
  (raw ?? []).map(t => Number(t)).filter(n => Number.isInteger(n) && n > 0);

/** "Qualification 12" -> "Q12", so a side screen can fit it. */
export function shortLabel(label: string): string {
  const m = /^(practice|qualification|playoff|final|match)\s*(\d+)/i.exec(label.trim());
  if (!m) return label.trim().slice(0, 12);
  const kind = m[1]!.toLowerCase();
  const letter = kind === 'qualification' ? 'Q'
    : kind === 'practice' ? 'P'
      : kind === 'final' ? 'F' : 'M';
  return `${letter}${m[2]}`;
}

/**
 * The single best start estimate Nexus has for a match, preferring what has
 * actually happened over what is predicted to.
 */
export function bestStartEstimate(m: NexusMatch): number | null {
  const t = m.times ?? {};
  return t.estimatedStartTime ?? t.estimatedOnFieldTime ?? t.estimatedOnDeckTime
    ?? t.estimatedQueueTime ?? null;
}

export class NexusAdapter {
  #bus: EventBus;
  #client: NexusClient;
  #pollMs: number;
  #timer: NodeJS.Timeout | null = null;
  #lastData = 0;
  #seenAnnouncements = new Set<string>();
  #lastNowQueuing: string | null = null;
  #failures = 0;
  #started = false;

  constructor(opts: NexusAdapterOpts) {
    this.#bus = opts.bus;
    this.#client = opts.client ?? new NexusClient({
      apiKey: opts.apiKey, eventKey: opts.eventKey,
    });
    this.#pollMs = opts.pollMs ?? 20_000;
  }

  start(): void {
    if (this.#timer) return;
    void this.poll();
    this.#timer = setInterval(() => { void this.poll(); }, this.#pollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async poll(): Promise<void> {
    try {
      const status = await this.#client.status();
      this.#failures = 0;
      this.apply(status);
    } catch (err) {
      this.#failures++;
      // Loud once, then quiet: a venue whose uplink is down would otherwise
      // fill the log with the same line every twenty seconds all afternoon.
      if (this.#failures === 1 || this.#failures % 15 === 0) {
        console.warn(`[nexus] poll failed (${this.#failures}x): ${(err as Error).message}`);
      }
    }
  }

  /** Exposed for tests and for the webhook path, if one is ever added. */
  apply(status: NexusEventStatus): void {
    // Nexus warns that repeated requests can land out of order. The newest
    // dataAsOfTime wins, and an older payload is simply not news.
    const asOf = Number(status.dataAsOfTime ?? 0);
    if (asOf && asOf < this.#lastData) return;
    this.#lastData = asOf || this.#lastData;

    this.#applyQueue(status);
    this.#applyAnnouncements(status);
    this.#started = true;
  }

  #applyQueue(status: NexusEventStatus): void {
    const pending = (status.matches ?? []).filter(m => {
      const label = (m.label ?? '').trim();
      if (!label) return false;
      // No status at all is treated as pending: an event that has not started
      // has a schedule and nothing else.
      return !m.status || PENDING.test(m.status);
    });

    const upcoming: UpcomingMatch[] = pending.slice(0, 6).map(m => ({
      name: (m.label ?? '').trim(),
      shortName: shortLabel(m.label ?? ''),
      // ISO-ish local time string is what the surfaces render; null when Nexus
      // has no estimate, which is honest rather than inventing one.
      time: (() => {
        const at = bestStartEstimate(m);
        return at ? new Date(at).toISOString() : null;
      })(),
      red: teamNumbers(m.redTeams),
      blue: teamNumbers(m.blueTeams),
    }));

    if (upcoming.length) {
      this.#bus.emit({
        type: 'queue.updated',
        source: 'nexus',
        // Derived, not authoritative: these are a queuer's estimates, and the
        // desk's contract is that an estimate is labelled as one.
        confidence: 'derived',
        payload: {
          upcoming,
          nowQueuing: status.nowQueuing ?? null,
          from: 'nexus',
        },
      });
    }

    // A change in who is being called is the event worth announcing on its
    // own, separately from the list: it is what drives "teams to the field".
    const now = (status.nowQueuing ?? '').trim() || null;
    if (now !== this.#lastNowQueuing) {
      this.#lastNowQueuing = now;
      if (now && this.#started) {
        const match = (status.matches ?? []).find(m => (m.label ?? '').trim() === now);
        this.#bus.emit({
          type: 'queue.called',
          source: 'nexus',
          confidence: 'authoritative',   // a human pressed this
          payload: {
            label: now,
            red: teamNumbers(match?.redTeams),
            blue: teamNumbers(match?.blueTeams),
          },
        });
      }
    }
  }

  #applyAnnouncements(status: NexusEventStatus): void {
    for (const a of status.announcements ?? []) {
      const text = (a.announcement ?? '').trim();
      if (!text) continue;
      const id = a.id ?? `${a.postedTime ?? 0}:${text}`;
      if (this.#seenAnnouncements.has(id)) continue;
      this.#seenAnnouncements.add(id);
      // On the first poll the whole backlog is already "seen": mirroring
      // this morning's announcements onto the screens at 2pm would be worse
      // than useless.
      if (!this.#started) continue;

      this.#bus.emit({
        type: 'announcement.posted',
        source: 'nexus',
        payload: { text, postedAt: a.postedTime ?? Date.now(), from: 'Nexus' },
      });
    }
  }
}
