import {
  AnalyticsEventRequest,
  AnalyticsSummaryResponse,
  EndRunScoreRequest,
  EndRunScoreResponse,
  InitResponse,
  LeaderboardResponse,
  ScoreBreakdown,
} from "../../shared/types/api";
import wordListData from "word-list-json/words.json";

// Build a Set for O(1) lookups - filter to reasonable game words (2-10 letters)
const validWords = new Set<string>(
  (wordListData.words as string[])
    .filter((w: string) => w.length >= 2 && w.length <= 10)
    .map((w: string) => w.toUpperCase()),
);

type DailyRuleResponse = { letter?: string };

const ADMIN_USERNAME = "theotherchupe";

let currentRuleLetter = "S";
let ruleLoaded = false;
let cachedWordList: string[] | null = null;

function formatUsername(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "u/player123";
  if (/^u\//i.test(trimmed)) return trimmed;
  return `u/${trimmed}`;
}

function normalizeUsername(name: string | null | undefined): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^u\//, "");
}

function isAdminUsername(name: string | null | undefined): boolean {
  return normalizeUsername(name) === ADMIN_USERNAME;
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

type GameScreen = "home" | "gameplay" | "gameover" | "leaderboard" | "scoring";

/**
 * Show a specific screen and hide all others
 */
function showScreen(screen: GameScreen) {
  const screens = [
    "home-screen",
    "gameplay-screen",
    "gameover-screen",
    "leaderboard-screen",
    "scoring-screen",
  ];

  screens.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = id === `${screen}-screen` ? "block" : "none";
  });

  if (screen === "leaderboard") {
    fetchLeaderboard();
  }

  if (screen === "home" && isAdminUser) {
    void loadAdminAnalytics();
  }
}

// ============================================================================
// TIMER MANAGEMENT
// ============================================================================

const WORD_TIME_LIMIT = 7; // seconds per word
const COMPUTER_DELAY_MIN_MS = 600;
const COMPUTER_DELAY_MAX_MS = 1400;
const KEYBOARD_LAYOUT = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM⌫"];

let timeRemaining = WORD_TIME_LIMIT;
let timerInterval: NodeJS.Timeout | null = null;
let wordCount = 0;
let usedWords: Set<string> = new Set(); // Track words to prevent repeats
let lastWordLastLetter = ""; // Track the letter the next word must start with
let isGameActive = false;
let isComputerThinking = false;
let gameSessionToken = 0;
let isVirtualKeyboardMode = false;
let virtualKeyboardButtons: HTMLButtonElement[] = [];
let playerSubmittedWords: string[] = [];
let lastAcceptedWord = "";
let playerTurnStartedAt: number | null = null;
let playerSubmitDurationsMs: number[] = [];
let isAdminUser = false;

function setAdminPanelVisibility(visible: boolean) {
  const panel = document.getElementById("admin-panel");
  if (!panel) return;

  panel.hidden = !visible;
  panel.classList.toggle("is-visible", visible);
}

function updateAdminPanelStatus(text: string) {
  const status = document.getElementById("admin-panel-status");
  if (status) {
    status.textContent = text;
  }
}

function formatAverageSubmitTime(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderAnalyticsSummary(summary: AnalyticsSummaryResponse) {
  const gameOpens = document.getElementById("analytics-game-opens");
  const playClicks = document.getElementById("analytics-play-clicks");
  const repeatPlayers = document.getElementById("analytics-repeat-players");
  const averageWords = document.getElementById("analytics-average-words");
  const averageSubmit = document.getElementById("analytics-average-submit");
  const topWords = document.getElementById("analytics-top-words");

  if (gameOpens) gameOpens.textContent = `${summary.gameOpens}`;
  if (playClicks) playClicks.textContent = `${summary.playClicks}`;
  if (repeatPlayers) repeatPlayers.textContent = `${summary.repeatPlayers}`;
  if (averageWords) {
    averageWords.textContent = summary.averageWordsPerPlayer.toFixed(1);
  }
  if (averageSubmit) {
    averageSubmit.textContent = formatAverageSubmitTime(
      summary.averageSubmitTimeMs,
    );
  }

  if (topWords) {
    if (summary.mostCommonWords.length === 0) {
      topWords.textContent = "No data yet.";
    } else {
      topWords.textContent = summary.mostCommonWords
        .map((entry) => `${entry.word} (${entry.count})`)
        .join(" • ");
    }
  }

  updateAdminPanelStatus("Metrics are for this post only.");
}

async function fetchAnalyticsSummary() {
  const response = await fetch("/api/analytics/summary");
  if (!response.ok) {
    throw new Error(
      `Failed to load analytics summary: HTTP ${response.status}`,
    );
  }

  return (await response.json()) as AnalyticsSummaryResponse;
}

async function loadAdminAnalytics() {
  if (!isAdminUser) return;

  updateAdminPanelStatus("Loading analytics...");

  try {
    const summary = await fetchAnalyticsSummary();
    renderAnalyticsSummary(summary);
  } catch (error) {
    console.warn("Failed to load analytics summary:", error);
    updateAdminPanelStatus("Metrics unavailable right now.");
  }
}

async function trackAnalyticsEvent(event: AnalyticsEventRequest["event"]) {
  const payload: AnalyticsEventRequest = { event };

  try {
    await fetch("/api/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("Failed to track analytics event:", error);
  }
}

function getChainBonus(basePoints: number): number {
  if (basePoints >= 10) return 2;
  if (basePoints >= 5) return 1;
  return 0;
}

function getLocalScoreBreakdown(basePoints: number): ScoreBreakdown {
  const chainBonus = getChainBonus(basePoints);
  return {
    basePoints,
    chainBonus,
    rareWordBonus: 0,
    totalPoints: basePoints + chainBonus,
  };
}

function updateScoreBreakdownDisplay(breakdown: ScoreBreakdown) {
  const baseEl = document.getElementById("breakdown-base");
  const chainEl = document.getElementById("breakdown-chain");
  const rareEl = document.getElementById("breakdown-rare");
  const totalEl = document.getElementById("breakdown-total");

  if (baseEl) baseEl.textContent = `${breakdown.basePoints}`;
  if (chainEl) chainEl.textContent = `+${breakdown.chainBonus}`;
  if (rareEl) rareEl.textContent = `+${breakdown.rareWordBonus}`;
  if (totalEl) totalEl.textContent = `${breakdown.totalPoints}`;
}

function updateEndingWordDisplay(word: string) {
  const endingWordEl = document.getElementById("ending-word");
  if (endingWordEl) {
    endingWordEl.textContent = word;
  }
}
function resetGameOverFeedback() {
  updateScoreBreakdownDisplay(getLocalScoreBreakdown(0));
  updateEndingWordDisplay("-");
}

async function fetchEndRunScore(
  playerWords: string[],
  endingWord: string,
): Promise<EndRunScoreResponse> {
  const payload: EndRunScoreRequest = {
    playerWords,
    endingWord,
    submitDurationsMs: [...playerSubmitDurationsMs],
  };

  const response = await fetch("/api/end-run-score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to calculate end-run score: HTTP ${response.status}`,
    );
  }

  return (await response.json()) as EndRunScoreResponse;
}

async function finalizeRunScore(
  sessionToken: number,
  playerWords: string[],
  endingWord: string,
) {
  let breakdown = getLocalScoreBreakdown(playerWords.length);
  let resolvedEndingWord = endingWord;

  try {
    const response = await fetchEndRunScore(playerWords, endingWord);
    breakdown = response.breakdown;
    resolvedEndingWord = response.endingWord || endingWord;
  } catch (error) {
    console.warn("Falling back to local end-run score:", error);
  }

  persistScore(breakdown.totalPoints).catch((err) => {
    console.warn("Failed to persist score:", err);
  });

  if (sessionToken !== gameSessionToken) {
    return;
  }

  updateScoreBreakdownDisplay(breakdown);
  updateEndingWordDisplay(resolvedEndingWord);
  updatePointsDisplay(breakdown.totalPoints);
}

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

  // Check if word starts with the required letter when there is one
  if (lastWordLastLetter && !upperWord.startsWith(lastWordLastLetter)) {
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

function setInputEnabled(enabled: boolean) {
  const input = document.getElementById(
    "word-input",
  ) as HTMLInputElement | null;
  const submitButton = document.getElementById(
    "submit-word",
  ) as HTMLButtonElement | null;

  if (input) input.disabled = !enabled;
  if (submitButton) submitButton.disabled = !enabled;
  setVirtualKeyboardEnabled(enabled);
}

function isLikelyMobileDevice(): boolean {
  return window.matchMedia("(max-width: 900px) and (pointer: coarse)").matches;
}

function setVirtualKeyboardEnabled(enabled: boolean) {
  virtualKeyboardButtons.forEach((button) => {
    button.disabled = !enabled;
  });

  const keyboard = document.getElementById("virtual-keyboard");
  if (keyboard) {
    keyboard.classList.toggle("is-disabled", !enabled);
  }
}

function applyVirtualKeyboardMode() {
  isVirtualKeyboardMode = isLikelyMobileDevice();

  const keyboard = document.getElementById("virtual-keyboard");
  const input = document.getElementById(
    "word-input",
  ) as HTMLInputElement | null;
  if (keyboard) {
    keyboard.classList.toggle("is-active", isVirtualKeyboardMode);
  }

  if (!input) return;

  if (isVirtualKeyboardMode) {
    input.readOnly = true;
    input.setAttribute("inputmode", "none");
    input.setAttribute("spellcheck", "false");
  } else {
    input.readOnly = false;
    input.removeAttribute("inputmode");
    input.removeAttribute("spellcheck");
  }
}

function appendLetterToInput(letter: string) {
  const input = document.getElementById(
    "word-input",
  ) as HTMLInputElement | null;
  if (!input || input.disabled) return;

  input.value = `${input.value}${letter}`;
  input.classList.remove("input-error");
}

function deleteLastLetterFromInput() {
  const input = document.getElementById(
    "word-input",
  ) as HTMLInputElement | null;
  if (!input || input.disabled || input.value.length === 0) return;

  input.value = input.value.slice(0, -1);
  input.classList.remove("input-error");
}

function clearInputValue() {
  const input = document.getElementById(
    "word-input",
  ) as HTMLInputElement | null;
  if (!input || input.disabled || input.value.length === 0) return;

  input.value = "";
  input.classList.remove("input-error");
}

function createKeyButton(label: string, ariaLabel: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "keyboard-key";
  button.textContent = label;
  button.setAttribute("aria-label", ariaLabel);
  return button;
}

function setupVirtualKeyboard() {
  const keyboard = document.getElementById("virtual-keyboard");
  if (!keyboard) return;

  keyboard.innerHTML = "";
  virtualKeyboardButtons = [];

  const rowClasses = ["keyboard-row-10", "keyboard-row-9", "keyboard-row-8"];

  KEYBOARD_LAYOUT.forEach((rowLetters, rowIndex) => {
    const row = document.createElement("div");
    row.className = `keyboard-row ${rowClasses[rowIndex]}`;

    rowLetters.split("").forEach((letter) => {
      const isBackspace = letter === "⌫";
      const key = createKeyButton(
        letter,
        isBackspace ? "Delete last letter" : `Letter ${letter}`,
      );

      if (isBackspace) {
        key.classList.add("keyboard-key-secondary");
        key.addEventListener("click", () => {
          deleteLastLetterFromInput();
        });
      } else {
        key.addEventListener("click", () => {
          appendLetterToInput(letter);
        });
      }

      virtualKeyboardButtons.push(key);
      row.appendChild(key);
    });

    keyboard.appendChild(row);
  });

  const actionRow = document.createElement("div");
  actionRow.className = "keyboard-row keyboard-row-actions";

  const clearKey = createKeyButton("CLEAR", "Clear current input");
  clearKey.classList.add("keyboard-key-secondary");
  clearKey.addEventListener("click", () => {
    clearInputValue();
  });

  const submitKey = createKeyButton("SUBMIT", "Submit current word");
  submitKey.classList.add("keyboard-key-action");
  submitKey.addEventListener("click", () => {
    void submitWord();
  });

  actionRow.appendChild(clearKey);
  actionRow.appendChild(submitKey);
  virtualKeyboardButtons.push(clearKey, submitKey);
  keyboard.appendChild(actionRow);

  applyVirtualKeyboardMode();
}

function updateNextLetterHint(requiredLetter: string) {
  const nextLetterHint = document.getElementById("next-letter-hint");
  if (nextLetterHint) {
    nextLetterHint.textContent = `Next: ${requiredLetter}____`;
  }
}

function showComputerThinking() {
  const nextLetterHint = document.getElementById("next-letter-hint");
  if (nextLetterHint) {
    nextLetterHint.textContent = "Computer is thinking...";
  }
}

function appendChainWord(
  word: string,
  source: "player" | "computer" | "start",
) {
  const wordChain = document.getElementById("word-chain");
  if (!wordChain) return;

  const chainWord = document.createElement("span");
  chainWord.className = "chain-word";

  if (source === "computer" || source === "start") {
    chainWord.classList.add("chain-word-computer");
    chainWord.textContent = `🤖 ${word}`;
  } else {
    chainWord.textContent = `✓ ${word}`;
  }

  wordChain.appendChild(chainWord);
  wordChain.scrollLeft = wordChain.scrollWidth;
}

function getComputerDelayMs(): number {
  const spread = COMPUTER_DELAY_MAX_MS - COMPUTER_DELAY_MIN_MS;
  return COMPUTER_DELAY_MIN_MS + Math.floor(Math.random() * (spread + 1));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pickComputerWord(requiredLetter: string): string | null {
  const upperLetter = requiredLetter.toUpperCase();
  const candidates: string[] = [];

  for (const candidate of validWords) {
    if (!candidate.startsWith(upperLetter)) continue;
    if (candidate.endsWith(currentRuleLetter)) continue;
    if (usedWords.has(candidate)) continue;
    candidates.push(candidate);
  }

  if (candidates.length === 0) return null;
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index] ?? null;
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
  isComputerThinking = false;
  playerTurnStartedAt = null;
  gameSessionToken += 1;
  const sessionToken = gameSessionToken;
  stopTimer();

  const basePoints = playerSubmittedWords.length;
  const endingWord = (
    lastAcceptedWord ||
    playerSubmittedWords[playerSubmittedWords.length - 1] ||
    "N/A"
  ).toUpperCase();
  const optimisticBreakdown = getLocalScoreBreakdown(basePoints);

  // Update game over screen
  const finalWordCountElement = document.getElementById("final-word-count");
  if (finalWordCountElement) {
    finalWordCountElement.textContent = `${basePoints} ${
      basePoints === 1 ? "word" : "words"
    }`;
  }

  const gameoverReasonElement = document.getElementById("gameover-reason");
  if (gameoverReasonElement) {
    gameoverReasonElement.innerHTML = `<span>${reason}</span>`;
  }

  updateEndingWordDisplay(endingWord);
  updateScoreBreakdownDisplay(optimisticBreakdown);

  // Ensure points shown on game over
  updatePointsDisplay(optimisticBreakdown.totalPoints);

  // Transition to game over screen
  showScreen("gameover");

  setInputEnabled(false);

  void finalizeRunScore(sessionToken, [...playerSubmittedWords], endingWord);
}

/**
 * Handle word submission
 */
async function submitWord() {
  if (!isGameActive || isComputerThinking) return;
  const input = document.getElementById("word-input") as HTMLInputElement;
  if (!input || input.disabled) return;
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
  playerSubmittedWords.push(upperWord);
  lastAcceptedWord = upperWord;

  if (playerTurnStartedAt !== null) {
    playerSubmitDurationsMs.push(Math.max(0, Date.now() - playerTurnStartedAt));
  }

  const requiredComputerStart = getLastLetter(upperWord);
  // During computer turn, this is the required start letter.
  lastWordLastLetter = requiredComputerStart;

  // Increment word count (points)
  wordCount++;
  // Update points UI
  updatePointsDisplay();

  // Add to chain display
  appendChainWord(upperWord, "player");

  // Clear input
  if (input) input.value = "";

  // Update current word display
  const currentWordDisplay = document.getElementById("current-word-display");
  if (currentWordDisplay) {
    currentWordDisplay.textContent = upperWord;
  }

  // Computer turn starts: pause timer and lock inputs.
  stopTimer();
  isComputerThinking = true;
  setInputEnabled(false);
  showComputerThinking();

  const activeSession = gameSessionToken;
  await wait(getComputerDelayMs());

  if (!isGameActive || activeSession !== gameSessionToken) {
    return;
  }

  const computerWord = pickComputerWord(requiredComputerStart);
  if (!computerWord) {
    isComputerThinking = false;
    endGame("Computer is out of words. You win! 🎉");
    return;
  }

  usedWords.add(computerWord);
  lastWordLastLetter = getLastLetter(computerWord);
  lastAcceptedWord = computerWord;

  appendChainWord(computerWord, "computer");

  if (currentWordDisplay) {
    currentWordDisplay.textContent = computerWord;
  }

  updateNextLetterHint(lastWordLastLetter);
  isComputerThinking = false;
  setInputEnabled(true);
  playerTurnStartedAt = Date.now();
  if (!isVirtualKeyboardMode) {
    input.focus();
  }
  startTimer();
}

/**
 * Update points display across all screens
 */
function updatePointsDisplay(points = wordCount) {
  const pointsElements = document.querySelectorAll(
    "#player-points, #gameplay-points, #gameover-points",
  );
  pointsElements.forEach((el) => {
    el.textContent = points.toString();
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

type LeaderboardEntry = LeaderboardResponse["entries"][number];

async function fetchLeaderboard(top = 10) {
  const list = document.getElementById("leaderboard-list");
  if (!list) return;

  list.innerHTML = '<div class="leaderboard-item">Loading...</div>';

  try {
    const resp = await fetch(`/api/leaderboard?top=${top}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as LeaderboardResponse;
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
    score.textContent = `${entry.score}`;

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
  gameSessionToken += 1;
  void trackAnalyticsEvent("play_click");
  await loadDailyRule();
  stopTimer();
  isGameActive = true;
  isComputerThinking = false;
  wordCount = 0;
  timeRemaining = WORD_TIME_LIMIT;
  usedWords = new Set();
  lastWordLastLetter = "";
  playerSubmittedWords = [];
  lastAcceptedWord = "";
  playerTurnStartedAt = null;
  playerSubmitDurationsMs = [];

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
  lastAcceptedWord = startWord;

  const currentWordDisplay = document.getElementById("current-word-display");
  if (currentWordDisplay) {
    currentWordDisplay.textContent = startWord;
  }

  const nextLetterHint = document.getElementById("next-letter-hint");
  if (nextLetterHint) updateNextLetterHint(lastWordLastLetter);

  appendChainWord(startWord, "start");
  resetGameOverFeedback();

  updatePointsDisplay();
  showScreen("gameplay");
  setInputEnabled(true);
  playerTurnStartedAt = Date.now();
  if (!isVirtualKeyboardMode) {
    wordInput?.focus();
  }
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

  const scoringButton = document.getElementById("scoring-btn");
  scoringButton?.addEventListener("click", () => {
    stopTimer();
    showScreen("scoring");
  });

  // Leaderboard and scoring screens
  const playNowButtons = document.querySelectorAll(
    ".play-now-btn",
  ) as NodeListOf<HTMLButtonElement>;
  playNowButtons.forEach((button) => {
    button.addEventListener("click", () => {
      void startGame();
    });
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
  wordInput?.addEventListener("focus", () => {
    if (isVirtualKeyboardMode) {
      wordInput.blur();
    }
  });
  wordInput?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      void submitWord();
    }
  });

  setupVirtualKeyboard();
  applyVirtualKeyboardMode();
  window.addEventListener("resize", applyVirtualKeyboardMode);
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
      isAdminUser = isAdminUsername(data.username);
      setAdminPanelVisibility(isAdminUser);
      if (isAdminUser) {
        updateAdminPanelStatus("Loading analytics...");
      }

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
