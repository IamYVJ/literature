// ============================================================================
// botdriver.js — Turning "it is a bot's turn" into a move, at a human pace.
//
// WHY THIS IS NOT IN bots.js
//   js/bots.js imports ONLY js/cards.js, and scripts/test-bots.mjs greps the
//   module's own source to keep it that way. That rule is what makes it
//   structurally impossible for a bot to reach the engine and peek at a hand:
//   there is no import to reach it through. Driving a bot needs the engine
//   (PHASES) and the dispatcher (applyGameIntent), so the driver lives here and
//   the inference stays sealed.
//
// WHY IT IS NOT IN main.js EITHER, WHERE IT USED TO BE
//   There are now two machines that own a GameEngine: the P2P host's browser tab
//   (js/main.js) and the server (server/rooms.js). Bot pacing, the AskMemory
//   lifecycle and the away-seat rule are all subtle enough that a second copy
//   would drift — and the way it would show is a bot on the Pi remembering
//   something a bot in a browser had forgotten. One module, two callers.
//
// NO TIMERS IN HERE
//   Same rule state.js follows. The driver is TICKED by whoever owns the engine —
//   main.js's 500ms interval, the server's 1s one — and `now` arrives as an
//   argument, so a test can drive a whole game without waiting for any of it.
// ============================================================================

import { PHASES } from './state.js';
import { applyGameIntent } from './intents.js';
import { AskMemory, AWAY_PLAY_MS, BOT_THINK_MS, chooseBotMove } from './bots.js';

/**
 * A bot never moves inside the last stretch of a timed turn. Without this the
 * pause itself could run a seat out of time on a short clock, and a bot losing
 * turns to its own politeness reads as "the bots stopped playing".
 */
const MIN_LEAD_MS = 1000;

/**
 * A seat nobody is sitting in is played like a bot seat.
 *
 * Otherwise one closed tab stops the game for everybody: the engine only ever
 * advances the turn on a move or on the clock, and the clock is off unless the
 * table turned it on. Whoever owns the engine holds every hand, so it can play
 * the empty chair itself.
 */
const unattended = (p) => !!p && (p.isBot || !p.online);

/**
 * One driver per game.
 *
 * The state it holds is the table's shared memory of what was said out loud,
 * plus "which turn am I pausing on". Neither is ever serialised: a host reload
 * rebuilds the memory from the engine's own record (see observe()) and the worst
 * a crash mid-pause costs is that a bot thinks for a second again.
 */
export function createBotDriver({ thinkMs = BOT_THINK_MS, awayMs = AWAY_PLAY_MS } = {}) {
  // Shared by every bot at the table, because everything in it is a public fact.
  // Each bot's private knowledge arrives separately, in privateStateFor().
  const memory = new AskMemory();
  let seenAsks = 0;
  let seenClaims = 0;
  let pending = null;

  /**
   * Tell the bots what the table just heard.
   *
   * Read off the ENGINE rather than publicState(), because config.showHistory
   * can blank the record and that setting is about what a PERSON is shown, not
   * about what anyone remembers. A player at a real table still heard the
   * question, and the bots are held to the same standard.
   *
   * A fresh deal is detected here rather than being announced by the caller: the
   * two counters only ever climb during a game, so either of them going
   * backwards means startGame() has re-dealt. Detecting it beats being told,
   * because a caller that forgets to say so leaves the bots holding certainties
   * about the previous hand — which is worse than knowing nothing.
   */
  function observe(engine) {
    if (!engine) return;
    if (engine.askCount < seenAsks || engine.claims.length < seenClaims) {
      memory.reset();
      seenAsks = 0;
      seenClaims = 0;
      pending = null;
    }
    for (const c of engine.claims.slice(seenClaims)) memory.observeClaim(c);
    seenClaims = engine.claims.length;
    for (const h of engine.history) if (h.n > seenAsks) memory.observeAsk(h);
    seenAsks = engine.askCount;
  }

  return {
    /** Exposed for tests and for a caller that wants to inspect the deduction. */
    memory,

    observe,

    /** Forget everything. For an engine that has just been handed over. */
    reset() {
      memory.reset();
      seenAsks = 0;
      seenClaims = 0;
      pending = null;
    },

    /**
     * Let the seat on turn move, if it is unattended and its pause is up.
     *
     * @returns true when the engine changed and the caller should broadcast.
     */
    tick(engine, now = Date.now()) {
      if (!engine || engine.phase !== PHASES.PLAY) { pending = null; return false; }

      // Before deciding, not after: the move about to be chosen has to be made
      // in light of the ask that just happened.
      observe(engine);

      const player = engine.turnPlayer;
      if (!unattended(player)) { pending = null; return false; }

      // askCount and the claim count are in the key because a HIT KEEPS THE
      // TURN in Literature — the seat index does not change between two asks by
      // the same player, so keying on the seat alone would give one bot a single
      // pause and then let it empty the table in one indistinguishable blur.
      // With them, every question gets its own beat and reads as a separate act.
      const key = `${engine.turn}:${player.id}:${engine.askCount}:${engine.claims.length}`;
      if (!pending || pending.key !== key) {
        // An away human gets the longer pause: a phone that drops Wi-Fi for a
        // moment should not cost somebody their turn.
        const wait = player.isBot ? thinkMs : awayMs;
        pending = { key, dueAt: dueFor(engine, now, wait), acted: false };
      }
      if (pending.acted || now < pending.dueAt) return false;

      // Set before acting, not after. Whatever happens below — a refusal, a
      // throw — this turn-step gets exactly one attempt, so a bot that cannot be
      // satisfied costs one tick rather than spinning for as long as the game
      // is allowed to run.
      pending.acted = true;
      return act(engine, player, memory);
    },
  };
}

function dueFor(engine, now, wait) {
  const due = now + wait;
  const deadline = engine.turnEndsAt;
  if (deadline == null) return due;
  // Never later than MIN_LEAD_MS before the deadline, and never in the past — on
  // a clock already almost gone that resolves to "move on this tick".
  return Math.min(due, Math.max(now, deadline - MIN_LEAD_MS));
}

function act(engine, player, memory) {
  let move = null;
  try {
    move = chooseBotMove(memory, engine.publicState(), engine.privateStateFor(player.id));
  } catch (err) {
    // A throw in here is a bug in the inference, and the right response is still
    // to get the turn moving — a table stuck behind a bot is a dead game.
    console.warn('[bot] chooseBotMove threw', err);
  }

  // null means there is no unclaimed set left to name, which is already game
  // over and was caught by the phase check above. There is deliberately no
  // last-resort "skip" the way Sequence has one: chooseBotMove's final branch
  // always returns a CLAIM, and a claim resolves its set whether it is right or
  // wrong — so the game moves on by construction rather than by a fallback.
  if (!move) return false;

  const res = applyGameIntent(engine, player.id, move);
  if (res && res.ok) return true;
  console.warn('[bot] move refused:', res && res.error, move);
  return false;
}
