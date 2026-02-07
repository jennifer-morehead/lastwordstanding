import {
  IncrementResponse,
  DecrementResponse,
  InitResponse,
} from "../../shared/types/api";
import { navigateTo } from "@devvit/web/client";

// ============================================================================
// GAME STATE SYSTEM
// ============================================================================

type GameScreen = "home" | "gameplay" | "gameover" | "leaderboard";

let currentState: GameScreen = "home";

/**
 * Show a specific screen and hide all others
 */
function showScreen(screen: GameScreen) {
  currentState = screen;
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
  console.log(`Screen changed to: ${currentState}`);
}

// ============================================================================
// TIMER MANAGEMENT
// ============================================================================

const WORD_TIME_LIMIT = 7; // seconds per word

let timeRemaining = WORD_TIME_LIMIT;
let timerInterval: NodeJS.Timeout | null = null;
let wordCount = 0;
let gameOverReason = "";
let usedWords: Set<string> = new Set(); // Track words to prevent repeats
let lastWordLastLetter = ""; // Track the letter the next word must start with

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
    if (upperWord.endsWith("S")) {
      return {
        valid: false,
        error: "❌ No words ending in 'S' (today's rule!)",
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
  if (upperWord.endsWith("S")) {
    return {
      valid: false,
      error: "❌ No words ending in 'S' (today's rule!)",
    };
  }

  return { valid: true, error: null };
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
  if (timerElement) {
    timerElement.textContent = `${timeRemaining}s`;
    // Change color to red when time is running out
    if (timeRemaining <= 3) {
      timerElement.style.color = "#ef4444";
      // Prefer sessionStorage signal set by the splash to indicate which screen
      try {
        const next = sessionStorage.getItem("lw_nextScreen");
        if (next === "leaderboard") {
          sessionStorage.removeItem("lw_nextScreen");
          showScreen("leaderboard");
        } else {
          // Fallback to URL param if present
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
            wordCount = 0;
            usedWords = new Set();
            lastWordLastLetter = "";
            const wordChain = document.getElementById("word-chain");
            if (wordChain) wordChain.innerHTML = "";
            showScreen("gameplay");
            startTimer();
          } else {
            showScreen("home");
          }
        }
      } catch (e) {
        showScreen("home");
      }
    }
  }
}

// GAME LOGIC
// ============================================================================

/**
 * End the game and transition to game over screen
 */
function endGame(reason: string) {
  stopTimer();
  gameOverReason = reason;

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
}

/**
 * Handle word submission
 */
function submitWord() {
  const input = document.getElementById("word-input") as HTMLInputElement;
  const word = input?.value.trim();

  if (!word) return;

  // Validate the word
  const validation = validateWord(word);
  if (!validation.valid) {
    showError(validation.error || "Invalid word");
    return;
  }

  const upperWord = word.toUpperCase();

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

// ============================================================================
// EVENT LISTENERS FOR SCREEN TRANSITIONS
// ============================================================================

function setupEventListeners() {
  // Home Screen
  const startButton = document.getElementById("start-game");
  startButton?.addEventListener("click", () => {
    // Reset game state
    wordCount = 0;
    timeRemaining = WORD_TIME_LIMIT;
    usedWords = new Set();
    lastWordLastLetter = "";

    const wordChain = document.getElementById("word-chain");
    if (wordChain) wordChain.innerHTML = "";

    const wordInput = document.getElementById("word-input") as HTMLInputElement;
    if (wordInput) {
      wordInput.value = "";
      wordInput.classList.remove("input-error");
    }

    // Reset current word display
    const currentWordDisplay = document.getElementById("current-word-display");
    if (currentWordDisplay) {
      currentWordDisplay.textContent = "GAME";
    }

    // Reset next letter hint
    const nextLetterHint = document.getElementById("next-letter-hint");
    if (nextLetterHint) {
      nextLetterHint.textContent = "Next: ____";
    }

    // Update points UI after reset
    updatePointsDisplay();

    // Start the game
    showScreen("gameplay");
    startTimer();
  });

  // Game Over Screen
  const playAgainButton = document.getElementById("play-again-btn");
  playAgainButton?.addEventListener("click", () => {
    stopTimer();
    // Reset and go back to home (user will click start again)
    showScreen("home");
  });

  const gameoverLeaderboardButton = document.getElementById(
    "gameover-leaderboard-btn",
  );
  gameoverLeaderboardButton?.addEventListener("click", () => {
    stopTimer();
    showScreen("leaderboard");
  });

  // Leaderboard Screen
  const playNowButton = document.querySelector(".play-now-btn");
  playNowButton?.addEventListener("click", () => {
    stopTimer();
    showScreen("home");
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
    submitWord();
  });

  // Allow Enter key to submit word
  const wordInput = document.getElementById("word-input") as HTMLInputElement;
  wordInput?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      submitWord();
    }
  });
}

// ============================================================================
// GAME INITIALIZATION
// ============================================================================

let currentPostId: string | null = null;

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
      currentPostId = data.postId;

      // Update player info across all screens
      const playerNameElements = document.querySelectorAll(
        "#player-username, #gameplay-username, #gameover-username",
      );
      playerNameElements.forEach((el) => {
        el.textContent = data.username || "u/player123";
      });

      const pointsElements = document.querySelectorAll(
        "#player-points, #gameplay-points, #gameover-points",
      );
      pointsElements.forEach((el) => {
        el.textContent = data.count?.toString() || "0";
      });

      // Initialize to home screen
      // Determine if splash requested a specific screen via query param
      try {
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
          wordCount = 0;
          usedWords = new Set();
          lastWordLastLetter = "";
          const wordChain = document.getElementById("word-chain");
          if (wordChain) wordChain.innerHTML = "";
          showScreen("gameplay");
          startTimer();
        } else {
          showScreen("home");
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

// Initialize the game when the page loads
initializeGame();

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
