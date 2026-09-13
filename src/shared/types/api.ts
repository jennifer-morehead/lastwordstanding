export type InitResponse = {
  type: "init";
  postId: string;
  count: number;
  username: string;
};

export type LeaderboardEntry = {
  username: string;
  score: number;
};

export type LeaderboardResponse = {
  postId: string;
  postNumber?: number;
  ruleLetter?: string;
  entries: LeaderboardEntry[];
};

export type SubmitScoreResponse = {
  status: "ok";
  updated: boolean;
  previousBest: number | null;
  isPersonalBest: boolean;
  runRank: number | null;
  pointsToTopTen: number | null;
};

export type AnalyticsEventType = "play_click";

export type AnalyticsEventRequest = {
  event: AnalyticsEventType;
};

export type AnalyticsWordStat = {
  word: string;
  count: number;
};

export type AnalyticsSummaryResponse = {
  gameOpens: number;
  playClicks: number;
  repeatPlayers: number;
  averageWordsPerPlayer: number;
  averageSubmitTimeMs: number;
  mostCommonWords: AnalyticsWordStat[];
};

export type IncrementResponse = {
  type: "increment";
  postId: string;
  count: number;
};

export type DecrementResponse = {
  type: "decrement";
  postId: string;
  count: number;
};

export type EndRunScoreRequest = {
  playerWords: string[];
  endingWord: string;
  submitDurationsMs?: number[];
};

export type ScoreBreakdown = {
  basePoints: number;
  chainBonus: number;
  rareWordBonus: number;
  totalPoints: number;
};

export type EndRunScoreResponse = {
  breakdown: ScoreBreakdown;
  endingWord: string;
};
