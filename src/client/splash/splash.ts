import { navigateTo, context, requestExpandedMode } from "@devvit/web/client";

const docsLink = document.getElementById("docs-link") as HTMLDivElement;
const playtestLink = document.getElementById("playtest-link") as HTMLDivElement;
const discordLink = document.getElementById("discord-link") as HTMLDivElement;
const startButton = document.getElementById(
  "start-button",
) as HTMLButtonElement;
const leaderboardButton = document.getElementById(
  "leaderboard-button",
) as HTMLButtonElement | null;

startButton?.addEventListener("click", (e) => {
  // Open game directly (start playing)
  requestExpandedMode(e, "game");
});

leaderboardButton?.addEventListener("click", (e) => {
  // Request the expanded game view and signal it to open the leaderboard
  try {
    sessionStorage.setItem("lw_nextScreen", "leaderboard");
  } catch (err) {
    // ignore storage errors
    console.warn("Could not set sessionStorage for nextScreen", err);
  }
  try {
    localStorage.setItem("lw_nextScreen", "leaderboard");
  } catch (err) {
    // ignore storage errors
    console.warn("Could not set localStorage for nextScreen", err);
  }
  requestExpandedMode(e, "game");
});

docsLink.addEventListener("click", () => {
  navigateTo("https://developers.reddit.com/docs");
});

playtestLink.addEventListener("click", () => {
  navigateTo("https://www.reddit.com/r/Devvit");
});

discordLink.addEventListener("click", () => {
  navigateTo("https://discord.com/invite/R7yu2wh9Qz");
});

const titleElement = document.getElementById("title") as HTMLHeadingElement;

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
    const data = await resp.json();
    renderTopPlayers((data.entries || []).slice(0, 3));
  } catch (err) {
    const container = document.getElementById("top-players");
    if (container)
      container.innerHTML = `<div class="top-player-placeholder">Failed to load leaderboard</div>`;
    console.warn("Failed to load leaderboard:", err);
  }
}

function renderTopPlayers(entries: Array<{ username: string; score: number }>) {
  const container = document.getElementById("top-players");
  if (!container) return;
  if (!entries || entries.length === 0) {
    container.innerHTML = `<div class="top-player-placeholder">No entries yet — be the first!</div>`;
    return;
  }

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
