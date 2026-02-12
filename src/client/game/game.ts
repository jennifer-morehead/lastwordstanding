import { InitResponse } from "../../shared/types/api";
import wordListData from "word-list-json/words.json";

// Build a Set for O(1) lookups - filter to reasonable game words (2-10 letters)
const validWords = new Set<string>(
  (wordListData.words as string[])
    .filter((w: string) => w.length >= 2 && w.length <= 10)
    .map((w: string) => w.toUpperCase()),
);

type DailyRuleResponse = { letter?: string };

let currentRuleLetter = "S";
let ruleLoaded = false;
let cachedWordList: string[] | null = null;

function formatUsername(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "u/player123";
  if (/^u\//i.test(trimmed)) return trimmed;
  return `u/${trimmed}`;
}

function formatRuleText(letter: string): string {
  return `🔶 No words ending in '${letter}'`;
}

function updateRuleText(letter: string) {
  const el = document.getElementById("daily-rule-text");
  if (el) el.textContent = formatRuleText(letter);
}

async function loadDailyRule(): Promise<string> {
  if (ruleLoaded) return currentRuleLetter;

  const previousLetter = currentRuleLetter;

  try {
    const resp = await fetch("/api/daily-rule");
    if (resp.ok) {
      const data = (await resp.json()) as DailyRuleResponse;
      const letter = (data.letter || "S").toUpperCase();
      currentRuleLetter = letter;
    }
  } catch (error) {
    console.warn("Failed to load daily rule:", error);
  } finally {
    ruleLoaded = true;
    updateRuleText(currentRuleLetter);
  }

  if (previousLetter !== currentRuleLetter) {
    cachedWordList = null;
  }

  return currentRuleLetter;
}

// ============================================================================
// GAME STATE SYSTEM
// ============================================================================

type GameScreen = "home" | "gameplay" | "gameover" | "leaderboard";

/**
 * Show a specific screen and hide all others
 */
function showScreen(screen: GameScreen) {
  const screens = [
    "home-screen",
    "gameplay-screen",
    "gameover-screen",
    "leaderboard-screen",
  ];

  screens.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = id === `${screen}-screen` ? "block" : "none";
  });

  if (screen === "leaderboard") {
    fetchLeaderboard();
  }
}

// ============================================================================
// TIMER MANAGEMENT
// ============================================================================

const WORD_TIME_LIMIT = 7; // seconds per word

let timeRemaining = WORD_TIME_LIMIT;
let timerInterval: NodeJS.Timeout | null = null;
let wordCount = 0;
let usedWords: Set<string> = new Set(); // Track words to prevent repeats
let lastWordLastLetter = ""; // Track the letter the next word must start with
let isGameActive = false;

/**
 * Get the last letter of a word
 */
function getLastLetter(word: string): string {
  return word.slice(-1).toUpperCase();
}

/**
 * Validate a submitted word
 * Returns { valid: boolean, error: string | null }
 */
function validateWord(word: string): { valid: boolean; error: string | null } {
  const upperWord = word.toUpperCase();

  // Check if word is empty
  if (!upperWord || upperWord.trim().length === 0) {
    return { valid: false, error: "Please enter a word" };
  }

  // Check if it's the first word
  if (wordCount === 0) {
    // First word can start with anything, just check special rule
    if (upperWord.endsWith(currentRuleLetter)) {
      return {
        valid: false,
        error: `❌ No words ending in '${currentRuleLetter}' (today's rule!)`,
      };
    }
    return { valid: true, error: null };
  }

  // Check if word starts with the required letter
  if (!upperWord.startsWith(lastWordLastLetter)) {
    return {
      valid: false,
      error: `❌ Must start with '${lastWordLastLetter}'`,
    };
  }

  // Check if word has been used before
  if (usedWords.has(upperWord)) {
    return { valid: false, error: "❌ Word already used in this chain" };
  }

  // Check today's special rule: no words ending in 'S'
  if (upperWord.endsWith(currentRuleLetter)) {
    return {
      valid: false,
      error: `❌ No words ending in '${currentRuleLetter}' (today's rule!)`,
    };
  }

  return { valid: true, error: null };
}

/**
 * Check if a word is in our dictionary
 * Returns true if valid, false if not found
 */
function isInWordList(word: string): boolean {
  return validWords.has(word.toUpperCase());
}

/**
 * Show an error message to the user
 */
function showError(message: string) {
  const input = document.getElementById("word-input") as HTMLInputElement;
  if (input) {
    // Add error styling to input
    input.classList.add("input-error");
    input.title = message;

    // Remove error styling after 2 seconds
    setTimeout(() => {
      input.classList.remove("input-error");
    }, 2000);
  }

  // Show error in console or as visual feedback
  console.warn("Validation error:", message);
}

/**
 * Start the timer for a new word
 */
function startTimer() {
  timeRemaining = WORD_TIME_LIMIT;
  updateTimerDisplay();

  if (timerInterval) clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    timeRemaining--;
    updateTimerDisplay();

    if (timeRemaining <= 0) {
      stopTimer();
      endGame("Time ran out! ⏰");
    }
  }, 1000);
}

/**
 * Stop the timer
 */
function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

/**
 * Update the timer display in the UI
 */
function updateTimerDisplay() {
  const timerElement = document.getElementById("game-timer");
  const timerBottomElement = document.getElementById("game-timer-bottom");
  const text = `${timeRemaining}s`;
  if (timerElement) {
    timerElement.textContent = text;
    // Change color to red when time is running out
    if (timeRemaining <= 3) {
      timerElement.style.color = "#ef4444";
    }
  }
  if (timerBottomElement) {
    timerBottomElement.textContent = text;
    if (timeRemaining <= 3) {
      timerBottomElement.style.color = "#ef4444";
    }
  }
}

// GAME LOGIC
// ============================================================================

/**
 * End the game and transition to game over screen
 */
function endGame(reason: string) {
  if (!isGameActive) return;
  isGameActive = false;
  stopTimer();

  // Update game over screen
  const finalWordCountElement = document.getElementById("final-word-count");
  if (finalWordCountElement) {
    finalWordCountElement.textContent = `${wordCount} ${
      wordCount === 1 ? "word" : "words"
    }`;
  }

  const gameoverReasonElement = document.getElementById("gameover-reason");
  if (gameoverReasonElement) {
    gameoverReasonElement.innerHTML = `<span>${reason}</span>`;
  }

  // Ensure points shown on game over
  updatePointsDisplay();

  // Persist the final score to the server (daily leaderboard)
  persistScore(wordCount).catch((err) => {
    console.warn("Failed to persist score:", err);
  });

  // Transition to game over screen
  showScreen("gameover");

  const submitButton = document.getElementById(
    "submit-word",
  ) as HTMLButtonElement | null;
  if (submitButton) submitButton.disabled = true;
}

/**
 * Handle word submission
 */
function submitWord() {
  if (!isGameActive) return;
  const input = document.getElementById("word-input") as HTMLInputElement;
  const word = input?.value.trim();

  if (!word) return;

  // Validate the word (sync checks first)
  const validation = validateWord(word);
  if (!validation.valid) {
    showError(validation.error || "Invalid word");
    return;
  }

  const upperWord = word.toUpperCase();

  // Check if it's a real English word
  if (!isInWordList(upperWord)) {
    showError("❌ Not a valid English word");
    return;
  }

  // Add word to used words set
  usedWords.add(upperWord);

  // Update last word's last letter for next validation
  lastWordLastLetter = getLastLetter(upperWord);

  // Increment word count (points)
  wordCount++;
  // Update points UI
  updatePointsDisplay();

  // Add to chain display
  const wordChain = document.getElementById("word-chain");
  if (wordChain) {
    const chainWord = document.createElement("span");
    chainWord.className = "chain-word";
    chainWord.textContent = `✓ ${upperWord}`;
    wordChain.appendChild(chainWord);
  }

  // Clear input
  if (input) input.value = "";

  // Restart timer for next word
  startTimer();

  // Update current word display
  const currentWordDisplay = document.getElementById("current-word-display");
  if (currentWordDisplay) {
    currentWordDisplay.textContent = upperWord;
  }

  // Update next letter hint
  const nextLetterHint = document.getElementById("next-letter-hint");
  if (nextLetterHint) {
    nextLetterHint.textContent = `Next: ${lastWordLastLetter}____`;
  }

  // Focus back on input
  if (input) input.focus();
}

/**
 * Update points display across all screens
 */
function updatePointsDisplay() {
  const pointsElements = document.querySelectorAll(
    "#player-points, #gameplay-points, #gameover-points",
  );
  pointsElements.forEach((el) => {
    el.textContent = wordCount.toString();
  });
}

async function loadWordList(): Promise<string[]> {
  if (cachedWordList) return cachedWordList;

  const resp = await fetch("game/wordlist.json");
  if (!resp.ok) {
    throw new Error(`Failed to load word list: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as string[];
  cachedWordList = data
    .map((word) => word.trim().toUpperCase())
    .filter((word) => word.length > 0 && !word.endsWith(currentRuleLetter));
  return cachedWordList;
}

function pickRandomWord(words: string[]): string {
  if (words.length === 0) return "GAME";
  const index = Math.floor(Math.random() * words.length);
  return words[index] ?? "GAME";
}

async function fetchStartWord(): Promise<string> {
  const resp = await fetch("/api/start-word");
  if (!resp.ok) {
    throw new Error(`Failed to fetch start word: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { word?: string };
  return (data.word || "GAME").toUpperCase();
}

type LeaderboardEntry = { username: string; score: number };

async function fetchLeaderboard(top = 10) {
  const list = document.getElementById("leaderboard-list");
  if (!list) return;

  list.innerHTML = '<div class="leaderboard-item">Loading...</div>';

  try {
    const resp = await fetch(`/api/leaderboard?top=${top}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { entries?: LeaderboardEntry[] };
    // Ensure max 10 entries displayed
    renderLeaderboard((data.entries || []).slice(0, 10));
  } catch (err) {
    console.warn("Failed to load leaderboard:", err);
    list.innerHTML = '<div class="leaderboard-item">No entries yet.</div>';
  }
}

function renderLeaderboard(entries: LeaderboardEntry[]) {
  const list = document.getElementById("leaderboard-list");
  if (!list) return;

  if (entries.length === 0) {
    list.innerHTML = '<div class="leaderboard-item">No entries yet.</div>';
    return;
  }

  list.innerHTML = "";
  entries.forEach((entry, index) => {
    const item = document.createElement("div");
    item.className = "leaderboard-item";

    const rank = document.createElement("div");
    rank.className = "leaderboard-rank";
    if (index === 0) rank.classList.add("champion");
    if (index === 1) rank.classList.add("runner-up");
    if (index === 2) rank.classList.add("third-place");
    rank.textContent = `${index + 1}`;

    const player = document.createElement("div");
    player.className = "leaderboard-player";

    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = formatUsername(entry.username);

    player.appendChild(name);

    const score = document.createElement("div");
    score.className = "player-score";
    score.innerHTML = `${entry.score}<br /><span class=\"score-label\">words</span>`;

    item.appendChild(rank);
    item.appendChild(player);
    item.appendChild(score);
    list.appendChild(item);
  });
}

// ============================================================================
// EVENT LISTENERS FOR SCREEN TRANSITIONS
// ============================================================================

async function startGame() {
  await loadDailyRule();
  stopTimer();
  isGameActive = true;
  wordCount = 0;
  timeRemaining = WORD_TIME_LIMIT;
  usedWords = new Set();
  lastWordLastLetter = "";

  const wordChainEl = document.getElementById("word-chain");
  if (wordChainEl) wordChainEl.innerHTML = "";

  const wordInput = document.getElementById("word-input") as HTMLInputElement;
  if (wordInput) {
    wordInput.value = "";
    wordInput.classList.remove("input-error");
  }

  let startWord = "GAME";
  try {
    startWord = await fetchStartWord();
  } catch (error) {
    console.warn("Failed to fetch start word, using local list:", error);
    try {
      const words = await loadWordList();
      startWord = pickRandomWord(words);
    } catch (fallbackError) {
      console.warn("Using fallback start word:", fallbackError);
    }
  }

  usedWords.add(startWord);
  lastWordLastLetter = getLastLetter(startWord);

  const currentWordDisplay = document.getElementById("current-word-display");
  if (currentWordDisplay) {
    currentWordDisplay.textContent = startWord;
  }

  const nextLetterHint = document.getElementById("next-letter-hint");
  if (nextLetterHint) {
    nextLetterHint.textContent = `Next: ${lastWordLastLetter}____`;
  }

  if (wordChainEl) {
    const chainWord = document.createElement("span");
    chainWord.className = "chain-word";
    chainWord.textContent = `✓ ${startWord}`;
    wordChainEl.appendChild(chainWord);
  }

  updatePointsDisplay();
  showScreen("gameplay");
  const submitButton = document.getElementById(
    "submit-word",
  ) as HTMLButtonElement | null;
  if (submitButton) submitButton.disabled = false;
  startTimer();
}

function setupEventListeners() {
  // Home Screen
  const startButton = document.getElementById("start-game");
  startButton?.addEventListener("click", () => {
    void startGame();
  });

  // Game Over Screen
  const playAgainButton = document.getElementById("play-again-btn");
  playAgainButton?.addEventListener("click", () => {
    void startGame();
  });

  const gameoverLeaderboardButton = document.getElementById(
    "gameover-leaderboard-btn",
  );
  gameoverLeaderboardButton?.addEventListener("click", () => {
    stopTimer();
    showScreen("leaderboard");
  });

  const homeLeaderboardButton = document.getElementById("leaderboard-btn");
  homeLeaderboardButton?.addEventListener("click", () => {
    stopTimer();
    showScreen("leaderboard");
  });

  // Leaderboard Screen
  const playNowButton = document.querySelector(".play-now-btn");
  playNowButton?.addEventListener("click", () => {
    void startGame();
  });

  const homeButtons = document.querySelectorAll(
    ".home-btn",
  ) as NodeListOf<HTMLButtonElement>;
  homeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      stopTimer();
      showScreen("home");
    });
  });

  // Back to Home buttons
  const backButtons = document.querySelectorAll(
    ".back-arrow, .back-link",
  ) as NodeListOf<HTMLElement>;
  backButtons.forEach((button) => {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      stopTimer();
      showScreen("home");
    });
  });

  // Submit word button
  const submitWordButton = document.getElementById("submit-word");
  submitWordButton?.addEventListener("click", () => {
    void submitWord();
  });

  // Allow Enter key to submit word
  const wordInput = document.getElementById("word-input") as HTMLInputElement;
  wordInput?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      void submitWord();
    }
  });
}

// ============================================================================
// GAME INITIALIZATION
// ============================================================================

/**
 * Fetch initial player data from the server
 */
async function initializeGame() {
  try {
    const response = await fetch("/api/init");
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = (await response.json()) as InitResponse;
    if (data.type === "init") {
      await loadDailyRule();
      // Update player info across all screens
      const playerNameElements = document.querySelectorAll(
        "#player-username, #gameplay-username, #gameover-username",
      );
      playerNameElements.forEach((el) => {
        el.textContent = formatUsername(data.username);
      });

      const pointsElements = document.querySelectorAll(
        "#player-points, #gameplay-points, #gameover-points",
      );
      pointsElements.forEach((el) => {
        el.textContent = data.count?.toString() || "0";
      });

      // Initialize to home screen
      // Prefer sessionStorage signal from splash
      try {
        const nextSession = sessionStorage.getItem("lw_nextScreen");
        const nextLocal = localStorage.getItem("lw_nextScreen");
        const next = nextSession || nextLocal;
        if (next === "leaderboard") {
          sessionStorage.removeItem("lw_nextScreen");
          localStorage.removeItem("lw_nextScreen");
          showScreen("leaderboard");
        } else {
          const params = new URLSearchParams(window.location.search);
          const requested = params.get("screen");
          if (requested === "leaderboard") {
            showScreen("leaderboard");
          } else if (
            requested === "game" ||
            requested === "gameplay" ||
            requested === "play"
          ) {
            // Start a fresh play session
            void startGame();
          } else {
            showScreen("home");
          }
        }
      } catch (e) {
        showScreen("home");
      }

      // Make sure points reflect current (new) game state
      updatePointsDisplay();
    } else {
      console.error("Invalid response type from /api/init", data);
    }
  } catch (error) {
    console.error("Error initializing game:", error);
  }
}

/**
 * Persist player's final score to the server daily leaderboard
 */
async function persistScore(score: number) {
  try {
    await fetch("/api/submit-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ score }),
    });
  } catch (error) {
    console.error("Error persisting score:", error);
    throw error;
  }
}

// Initialize event listeners and the game once the DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    setupEventListeners();
    initializeGame();
  });
} else {
  setupEventListeners();
  initializeGame();
}
