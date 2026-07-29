/**
 * Cheesy Arena wire shapes, transcribed from the 2026 source.
 *
 * Field names are Go struct fields serialised with default JSON marshalling,
 * so they are PascalCase. Everything here is `Partial`-ish and read
 * defensively — an off-season FMS build may differ slightly, and a missing
 * field must degrade rather than crash the broadcast.
 */

/**
 * field/arena.go — serialised as an integer.
 *
 * A const object rather than an `enum`: enums emit runtime code, and this
 * project runs TypeScript through Node's type stripping, which requires every
 * construct to be erasable.
 */
export const MatchState = {
  PreMatch: 0,
  StartMatch: 1,
  AutoPeriod: 2,
  PausePeriod: 3,
  TeleopPeriod: 4,
  PostMatch: 5,
  TimeoutActive: 6,
  PostTimeout: 7,
} as const;

export type MatchState = typeof MatchState[keyof typeof MatchState];

/** game/score_summary.go */
export interface ScoreSummary {
  AutoFuelPoints?: number;
  AutoTowerPoints?: number;
  TeleopFuelPoints?: number;
  TeleopTowerPoints?: number;
  NumFuel?: number;
  MatchPoints?: number;
  FoulPoints?: number;
  Score?: number;
  EnergizedBonusRankingPoint?: boolean;
  SuperchargedBonusRankingPoint?: boolean;
  TraversalBonusRankingPoint?: boolean;
  BonusRankingPoints?: number;
  PlayoffDq?: boolean;
}

/** field/arena_notifiers.go — audienceAllianceScoreFields */
export interface AllianceScoreFields {
  Score?: unknown;
  ScoreSummary?: ScoreSummary;
  /** Drives the hub shift countdown. */
  ActiveRemainingSec?: number;
  ActiveDurationSec?: number;
}

export interface RealtimeScoreMessage {
  Red?: AllianceScoreFields;
  Blue?: AllianceScoreFields;
  RedCards?: Record<string, string>;
  BlueCards?: Record<string, string>;
  MatchState?: MatchState;
}

export interface MatchTimeMessage {
  MatchState?: MatchState;
  MatchTimeSec?: number;
}

export interface CheesyTeam {
  Id?: number;
  Nickname?: string;
  Name?: string;
}

export interface CheesyMatch {
  Id?: number;
  Type?: number | string;
  TypeOrder?: number;
  LongName?: string;
  ShortName?: string;
  Red1?: number; Red2?: number; Red3?: number;
  Blue1?: number; Blue2?: number; Blue3?: number;
}

export interface MatchLoadMessage {
  Match?: CheesyMatch;
  /** Keyed "R1".."R3", "B1".."B3". */
  Teams?: Record<string, CheesyTeam | null>;
  Rankings?: Record<string, number>;
  IsReplay?: boolean;
  BreakDescription?: string;
  BreakNextMatchName?: string;
}

export interface ArenaStatusMessage {
  MatchId?: number;
  AllianceStations?: Record<string, {
    Team?: CheesyTeam | null;
    Ds?: { RobotLinked?: boolean; DsLinked?: boolean } | null;
    Astop?: boolean;
    Estop?: boolean;
    Bypass?: boolean;
  } | null>;
  MatchState?: MatchState;
  PlcIsHealthy?: boolean;
  FieldEStop?: boolean;
  IsFtaReady?: boolean;
}

export interface ScorePostedMessage {
  MatchType?: string;
  Match?: CheesyMatch;
  RedScoreSummary?: ScoreSummary;
  BlueScoreSummary?: ScoreSummary;
  RedRankingPoints?: number;
  BlueRankingPoints?: number;
}

// ---------------------------------------------------------------------------
// REST shapes. Transcribed from web/api.go, model/match.go and
// game/ranking_fields.go in the 2026 source.
// ---------------------------------------------------------------------------

/** game.Ranking, flattened, plus the nickname the API joins on. */
export interface CheesyRanking {
  TeamId?: number;
  Rank?: number;
  PreviousRank?: number;
  RankingPoints?: number;
  MatchPoints?: number;
  AutoFuelPoints?: number;
  TowerPoints?: number;
  Wins?: number;
  Losses?: number;
  Ties?: number;
  Disqualifications?: number;
  Played?: number;
  Nickname?: string;
}

/** GET /api/rankings */
export interface RankingsResponse {
  Rankings?: CheesyRanking[];
  /** ShortName of the last committed match, e.g. "Q42". */
  HighestPlayedMatch?: string;
}

/** GET /api/matches/{type} — MatchWithResult[] */
export interface MatchWithResult {
  Match?: CheesyMatch & {
    Time?: string;
    NameDetail?: string;
    ScoreCommittedAt?: string;
    Status?: number;
  };
  Result?: {
    RedSummary?: ScoreSummary;
    BlueSummary?: ScoreSummary;
  } | null;
}

/**
 * game.MatchStatus. 0 scheduled, 1 hidden, 2 red won, 3 blue won, 4 tie.
 * A match is played once its status leaves "scheduled".
 */
export const MatchStatus = {
  Scheduled: 0, Hidden: 1, RedWon: 2, BlueWon: 3, Tie: 4,
} as const;

/** Points, not counts — REBUILT fuel is 1 point each into an active hub. */
export const fuelPoints = (s: ScoreSummary | undefined): number =>
  (s?.AutoFuelPoints ?? 0) + (s?.TeleopFuelPoints ?? 0);

export const towerPoints = (s: ScoreSummary | undefined): number =>
  (s?.AutoTowerPoints ?? 0) + (s?.TeleopTowerPoints ?? 0);
