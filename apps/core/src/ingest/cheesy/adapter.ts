/**
 * Cheesy Arena -> DeskEvent adapter.
 *
 * Close to a rename of fields, with one genuinely interesting piece: neither
 * Cheesy Arena nor FMS emits "team X just scored". `score.delta` is synthesised
 * here by diffing consecutive realtime-score snapshots, and it is what drives
 * automatic replay markers, scoring-rate graphics, and the post-match timeline.
 * It is the highest-value derived signal in the system and it costs about forty
 * lines.
 */

import type { EmitInit, EventBus } from '../../bus.ts';
import type { Alliance, MatchInfo, Team } from '../../types.ts';
import { CheesyClient, type CheesyClientOpts } from './client.ts';
import {
  MatchState, fuelPoints, towerPoints,
  type ArenaStatusMessage, type MatchLoadMessage, type MatchTimeMessage,
  type RealtimeScoreMessage, type ScorePostedMessage, type ScoreSummary,
} from './protocol.ts';

const ALLIANCES: Alliance[] = ['red', 'blue'];

interface Totals { fuel: number; tower: number; foulsAgainst: number }
const zero = (): Totals => ({ fuel: 0, tower: 0, foulsAgainst: 0 });

export interface CheesyAdapterOpts extends Omit<CheesyClientOpts, 'onEvent' | 'onStatus'> {
  bus: EventBus;
}

export class CheesyAdapter {
  #bus: EventBus;
  #client: CheesyClient;
  #last: Record<Alliance, Totals> = { red: zero(), blue: zero() };
  #matchState: MatchState = MatchState.PreMatch;
  #started = false;

  constructor(opts: CheesyAdapterOpts) {
    this.#bus = opts.bus;
    this.#client = new CheesyClient({
      host: opts.host,
      displayId: opts.displayId,
      onEvent: (notifier, data) => this.ingest(notifier, data),
      onStatus: (up, detail) => {
        this.#bus.emit({
          type: 'arena.status', source: 'cheesy', confidence: 'authoritative',
          payload: { cheesy: up, detail },
        });
      },
    });
  }

  get client(): CheesyClient { return this.#client; }

  start(): void { this.#client.connect(); }
  stop(): void { this.#client.close(); }

  #emit(init: EmitInit): void {
    this.#bus.emit({ confidence: 'authoritative', source: 'cheesy', ...init });
  }

  /**
   * Feed one Cheesy Arena notifier in. Public because the websocket is not the
   * only thing that drives it — a recorded capture can be replayed through the
   * same path to rehearse the whole pipeline without a field.
   */
  ingest(notifier: string, data: unknown): void {
    switch (notifier) {
      case 'matchLoad': return this.#onMatchLoad(data as MatchLoadMessage);
      case 'matchTime': return this.#onMatchTime(data as MatchTimeMessage);
      case 'realtimeScore': return this.#onRealtimeScore(data as RealtimeScoreMessage);
      case 'scorePosted': return this.#onScorePosted(data as ScorePostedMessage);
      case 'arenaStatus': return this.#onArenaStatus(data as ArenaStatusMessage);
      default: return;   // lowerThird, playSound, etc. — the desk owns those
    }
  }

  // ---- match lifecycle ----------------------------------------------------

  #onMatchLoad(msg: MatchLoadMessage): void {
    const m = msg.Match ?? {};
    const teamAt = (key: string, fallback: number | undefined): Team | null => {
      const t = msg.Teams?.[key];
      const number = t?.Id ?? fallback;
      if (!number) return null;
      return {
        number,
        name: t?.Nickname ?? t?.Name ?? '',
        ...(msg.Rankings?.[String(number)] ? { rank: msg.Rankings[String(number)] } : {}),
      };
    };

    const red = [teamAt('R1', m.Red1), teamAt('R2', m.Red2), teamAt('R3', m.Red3)].filter(Boolean) as Team[];
    const blue = [teamAt('B1', m.Blue1), teamAt('B2', m.Blue2), teamAt('B3', m.Blue3)].filter(Boolean) as Team[];

    const match: MatchInfo = {
      id: String(m.Id ?? `${m.Type ?? 'm'}${m.TypeOrder ?? 0}`),
      displayName: m.LongName ?? m.ShortName ?? 'Match',
      red, blue,
    };

    this.#last = { red: zero(), blue: zero() };
    this.#started = false;
    this.#emit({ type: 'match.loaded', payload: match });
  }

  /**
   * Cheesy sends matchTime continuously. We only care about the transitions —
   * the desk derives its own clock from match.start, so a dropped frame or a
   * network hiccup can't make the countdown stutter.
   */
  #onMatchTime(msg: MatchTimeMessage): void {
    const state = msg.MatchState ?? MatchState.PreMatch;
    if (state === this.#matchState) return;
    const previous = this.#matchState;
    this.#matchState = state;

    switch (state) {
      case MatchState.StartMatch:
      case MatchState.AutoPeriod:
        if (!this.#started) { this.#started = true; this.#emit({ type: 'match.start' }); }
        break;
      case MatchState.PostMatch:
        // Only a real match end — coming back from a timeout isn't one.
        if (previous === MatchState.TeleopPeriod || previous === MatchState.AutoPeriod
            || previous === MatchState.PausePeriod) {
          this.#emit({ type: 'match.end' });
        }
        this.#started = false;
        break;
      case MatchState.PreMatch:
        this.#started = false;
        this.#emit({ type: 'match.prestart' });
        break;
      case MatchState.TimeoutActive:
        this.#emit({ type: 'break.started', payload: { kind: 'timeout' } });
        break;
    }
  }

  // ---- scoring ------------------------------------------------------------

  #totals(summary: ScoreSummary | undefined, opponent: ScoreSummary | undefined): Totals {
    return {
      fuel: fuelPoints(summary),
      tower: towerPoints(summary),
      // Our AllianceScore.fouls means "points this alliance conceded", because
      // the reducer computes total = fuel + tower + opponent.fouls. Cheesy's
      // FoulPoints are credited TO an alliance, so they belong on the other
      // side of the ledger. Covered by a test — this is easy to get backwards.
      foulsAgainst: opponent?.FoulPoints ?? 0,
    };
  }

  #onRealtimeScore(msg: RealtimeScoreMessage): void {
    const summaries: Record<Alliance, ScoreSummary | undefined> = {
      red: msg.Red?.ScoreSummary,
      blue: msg.Blue?.ScoreSummary,
    };

    const next: Record<Alliance, Totals> = {
      red: this.#totals(summaries.red, summaries.blue),
      blue: this.#totals(summaries.blue, summaries.red),
    };

    // Synthesise the deltas Cheesy never sends.
    for (const side of ALLIANCES) {
      for (const field of ['fuel', 'tower'] as const) {
        const amount = next[side][field] - this.#last[side][field];
        // Only positive deltas: a score correction downward is not a highlight,
        // and emitting it would drop a bogus replay marker.
        if (amount > 0) {
          this.#emit({ type: 'score.delta', payload: { alliance: side, field, amount } });
        }
      }
    }
    this.#last = next;

    this.#emit({
      type: 'score.realtime',
      payload: {
        red: { fuel: next.red.fuel, tower: next.red.tower, fouls: next.red.foulsAgainst },
        blue: { fuel: next.blue.fuel, tower: next.blue.tower, fouls: next.blue.foulsAgainst },
      },
    });

    // The hub shift countdown — the 2026-specific graphic.
    const remaining = msg.Red?.ActiveRemainingSec ?? msg.Blue?.ActiveRemainingSec;
    if (typeof remaining === 'number') {
      this.#emit({ type: 'hub.state', payload: { activeRemainingSec: remaining } });
    }

    for (const [side, cards] of [['red', msg.RedCards], ['blue', msg.BlueCards]] as const) {
      for (const [team, card] of Object.entries(cards ?? {})) {
        if (card) this.#emit({ type: 'card.issued', payload: { alliance: side, team: Number(team), card } });
      }
    }
  }

  #onScorePosted(msg: ScorePostedMessage): void {
    this.#emit({
      type: 'match.score_posted',
      payload: {
        red: { score: msg.RedScoreSummary?.Score ?? 0, rp: msg.RedRankingPoints ?? 0 },
        blue: { score: msg.BlueScoreSummary?.Score ?? 0, rp: msg.BlueRankingPoints ?? 0 },
      },
    });
  }

  // ---- field health -------------------------------------------------------

  #onArenaStatus(msg: ArenaStatusMessage): void {
    // "What happened to 846?" — the replay marker nobody thinks to hit,
    // because it happens while everyone is watching the other end of the field.
    const down: number[] = [];
    for (const station of Object.values(msg.AllianceStations ?? {})) {
      const team = station?.Team?.Id;
      if (!team || station?.Bypass) continue;
      if (station?.Ds && station.Ds.RobotLinked === false) down.push(team);
    }

    this.#emit({
      type: 'arena.status',
      payload: {
        cheesy: true,
        down,
        plcHealthy: msg.PlcIsHealthy ?? null,
        fieldEStop: msg.FieldEStop ?? false,
        ftaReady: msg.IsFtaReady ?? null,
      },
    });
  }
}
