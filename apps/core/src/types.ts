/**
 * Core data contract. See docs/02-architecture.md.
 *
 * One envelope for everything. Sources never talk to surfaces; they emit
 * DeskEvents and surfaces subscribe. Swapping an ingest adapter changes one
 * file and nothing else.
 */

export type Source =
  | 'cheesy'    // Cheesy Arena field bridge
  | 'frcapi'
  | 'tba'
  | 'statbotics'
  | 'startgg'
  | 'manual'    // desk console — always authoritative override
  | 'cue'       // show automation
  | 'replay';

/**
 * Matters more than it looks. Cheesy Arena gives `authoritative` numbers; a
 * state inferred from a scene change is `derived`; an operator's guess is
 * `estimated`. Graphics use this to decide whether to show a number at all —
 * an estimated score renders outlined, never solid, so we never present a
 * guess as official.
 */
export type Confidence = 'authoritative' | 'derived' | 'estimated';

export type Alliance = 'red' | 'blue';

export interface DeskEvent<T = unknown> {
  id: string;
  /** Wall clock, epoch ms, from the desk's clock. */
  ts: number;
  /** Signed seconds relative to match start. Null outside a match. */
  matchClock: number | null;
  source: Source;
  confidence: Confidence;
  type: DeskEventType;
  payload: T;
}

/** Deliberately a superset of Cheesy Arena's notifiers. */
export type DeskEventType =
  // match lifecycle
  | 'match.loaded' | 'match.prestart' | 'match.preview' | 'match.armed'
  | 'match.start' | 'match.auto_end' | 'match.shift_change' | 'match.endgame'
  | 'match.end' | 'match.aborted' | 'match.score_posted'
  // live state
  | 'score.realtime' | 'score.delta' | 'hub.state' | 'arena.status'
  | 'card.issued' | 'foul.called'
  // event flow
  | 'rankings.updated' | 'alliance_selection.update' | 'award.presented'
  | 'break.started' | 'queue.updated'
  // production
  | 'graphic.show' | 'graphic.hide' | 'lower_third.show' | 'lower_third.hide'
  // `screen.change` is our overlay switching pages; `scene.change` is the
  // switcher cutting cameras. Different layers, deliberately different events.
  | 'screen.change' | 'scene.change' | 'sound.play'
  | 'replay.marker' | 'replay.clip_ready' | 'replay.play'
  | 'telestrator.stroke' | 'telestrator.undo' | 'telestrator.clear'
  | 'telestrator.frame' | 'telestrator.hide'
  // arcade
  | 'arcade.set_start' | 'arcade.score' | 'arcade.set_end' | 'arcade.bracket_updated';

// ---------------------------------------------------------------------------
// 2026 REBUILT
// ---------------------------------------------------------------------------

export const REBUILT = {
  /** Match clock axis, in seconds. Auto runs negative so 0 is teleop start. */
  AUTO_START: -20,
  TELEOP_START: 0,
  TRANSITION_END: 10,
  SHIFT_SECONDS: 25,
  SHIFT_COUNT: 4,
  ENDGAME_START: 110,
  MATCH_END: 140,

  /** Points. Fuel into an INACTIVE hub scores nothing. */
  FUEL_ACTIVE: 1,
  TOWER_AUTO_L1: 15,
  TOWER_TELEOP: { 1: 10, 2: 20, 3: 30 } as Record<1 | 2 | 3, number>,

  /** Regional bonus RP thresholds. */
  RP_ENERGIZED_FUEL: 100,
  RP_SUPERCHARGED_FUEL: 360,
  RP_TRAVERSAL_TOWER: 50,

  RP_WIN: 3,
  RP_TIE: 1,
} as const;

export type Phase =
  | 'pre' | 'auto' | 'transition' | 'shift1' | 'shift2' | 'shift3' | 'shift4'
  | 'endgame' | 'post';

export interface Team {
  number: number;
  name: string;
  /** Present only if a robot cutout has been uploaded. */
  media?: { src: string; w: number; h: number };
  rank?: number;
  record?: string;
}

export interface AllianceScore {
  fuel: number;
  tower: number;
  fouls: number;
  /** fuel + tower + opponent foul points */
  total: number;
  rp: { energized: boolean; supercharged: boolean; traversal: boolean };
}

export const emptyAllianceScore = (): AllianceScore => ({
  fuel: 0, tower: 0, fouls: 0, total: 0,
  rp: { energized: false, supercharged: false, traversal: false },
});

export interface MatchInfo {
  id: string;
  /** "Qualification 42", "Playoff 3" — what goes on the intro card. */
  displayName: string;
  red: Team[];
  blue: Team[];
}

export interface LowerThird {
  line1: string;
  line2: string;
  /** Unpinned graphics auto-retire after --dwell. */
  pinned: boolean;
}

export interface RankingRow {
  rank: number;
  previousRank: number;
  team: number;
  name: string;
  rankingPoints: number;
  /** "8-2-1" */
  record: string;
  played: number;
}

export interface UpcomingMatch {
  name: string;
  shortName: string;
  time: string | null;
  red: number[];
  blue: number[];
}

export interface TelestratorState {
  /** Named on the ANALYSIS chip, so the audience knows it's opinion. */
  analyst: string;
  /**
   * Frozen frame the analyst is drawing on, as a URL. The single biggest
   * usability win: without it they're marking up a blank sheet while squinting
   * at a screen across the room, and every circle lands slightly wrong.
   */
  frame: string | null;
  /** Instant kill for program without clearing the analyst's pad. */
  hidden: boolean;
}

/** The snapshot every surface renders from. */
export interface DeskState {
  match: MatchInfo | null;
  phase: Phase;
  /**
   * Wall clock of match start. Surfaces derive their own matchClock from this
   * every frame rather than being pushed the clock at 10Hz — the overlay
   * countdown stays smooth through a network hiccup, and we don't spend
   * bandwidth on a number the client can compute.
   */
  matchStartedAt: number | null;
  /**
   * Survives the buzzer. `matchStartedAt` is cleared at match end so the clock
   * stops, but cutting a match video happens after that — often minutes after,
   * once the score is finally posted — and the replay timeline still needs to
   * map match clock onto wall clock.
   */
  lastMatchStartedAt: number | null;
  /** Wall clock of the buzzer, and of the score actually being posted. The gap
   *  between them is unbounded — referees deliberating fouls and cards can run
   *  minutes — which is why match videos cut rather than run straight through. */
  matchEndedAt: number | null;
  scorePostedAt: number | null;
  matchClock: number | null;
  /** Countdown as the audience sees it: "0:20" in auto, "2:20" in teleop. */
  clockDisplay: string;
  hubActive: Alliance | 'both' | 'none';
  /**
   * Hub state straight from the field, when the Cheesy bridge is up. Preferred
   * over inference — the field knows which hub is live and we would only be
   * guessing from the auto result. Null when running desk-only.
   */
  hubAuthoritative: Alliance | 'both' | 'none' | null;
  autoWinner: Alliance | null;
  /**
   * True once the field has told us who won auto. Needed because `null` is a
   * legitimate answer (a tied auto) and is otherwise indistinguishable from
   * "nobody has said yet" — without this the time-driven heuristic overwrites
   * the field's correct answer a moment after it arrives.
   */
  autoWinnerKnown: boolean;
  score: Record<Alliance, AllianceScore>;
  confidence: Confidence;
  /** Which surface screen is live: overview, match, score, blank... */
  screen: string;
  lowerThird: LowerThird | null;
  telestrator: TelestratorState;
  /** Drives the venue side screens. Polled from Cheesy, empty when desk-only. */
  rankings: RankingRow[];
  highestPlayedMatch: string;
  upcoming: UpcomingMatch[];
  /** Endgame: suppress decorative motion, keep score/clock animating. */
  lockdown: boolean;
  connected: { cheesy: boolean };
  updatedAt: number;
}

export const initialState = (): DeskState => ({
  match: null,
  phase: 'pre',
  matchStartedAt: null,
  lastMatchStartedAt: null,
  matchEndedAt: null,
  scorePostedAt: null,
  matchClock: null,
  clockDisplay: '0:20',
  hubActive: 'none',
  hubAuthoritative: null,
  autoWinner: null,
  autoWinnerKnown: false,
  score: { red: emptyAllianceScore(), blue: emptyAllianceScore() },
  confidence: 'estimated',
  screen: 'blank',
  lowerThird: null,
  telestrator: { analyst: '', frame: null, hidden: false },
  rankings: [],
  highestPlayedMatch: '',
  upcoming: [],
  lockdown: false,
  connected: { cheesy: false },
  updatedAt: Date.now(),
});

/** Sortable, collision-resistant id. Small ULID-ish: time + randomness. */
let lastMs = 0;
let seq = 0;
export function eventId(): string {
  const now = Date.now();
  if (now === lastMs) seq++;
  else { lastMs = now; seq = 0; }
  return `${now.toString(36).padStart(9, '0')}${seq.toString(36).padStart(3, '0')}` +
    Math.random().toString(36).slice(2, 8);
}
