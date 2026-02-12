import express from "express";
import {
  InitResponse,
  IncrementResponse,
  DecrementResponse,
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
const RULE_ORDER_KEY = "rule:order";
const RULE_INDEX_KEY = "rule:index";

const START_WORDS = wordList;

function getUtcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getSecondsUntilMidnightUtc(date = new Date()): number {
  const nextMidnight = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  );
  return Math.ceil((nextMidnight.getTime() - date.getTime()) / 1000);
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temp;
  }
  return copy;
}

function ruleAllowsWord(word: string, ruleLetter: string): boolean {
  const upper = word.toUpperCase();
  return !upper.endsWith(ruleLetter.toUpperCase());
}

async function getDailyRuleLetter(): Promise<string> {
  const dateKey = getUtcDateKey();
  const dailyKey = `rule:${dateKey}`;
  const cached = await redis.get(dailyKey);
  if (cached) return cached.toUpperCase();

  const yesterdayKey = `rule:${getUtcDateKey(
    new Date(Date.now() - 24 * 60 * 60 * 1000),
  )}`;

  let order: string[] = [];
  let index = 0;

  const [orderRaw, indexRaw, yesterdayRule] = await Promise.all([
    redis.get(RULE_ORDER_KEY),
    redis.get(RULE_INDEX_KEY),
    redis.get(yesterdayKey),
  ]);

  if (orderRaw) {
    try {
      const parsed = JSON.parse(orderRaw) as string[];
      order = Array.isArray(parsed) ? parsed : [];
    } catch {
      order = [];
    }
  }

  if (!order.length) {
    order = shuffle(RULE_LETTERS);
    index = 0;
  } else if (indexRaw) {
    const parsedIndex = parseInt(indexRaw, 10);
    index = Number.isFinite(parsedIndex) ? parsedIndex : 0;
  }

  if (index >= order.length) {
    order = shuffle(RULE_LETTERS);
    index = 0;
  }

  const fallbackLetter = RULE_LETTERS[0] ?? "S";
  let letter = order[index] ?? fallbackLetter;
  if (
    order.length > 1 &&
    yesterdayRule &&
    letter.toUpperCase() === yesterdayRule.toUpperCase()
  ) {
    index = (index + 1) % order.length;
    letter = order[index] ?? letter;
  }

  await redis.set(RULE_ORDER_KEY, JSON.stringify(order));
  await redis.set(RULE_INDEX_KEY, String(index + 1));
  await redis.set(dailyKey, letter.toUpperCase());
  await redis.expire(dailyKey, getSecondsUntilMidnightUtc());

  return letter.toUpperCase();
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

router.get("/api/daily-rule", async (_req, res): Promise<void> => {
  try {
    const letter = await getDailyRuleLetter();
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

    res.json({
      status: "success",
      message: `Post created in subreddit ${context.subredditName} with id ${post.id}`,
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

// Return top N entries for a given date (defaults to today). Example: /api/leaderboard?top=3&date=2026-02-06
router.get("/api/leaderboard", async (req, res): Promise<void> => {
  try {
    const topParam = parseInt((req.query.top as string) || "3", 10);
    const top = Number.isFinite(topParam) && topParam > 0 ? topParam : 3;

    const dateQuery =
      (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const leaderboardKey = `leaderboard:${dateQuery}`;

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
    res.status(200).json({ date: dateQuery, entries });
  } catch (error) {
    console.error("Error in /api/leaderboard:", error);
    res
      .status(200)
      .json({ date: new Date().toISOString().slice(0, 10), entries: [] });
  }
});

// Return a start word that does not repeat for the user on the same day
router.get("/api/start-word", async (_req, res): Promise<void> => {
  try {
    const username = (await reddit.getCurrentUsername()) ?? "anonymous";
    const dateKey = getUtcDateKey();
    const key = `startwords:${dateKey}:${username}`;

    const ruleLetter = await getDailyRuleLetter();

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
    await redis.expire(key, getSecondsUntilMidnightUtc());

    res.json({ word: startWord });
  } catch (error) {
    console.error("Error in /api/start-word:", error);
    res.status(200).json({ word: "GAME" });
  }
});

// Persist a player's score to the daily leaderboard
router.post("/api/submit-score", async (req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    res.status(400).json({ status: "error", message: "postId is required" });
    return;
  }

  try {
    const { score } = req.body as { score?: number };
    if (typeof score !== "number") {
      res
        .status(400)
        .json({ status: "error", message: "score must be a number" });
      return;
    }

    // Use current username from reddit context
    const username = (await reddit.getCurrentUsername()) ?? "anonymous";

    // Daily key (YYYY-MM-DD in UTC)
    const dateKey = getUtcDateKey();
    const leaderboardKey = `leaderboard:${dateKey}`;

    // Only update if this score is greater than existing score for this user
    const existing = await redis.zScore(leaderboardKey, username);
    if (existing != null && existing >= score) {
      res.json({ status: "ok", updated: false });
      return;
    }

    // Add/update the user's score in the sorted set
    await redis.zAdd(leaderboardKey, { member: username, score });

    // Ensure key expires at next UTC midnight so leaderboard resets daily
    await redis.expire(leaderboardKey, getSecondsUntilMidnightUtc());

    res.json({ status: "ok", updated: true });
  } catch (error) {
    console.error("Error in /api/submit-score:", error);
    res.status(500).json({ status: "error", message: "Failed to save score" });
  }
});

app.use(router);

const server = createServer(app);
server.on("error", (err) => console.error(`server error; ${err.stack}`));
server.listen(getServerPort());
