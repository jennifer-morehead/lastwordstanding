import { navigateTo, context, requestExpandedMode } from "@devvit/web/client";
import { LeaderboardResponse } from "../../shared/types/api";

const docsLink = document.getElementById("docs-link") as HTMLDivElement | null;
const playtestLink = document.getElementById(
  "playtest-link",
) as HTMLDivElement | null;
const discordLink = document.getElementById(
  "discord-link",
) as HTMLDivElement | null;
const startButton = document.getElementById(
  "start-button",
) as HTMLButtonElement;

startButton?.addEventListener("click", (e) => {
  // Open game directly (start playing)
  requestExpandedMode(e, "game");
});

docsLink?.addEventListener("click", () => {
  navigateTo("https://developers.reddit.com/docs");
});

playtestLink?.addEventListener("click", () => {
  navigateTo("https://www.reddit.com/r/Devvit");
});

discordLink?.addEventListener("click", () => {
  navigateTo("https://discord.com/invite/R7yu2wh9Qz");
});

const titleElement = document.getElementById("title") as HTMLHeadingElement;

function updatePostNumberLabel(_postNumber?: number, ruleLetter?: string) {
  const stack = document.getElementById("post-rule-stack");
  const postLabel = document.getElementById("post-number-label");
  const ruleLabel = document.getElementById("post-rule-label");
  if (!stack || !postLabel || !ruleLabel) return;

  const hasRule =
    typeof ruleLetter === "string" && ruleLetter.trim().length > 0;

  if (!hasRule) {
    postLabel.textContent = "";
    ruleLabel.textContent = "";
    stack.hidden = true;
    return;
  }

  postLabel.textContent = "TODAY’S RULE ·";
  ruleLabel.textContent = hasRule
    ? `No words ending in ${ruleLetter.toUpperCase()}`
    : "";
  stack.hidden = false;
}

function formatUsername(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "u/player123";
  if (/^u\//i.test(trimmed)) return trimmed;
  return `u/${trimmed}`;
}

function init() {
  // Personalize splash headline if username available
  if (titleElement) {
    const displayName = context.username
      ? formatUsername(context.username)
      : "friend";
    titleElement.textContent = `Hello ${displayName} 👋`;
  }
}

init();

// Fetch and render top players into the splash preview
async function fetchTopPlayers(top = 3) {
  try {
    const resp = await fetch(`/api/leaderboard?top=${top}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as LeaderboardResponse;
    updatePostNumberLabel(data.postNumber, data.ruleLetter);
    renderTopPlayers((data.entries || []).slice(0, 3));
  } catch (err) {
    const container = document.getElementById("top-players");
    updatePostNumberLabel();
    if (container) {
      container.className = "top-players-list is-error";
      container.innerHTML = `<div class="top-player-placeholder">Leaderboard unavailable</div>`;
    }
    console.warn("Failed to load leaderboard:", err);
  }
}

function renderTopPlayers(entries: Array<{ username: string; score: number }>) {
  const container = document.getElementById("top-players");
  if (!container) return;
  if (!entries || entries.length === 0) {
    container.className = "top-players-list is-empty";
    container.innerHTML = `<div class="top-player-placeholder">No scores yet. Play first.</div>`;
    return;
  }

  container.className = "top-players-list has-entries";
  container.innerHTML = "";
  entries.slice(0, 3).forEach((entry, idx) => {
    const item = document.createElement("div");
    item.className = "top-player-item";

    const rank = document.createElement("div");
    rank.className = `top-player-rank ${
      idx === 0 ? "gold" : idx === 1 ? "silver" : "bronze"
    }`;
    rank.textContent = (idx + 1).toString();

    const name = document.createElement("div");
    name.className = "top-player-name";
    name.textContent = formatUsername(entry.username);

    const score = document.createElement("div");
    score.className = "top-player-score";
    score.textContent = `${entry.score}`;

    item.appendChild(rank);
    item.appendChild(name);
    item.appendChild(score);

    container.appendChild(item);
  });
}

// Kick off fetching top players on load
fetchTopPlayers(3);

// Auto-refresh leaderboard every 30 seconds
setInterval(() => {
  fetchTopPlayers(3);
}, 30000);
