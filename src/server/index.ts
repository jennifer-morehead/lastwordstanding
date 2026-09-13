import express from "express";
import {
  AnalyticsEventRequest,
  AnalyticsSummaryResponse,
  InitResponse,
  IncrementResponse,
  DecrementResponse,
  EndRunScoreRequest,
  EndRunScoreResponse,
  LeaderboardResponse,
} from "../shared/types/api";
import {
  createServer,
  context,
  getServerPort,
  reddit,
  redis,
} from "@devvit/web/server";
import { createPost } from "./core/post";
import wordList from "../shared/wordlist.json";

const app = express();

// Middleware for JSON body parsing
app.use(express.json());
// Middleware for URL-encoded body parsing
app.use(express.urlencoded({ extended: true }));
// Middleware for plain text body parsing
app.use(express.text());

const router = express.Router();

const RULE_LETTERS = ["S", "E", "M", "R", "D", "Y", "T", "N", "L", "G"];
const ADMIN_USERNAME = "theotherchupe";

const START_WORDS = wordList;

type PostMetadata = {
  postNumber: number;
  ruleLetter: string;
  createdAt: string;
};

type AnalyticsTotals = {
  gameOpens: number;
  playClicks: number;
  totalWords: number;
  totalSubmitTimeMs: number;
  submitCount: number;
  completedRuns: number;
};

type AnalyticsPlayerStats = {
  playCount: number;
  totalWords: number;
};

type AnalyticsPlayers = Record<string, AnalyticsPlayerStats>;
type AnalyticsWords = Record<string, number>;

function getPostMetadataKey(postId: string): string {
  return `postmeta:${postId}`;
}

function getLeaderboardKey(postId: string): string {
  return `leaderboard:${postId}`;
}

function getWordFrequencyKey(postId: string, word: string): string {
  return `wordfreq:${postId}:${word}`;
}

function getStartWordHistoryKey(postId: string, username: string): string {
  return `startwords:${postId}:${username}`;
}

function getAnalyticsTotalsKey(postId: string): string {
  return `analytics:totals:${postId}`;
}

function getAnalyticsPlayersKey(postId: string): string {
  return `analytics:players:${postId}`;
}

function getAnalyticsWordsKey(postId: string): string {
  return `analytics:words:${postId}`;
}

function normalizeSubredditName(
  subredditName: string | null | undefined,
): string {
  const trimmed = String(subredditName ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed) {
    return "unknown";
  }

  return trimmed.replace(/\s+/g, "-");
}

function getPostNumberCounterKey(
  subredditName: string | null | undefined,
): string {
  const normalizedSubreddit = normalizeSubredditName(subredditName);
  return `post:number:counter:${normalizedSubreddit}`;
}

function getRuleSequenceKey(subredditName: string | null | undefined): string {
  const normalizedSubreddit = normalizeSubredditName(subredditName);
  return `rule:sequence:${normalizedSubreddit}`;
}

function parsePostMetadata(
  raw: string | null | undefined,
): PostMetadata | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PostMetadata>;
    const postNumber = Number(parsed.postNumber);
    const ruleLetter = String(parsed.ruleLetter ?? "")
      .trim()
      .toUpperCase();
    const createdAt = String(parsed.createdAt ?? "").trim();

    if (!Number.isFinite(postNumber) || postNumber <= 0 || !ruleLetter) {
      return null;
    }

    return {
      postNumber,
      ruleLetter,
      createdAt: createdAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizeUsername(name: string | null | undefined): string {
  const trimmed = String(name ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/^u\//, "");
}

function isAdminUsername(name: string | null | undefined): boolean {
  return normalizeUsername(name) === ADMIN_USERNAME;
}

function createDefaultAnalyticsTotals(): AnalyticsTotals {
  return {
    gameOpens: 0,
    playClicks: 0,
    totalWords: 0,
    totalSubmitTimeMs: 0,
    submitCount: 0,
    completedRuns: 0,
  };
}

async function readJsonValue<T>(key: string, fallback: T): Promise<T> {
  const raw = await redis.get(key);
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function requireAdminUsername(
  res: express.Response,
): Promise<string | null> {
  const username = (await reddit.getCurrentUsername()) ?? "anonymous";
  if (!isAdminUsername(username)) {
    res.status(403).json({ status: "error", message: "Forbidden" });
    return null;
  }

  return username;
}

function hashStringToSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function deterministicShuffle<T>(items: T[], seed: number): T[] {
  const random = seededRandom(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temp;
  }
  return copy;
}

function getCycleRuleOrder(
  cycle: number,
  subredditName: string | null | undefined,
): string[] {
  const subredditKey = normalizeSubredditName(subredditName);
  const cycleSeed = hashStringToSeed(`${subredditKey}:${cycle}`);
  const order = deterministicShuffle(RULE_LETTERS, cycleSeed);

  // Prevent immediate repeats at cycle boundaries by adjusting cycle start.
  if (cycle > 0 && order.length > 1) {
    const previousSeed = hashStringToSeed(`${subredditKey}:${cycle - 1}`);
    const previousOrder = deterministicShuffle(RULE_LETTERS, previousSeed);
    const previousLast = previousOrder[previousOrder.length - 1];
    if (previousLast && order[0] === previousLast) {
      const swapIndex = 1;
      const temp = order[0]!;
      order[0] = order[swapIndex]!;
      order[swapIndex] = temp;
    }
  }

  return order;
}

function ruleAllowsWord(word: string, ruleLetter: string): boolean {
  const upper = word.toUpperCase();
  return !upper.endsWith(ruleLetter.toUpperCase());
}

function getChainBonus(basePoints: number): number {
  if (basePoints >= 10) return 2;
  if (basePoints >= 5) return 1;
  return 0;
}

function getRuleLetterForSequence(
  sequence: number,
  subredditName: string | null | undefined,
): string {
  const fallbackLetter = RULE_LETTERS[0] ?? "S";
  if (
    !Number.isFinite(sequence) ||
    sequence <= 0 ||
    RULE_LETTERS.length === 0
  ) {
    return fallbackLetter;
  }

  const cycleSize = RULE_LETTERS.length;
  const zeroBasedSequence = sequence - 1;
  const cycle = Math.floor(zeroBasedSequence / cycleSize);
  const indexInCycle = zeroBasedSequence % cycleSize;
  const order = getCycleRuleOrder(cycle, subredditName);
  const letter = order[indexInCycle] ?? fallbackLetter;

  return letter.toUpperCase();
}

async function getNextRuleLetter(
  subredditName: string | null | undefined,
): Promise<string> {
  const sequenceRaw = await redis.incrBy(getRuleSequenceKey(subredditName), 1);
  const parsedSequence = Number(sequenceRaw);
  const sequence =
    Number.isFinite(parsedSequence) && parsedSequence > 0 ? parsedSequence : 1;

  return getRuleLetterForSequence(sequence, subredditName);
}

async function initializePostMetadata(
  postId: string,
  subredditName: string | null | undefined,
): Promise<PostMetadata> {
  const postNumberRaw = await redis.incrBy(
    getPostNumberCounterKey(subredditName),
    1,
  );
  const parsedPostNumber = Number(postNumberRaw);
  const ruleLetter = await getNextRuleLetter(subredditName);

  const metadata: PostMetadata = {
    postNumber:
      Number.isFinite(parsedPostNumber) && parsedPostNumber > 0
        ? parsedPostNumber
        : 1,
    ruleLetter,
    createdAt: new Date().toISOString(),
  };

  await redis.set(getPostMetadataKey(postId), JSON.stringify(metadata));

  return metadata;
}

async function getOrCreatePostMetadata(postId: string): Promise<PostMetadata> {
  return getOrCreatePostMetadataForSubreddit(postId, context.subredditName);
}

async function getOrCreatePostMetadataForSubreddit(
  postId: string,
  subredditName: string | null | undefined,
): Promise<PostMetadata> {
  const existing = parsePostMetadata(
    await redis.get(getPostMetadataKey(postId)),
  );
  if (existing) {
    return existing;
  }

  return initializePostMetadata(postId, subredditName);
}

async function getRuleLetterForPost(
  postId: string,
  subredditName: string | null | undefined,
): Promise<string> {
  const metadata = await getOrCreatePostMetadataForSubreddit(
    postId,
    subredditName,
  );
  return metadata.ruleLetter;
}

router.get<
  { postId: string },
  InitResponse | { status: string; message: string }
>("/api/init", async (_req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    console.error("API Init Error: postId not found in devvit context");
    res.status(400).json({
      status: "error",
      message: "postId is required but missing from context",
    });
    return;
  }

  try {
    await getOrCreatePostMetadata(postId);

    const analyticsTotals = await readJsonValue<AnalyticsTotals>(
      getAnalyticsTotalsKey(postId),
      createDefaultAnalyticsTotals(),
    );
    analyticsTotals.gameOpens += 1;
    await redis.set(
      getAnalyticsTotalsKey(postId),
      JSON.stringify(analyticsTotals),
    );

    const [count, username] = await Promise.all([
      redis.get("count"),
      reddit.getCurrentUsername(),
    ]);

    res.json({
      type: "init",
      postId: postId,
      count: count ? parseInt(count) : 0,
      username: username ?? "anonymous",
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = "Unknown error during initialization";
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    res.status(400).json({ status: "error", message: errorMessage });
  }
});

router.post("/api/analytics/event", async (req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({ status: "error", message: "postId is required" });
    return;
  }

  try {
    await getOrCreatePostMetadata(postId);

    const username = (await reddit.getCurrentUsername()) ?? "anonymous";
    const { event } = req.body as AnalyticsEventRequest;

    if (event !== "play_click") {
      res
        .status(400)
        .json({ status: "error", message: "Invalid analytics event" });
      return;
    }

    const totalsKey = getAnalyticsTotalsKey(postId);
    const playersKey = getAnalyticsPlayersKey(postId);
    const totals = await readJsonValue<AnalyticsTotals>(
      totalsKey,
      createDefaultAnalyticsTotals(),
    );
    const players = await readJsonValue<AnalyticsPlayers>(playersKey, {});

    totals.playClicks += 1;

    const playerStats = players[username] ?? { playCount: 0, totalWords: 0 };
    playerStats.playCount += 1;
    players[username] = playerStats;

    await redis.set(totalsKey, JSON.stringify(totals));
    await redis.set(playersKey, JSON.stringify(players));

    res.json({ status: "ok" });
  } catch (error) {
    console.error("Error in /api/analytics/event:", error);
    res
      .status(500)
      .json({ status: "error", message: "Failed to track analytics event" });
  }
});

router.get("/api/analytics/summary", async (_req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({ status: "error", message: "postId is required" });
    return;
  }

  const username = await requireAdminUsername(res);
  if (!username) {
    return;
  }

  try {
    await getOrCreatePostMetadata(postId);

    const [totals, players, words] = await Promise.all([
      readJsonValue<AnalyticsTotals>(
        getAnalyticsTotalsKey(postId),
        createDefaultAnalyticsTotals(),
      ),
      readJsonValue<AnalyticsPlayers>(getAnalyticsPlayersKey(postId), {}),
      readJsonValue<AnalyticsWords>(getAnalyticsWordsKey(postId), {}),
    ]);

    const playerStats = Object.values(players);
    const uniquePlayers = playerStats.length;
    const repeatPlayers = playerStats.filter(
      (player) => player.playCount > 1,
    ).length;
    const averageWordsPerPlayer =
      uniquePlayers > 0 ? totals.totalWords / uniquePlayers : 0;
    const averageSubmitTimeMs =
      totals.submitCount > 0
        ? totals.totalSubmitTimeMs / totals.submitCount
        : 0;
    const mostCommonWords = Object.entries(words)
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(0, 5)
      .map(([word, count]) => ({ word, count }));

    const response: AnalyticsSummaryResponse = {
      gameOpens: totals.gameOpens,
      playClicks: totals.playClicks,
      repeatPlayers,
      averageWordsPerPlayer,
      averageSubmitTimeMs,
      mostCommonWords,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error in /api/analytics/summary:", error);
    res
      .status(500)
      .json({ status: "error", message: "Failed to load analytics summary" });
  }
});

router.get("/api/daily-rule", async (_req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({
      status: "error",
      message: "postId is required",
    });
    return;
  }

  try {
    const letter = await getRuleLetterForPost(postId, context.subredditName);
    res.status(200).json({ letter });
  } catch (error) {
    console.error("Error in /api/daily-rule:", error);
    res.status(200).json({ letter: "S" });
  }
});

router.post<
  { postId: string },
  IncrementResponse | { status: string; message: string },
  unknown
>("/api/increment", async (_req, res): Promise<void> => {
  const { postId } = context;
  if (!postId) {
    res.status(400).json({
      status: "error",
      message: "postId is required",
    });
    return;
  }

  res.json({
    count: await redis.incrBy("count", 1),
    postId,
    type: "increment",
  });
});

router.post<
  { postId: string },
  DecrementResponse | { status: string; message: string },
  unknown
>("/api/decrement", async (_req, res): Promise<void> => {
  const { postId } = context;
  if (!postId) {
    res.status(400).json({
      status: "error",
      message: "postId is required",
    });
    return;
  }

  res.json({
    count: await redis.incrBy("count", -1),
    postId,
    type: "decrement",
  });
});

router.post("/internal/on-app-install", async (_req, res): Promise<void> => {
  try {
    const post = await createPost();
    const metadata = await getOrCreatePostMetadata(post.id);

    res.json({
      status: "success",
      message: `Post #${metadata.postNumber} created in subreddit ${context.subredditName} with id ${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: "error",
      message: "Failed to create post",
    });
  }
});

router.post("/internal/menu/post-create", async (_req, res): Promise<void> => {
  try {
    const post = await createPost();
    await getOrCreatePostMetadata(post.id);

    res.json({
      navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: "error",
      message: "Failed to create post",
    });
  }
});

// Return top N entries for the current post.
router.get("/api/leaderboard", async (req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({ status: "error", message: "postId is required" });
    return;
  }

  try {
    const topParam = parseInt((req.query.top as string) || "3", 10);
    const top = Number.isFinite(topParam) && topParam > 0 ? topParam : 3;
    const metadata = await getOrCreatePostMetadata(postId);
    const leaderboardKey = getLeaderboardKey(postId);

    let entries: Array<{ username: string; score: number }> = [];
    try {
      const membersRaw: unknown[] = await redis.zRange(
        leaderboardKey,
        0,
        top - 1,
        {
          by: "rank",
          reverse: true,
        },
      );
      const members = membersRaw
        .map((member) => {
          if (typeof member === "string") return member;
          if (member && typeof member === "object" && "member" in member) {
            const value = (member as { member?: unknown }).member;
            return typeof value === "string" ? value : String(value ?? "");
          }
          return String(member ?? "");
        })
        .filter((member) => member.length > 0);
      entries = await Promise.all(
        members.map(async (member) => {
          let s = 0;
          try {
            const score = await redis.zScore(leaderboardKey, member);
            s = score !== null ? Number(score) : 0;
          } catch (err) {
            console.warn("Redis error in zScore fetch:", err);
          }
          return { username: member, score: s };
        }),
      );
    } catch (err) {
      console.warn("Redis error in leaderboard fetch:", err);
      // If Redis fails, return empty leaderboard
      entries = [];
    }

    const response: LeaderboardResponse = {
      postId,
      postNumber: metadata.postNumber,
      ruleLetter: metadata.ruleLetter,
      entries,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error in /api/leaderboard:", error);
    res.status(200).json({ postId, entries: [] });
  }
});

// Return a start word that does not repeat for the user on the same post
router.get("/api/start-word", async (_req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({ status: "error", message: "postId is required" });
    return;
  }

  try {
    const username = (await reddit.getCurrentUsername()) ?? "anonymous";
    const key = getStartWordHistoryKey(postId, username);

    const ruleLetter = await getRuleLetterForPost(
      postId,
      context.subredditName,
    );

    const raw = await redis.get(key);
    const used = raw ? (JSON.parse(raw) as string[]) : [];
    const usedSet = new Set(used);

    let startWord = "GAME";
    const candidates = (START_WORDS.length > 0 ? START_WORDS : wordList).filter(
      (word) => ruleAllowsWord(word, ruleLetter),
    );
    const maxAttempts = Math.min(1000, candidates.length * 2);

    for (let i = 0; i < maxAttempts; i += 1) {
      const idx = Math.floor(Math.random() * candidates.length);
      const candidate = candidates[idx];
      if (candidate && !usedSet.has(candidate)) {
        startWord = candidate;
        usedSet.add(candidate);
        break;
      }
    }

    if (startWord === "GAME" && candidates.length > 0) {
      const fallback =
        candidates[Math.floor(Math.random() * candidates.length)];
      if (fallback) {
        startWord = fallback;
        usedSet.add(startWord);
      }
    }

    const updated = Array.from(usedSet);
    await redis.set(key, JSON.stringify(updated));

    res.json({ word: startWord });
  } catch (error) {
    console.error("Error in /api/start-word:", error);
    res.status(200).json({ word: "GAME" });
  }
});

router.post("/api/end-run-score", async (req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({ status: "error", message: "postId is required" });
    return;
  }

  try {
    await getOrCreatePostMetadata(postId);

    const username = (await reddit.getCurrentUsername()) ?? "anonymous";
    const { playerWords, endingWord, submitDurationsMs } =
      req.body as EndRunScoreRequest;

    if (!Array.isArray(playerWords) || typeof endingWord !== "string") {
      res.status(400).json({
        status: "error",
        message: "playerWords array and endingWord are required",
      });
      return;
    }

    const normalizedWords = playerWords
      .map((word) => String(word).trim().toUpperCase())
      .filter((word) => word.length > 0);
    const normalizedDurations = Array.isArray(submitDurationsMs)
      ? submitDurationsMs
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value >= 0)
      : [];

    const basePoints = normalizedWords.length;
    const chainBonus = getChainBonus(basePoints);

    let rareWordBonus = 0;

    for (const word of normalizedWords) {
      const key = getWordFrequencyKey(postId, word);
      const count = await redis.incrBy(key, 1);

      const numericCount = Number(count);
      if (Number.isFinite(numericCount) && numericCount < 3) {
        rareWordBonus += 1;
      }
    }

    const totalsKey = getAnalyticsTotalsKey(postId);
    const playersKey = getAnalyticsPlayersKey(postId);
    const wordsKey = getAnalyticsWordsKey(postId);
    const totals = await readJsonValue<AnalyticsTotals>(
      totalsKey,
      createDefaultAnalyticsTotals(),
    );
    const players = await readJsonValue<AnalyticsPlayers>(playersKey, {});
    const words = await readJsonValue<AnalyticsWords>(wordsKey, {});

    totals.totalWords += normalizedWords.length;
    totals.totalSubmitTimeMs += normalizedDurations.reduce(
      (sum, value) => sum + value,
      0,
    );
    totals.submitCount += normalizedDurations.length;
    totals.completedRuns += 1;

    const playerStats = players[username] ?? { playCount: 0, totalWords: 0 };
    playerStats.totalWords += normalizedWords.length;
    players[username] = playerStats;

    normalizedWords.forEach((word) => {
      words[word] = (words[word] ?? 0) + 1;
    });

    await redis.set(totalsKey, JSON.stringify(totals));
    await redis.set(playersKey, JSON.stringify(players));
    await redis.set(wordsKey, JSON.stringify(words));

    const totalPoints = basePoints + chainBonus + rareWordBonus;
    const normalizedEndingWord =
      endingWord.trim().toUpperCase() ||
      normalizedWords[normalizedWords.length - 1] ||
      "N/A";

    const response: EndRunScoreResponse = {
      breakdown: {
        basePoints,
        chainBonus,
        rareWordBonus,
        totalPoints,
      },
      endingWord: normalizedEndingWord,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error in /api/end-run-score:", error);
    res
      .status(500)
      .json({ status: "error", message: "Failed to calculate score" });
  }
});

router.post("/api/submit-score", async (req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({ status: "error", message: "postId is required" });
    return;
  }

  try {
    await getOrCreatePostMetadata(postId);

    const { score } = req.body as { score?: number };
    if (typeof score !== "number") {
      res
        .status(400)
        .json({ status: "error", message: "score must be a number" });
      return;
    }

    // Use current username from reddit context
    const username = (await reddit.getCurrentUsername()) ?? "anonymous";

    const leaderboardKey = getLeaderboardKey(postId);

    // Only update if this score is greater than existing score for this user
    const existing = await redis.zScore(leaderboardKey, username);
    const previousBest = existing == null ? null : Number(existing);
    const isPersonalBest = previousBest !== null && score > previousBest;
    const updated = previousBest === null || score > previousBest;

    if (updated) {
      await redis.zAdd(leaderboardKey, { member: username, score });
    }

    // Evaluate this run independently from a stronger score the player may
    // already have saved on the leaderboard.
    const leadersRaw: unknown[] = await redis.zRange(
      leaderboardKey,
      0,
      10,
      { by: "rank", reverse: true },
    );
    const leaderNames = leadersRaw
      .map((member) => {
        if (typeof member === "string") return member;
        if (member && typeof member === "object" && "member" in member) {
          return String((member as { member?: unknown }).member ?? "");
        }
        return String(member ?? "");
      })
      .filter((member) => member.length > 0 && member !== username);
    const otherScores = await Promise.all(
      leaderNames.map(async (member) =>
        Number((await redis.zScore(leaderboardKey, member)) ?? 0),
      ),
    );
    const runRank = otherScores.filter((otherScore) => otherScore >= score)
      .length + 1;
    const qualifiesForTopTen = runRank <= 10;
    const tenthPlaceScore = otherScores[9];
    const pointsToTopTen = qualifiesForTopTen
      ? null
      : tenthPlaceScore === undefined
        ? null
        : Math.max(1, tenthPlaceScore - score + 1);

    res.json({
      status: "ok",
      updated,
      previousBest,
      isPersonalBest,
      runRank: qualifiesForTopTen ? runRank : null,
      pointsToTopTen,
    });
  } catch (error) {
    console.error("Error in /api/submit-score:", error);
    res.status(500).json({ status: "error", message: "Failed to save score" });
  }
});

app.use(router);

const server = createServer(app);
server.on("error", (err) => console.error(`server error; ${err.stack}`));
server.listen(getServerPort());
