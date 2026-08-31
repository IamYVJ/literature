// ============================================================================
// rules.js — ALL Literature rule constants + pure logic.
//
// THE GAME. Two teams sit alternating around the table, so your neighbours are
// always opponents. Everyone is dealt a hand from a 48-card deck (the 8s are
// out; see EIGHTS below for the house rule that keeps them). On your turn you
// ask ONE named opponent for ONE named card:
//
//   - You must already hold a card of that card's SET (its half-suit).
//   - You must not already hold the card you ask for.
//   - The opponent must be on the other team and must still hold cards.
//
// If they have it they hand it over and you ask again. If they don't, the turn
// passes to them. Nothing is hidden about the asking itself — the whole table
// hears every question and every answer, and that public record is the game.
// (In person you remember it; here js/state.js keeps a `history` so the log is
// a memory aid rather than an advantage to whoever is paying most attention.)
//
// You win sets, not cards. When your team collectively holds all six cards of a
// set, someone on the team CLAIMS it by naming who holds what, exactly. Get it
// right and your team banks the set; get it wrong and by default the other team
// banks it instead. First team to a majority of the sets wins — 5 of 8, or 5 of
// 9 when the eights are in play, which is the tidy reason to enable them: with
// 8 sets a 4-4 draw is possible, with 9 it never is.
//
// Everything above is the standard game, and it is what every DEFAULT in here
// says. The host may layer house rules on top (see DEFAULTS and PRESETS); the
// pure functions below take those as an optional `config` and behave exactly as
// the standard game does when it is absent, so official play is never the
// special case.
//
// This module is pure: constants and functions over plain data. The
// host-authoritative state machine lives in state.js.
// ============================================================================

import {
  ALL_SETS, HALF_SUIT_SETS, EIGHTS, SET_CARDS, setCards, setOf, setsHeld,
} from './cards.js';

// ---- Teams -----------------------------------------------------------------
// Literature is always two teams. Unlike Sequence there is no three-team
// variant: the ask must have an "other side", and claims are banked per side.
export const NUM_TEAMS = 2;

export const TEAM_THEMES = Object.freeze([
  Object.freeze({ name: 'Ink', color: '#4C8FD6', ink: '#0A1826' }),
  Object.freeze({ name: 'Rust', color: '#D2643C', ink: '#2A0F08' }),
]);

export function teamName(team) { return TEAM_THEMES[team]?.name || `Team ${team + 1}`; }
export function teamColor(team) { return TEAM_THEMES[team]?.color || '#888888'; }

/**
 * Teammates sit apart. Seat 0,2,4… are one team and 1,3,5… the other, so every
 * player's immediate neighbours are opponents — which is the whole point, since
 * you spend the game asking the people beside you.
 */
export function teamOfSeat(seat) { return seat % NUM_TEAMS; }

// ---- House rules -----------------------------------------------------------
export const PLAYER_COUNTS = Object.freeze([4, 6, 8]);

export const DEFAULTS = Object.freeze({
  /** Seats at the table. Must divide the deck evenly, hence 4, 6 or 8. */
  numPlayers: 6,

  /** House rule: keep the four 8s in as a ninth set. Makes a draw impossible.
   *  With 6 or 8 players 52 does not divide evenly, so four players are dealt
   *  one extra card — dealCounts() spreads those so the TEAMS stay level. */
  eightsAsSet: false,

  /** Standard. Turning this off lets you ask for a card in any set, which
   *  removes almost all of the deduction and is only here for a silly game. */
  mustHoldSetToAsk: true,

  /** Standard in most house games: a claim is an interrupt, not a turn action.
   *  Off means you may only claim when it is your turn to ask. */
  claimAnyTime: true,

  /** Standard: a botched claim hands the set to the other team. Off means the
   *  set is simply voided and nobody scores it, which can force a draw. */
  wrongClaimAwardsOpponent: true,

  /** Seconds per ask, 0 for no clock. A timed-out turn passes to the left. */
  turnSeconds: 0,

  /** Show the running record of asks. Off is "play it from memory", which is
   *  the in-person game but brutal on a phone. */
  showHistory: true,
});

export const PRESETS = Object.freeze({
  standard: Object.freeze({ label: 'Standard 6', patch: Object.freeze({ numPlayers: 6, eightsAsSet: false }) }),
  decisive: Object.freeze({ label: 'No draws (9 sets)', patch: Object.freeze({ numPlayers: 6, eightsAsSet: true }) }),
  small: Object.freeze({ label: 'Four players', patch: Object.freeze({ numPlayers: 4, eightsAsSet: true }) }),
  big: Object.freeze({ label: 'Eight players', patch: Object.freeze({ numPlayers: 8, eightsAsSet: false }) }),
  memory: Object.freeze({ label: 'From memory', patch: Object.freeze({ showHistory: false, turnSeconds: 45 }) }),
});

/**
 * The shape of every tunable, in one place. guards.js and intents.js both bound
 * incoming config patches against this rather than keeping their own copy, so a
 * new house rule cannot be added without its limits coming along.
 */
export const CONFIG_SPEC = Object.freeze({
  numPlayers: Object.freeze({ type: 'enum', values: PLAYER_COUNTS }),
  eightsAsSet: Object.freeze({ type: 'bool' }),
  mustHoldSetToAsk: Object.freeze({ type: 'bool' }),
  claimAnyTime: Object.freeze({ type: 'bool' }),
  wrongClaimAwardsOpponent: Object.freeze({ type: 'bool' }),
  turnSeconds: Object.freeze({ type: 'int', min: 0, max: 300 }),
  showHistory: Object.freeze({ type: 'bool' }),
});

export function defaultConfig() { return { ...DEFAULTS }; }

/**
 * Coerce an untrusted patch to something safe to merge. Unknown keys and
 * ill-typed values are dropped rather than rejected: a client on an older build
 * sending a key we removed should not fail the whole settings change.
 */
export function sanitizeConfigPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object') return clean;

  for (const [key, spec] of Object.entries(CONFIG_SPEC)) {
    if (!(key in patch)) continue;
    const raw = patch[key];

    if (spec.type === 'bool') {
      if (typeof raw === 'boolean') clean[key] = raw;
    } else if (spec.type === 'int') {
      const n = Number(raw);
      if (Number.isInteger(n)) clean[key] = Math.min(spec.max, Math.max(spec.min, n));
    } else if (spec.type === 'enum') {
      if (spec.values.includes(raw)) clean[key] = raw;
    }
  }
  return clean;
}

// ---- Deck ------------------------------------------------------------------

/** The set ids in play under a config. Eights last so scoreboards stay stable. */
export function setsInPlay(config = DEFAULTS) {
  return config.eightsAsSet ? [...ALL_SETS] : [...HALF_SUIT_SETS];
}

export function totalSets(config = DEFAULTS) { return setsInPlay(config).length; }

/** Sets needed to win. A strict majority, so the winner is never ambiguous. */
export function majorityTarget(config = DEFAULTS) {
  return Math.floor(totalSets(config) / 2) + 1;
}

/** Every card in play, in canonical set order. 48 cards, or 52 with eights. */
export function buildDeck(config = DEFAULTS) {
  return setsInPlay(config).flatMap((setId) => [...SET_CARDS[setId]]);
}

export function isCardInPlay(code, config = DEFAULTS) {
  return setOf(code) !== EIGHTS || !!config.eightsAsSet;
}

/**
 * How many cards each seat is dealt.
 *
 * 48 divides evenly by 4, 6 and 8, so the standard game always deals equal
 * hands. The eights house rule makes it 52, which leaves a remainder of 4 at 6
 * and 8 players. Those spare cards go to the FIRST seats, and because seating
 * alternates teams and the remainder is always even, each team absorbs exactly
 * half of them — hands differ by one card but the teams do not.
 */
export function dealCounts(config = DEFAULTS) {
  const seats = config.numPlayers;
  const deckSize = buildDeck(config).length;
  const base = Math.floor(deckSize / seats);
  const spare = deckSize % seats;
  return Array.from({ length: seats }, (_, seat) => base + (seat < spare ? 1 : 0));
}

// ---- Asking ----------------------------------------------------------------

/**
 * The cards this hand may legally ask for, grouped by set.
 *
 * Standard rule: you must hold a card of the set, and you may not ask for a
 * card you already hold — so a set you hold all of is not askable at all, which
 * is exactly the signal that it is time to claim.
 */
export function askableBySet(hand, config = DEFAULTS) {
  const held = new Set(hand);
  const candidateSets = config.mustHoldSetToAsk ? setsHeld(hand) : setsInPlay(config);

  const out = new Map();
  for (const setId of candidateSets) {
    if (!isCardInPlay(setCards(setId)[0], config)) continue;
    const missing = setCards(setId).filter((code) => !held.has(code));
    if (missing.length) out.set(setId, missing);
  }
  return out;
}

/** Flat list of legally askable card codes. */
export function askableCards(hand, config = DEFAULTS) {
  return [...askableBySet(hand, config).values()].flat();
}

/**
 * Why this ask is illegal, or null when it is fine. Returning the reason rather
 * than a boolean means the engine and the UI can show the same wording.
 */
export function askProblem(hand, code, config = DEFAULTS) {
  if (typeof code !== 'string' || !SET_CARDS[setOf(code)]?.includes(code)) {
    return 'That is not a card.';
  }
  if (!isCardInPlay(code, config)) return 'The eights are not in play this game.';
  if (hand.includes(code)) return 'You already hold that card.';
  if (config.mustHoldSetToAsk && !hand.some((c) => setOf(c) === setOf(code))) {
    return 'You must hold a card of that set to ask for it.';
  }
  return null;
}

// ---- Claiming --------------------------------------------------------------

/**
 * Check a claimed distribution against the truth.
 *
 * `assignment` maps every card in the set to the player the claimant says holds
 * it. It must name the whole set and only players on the claiming team. We
 * return which cards were placed wrongly so a botched claim can be shown as a
 * near miss rather than a flat "no".
 */
export function checkClaim(setId, assignment, hands, teamPlayerIds) {
  const want = setCards(setId);
  if (!want.length) return { ok: false, error: 'Unknown set.' };
  if (!assignment || typeof assignment !== 'object') {
    return { ok: false, error: 'Name who holds each card.' };
  }

  const named = Object.keys(assignment);
  if (named.length !== want.length || want.some((code) => !(code in assignment))) {
    return { ok: false, error: `Name a holder for all ${want.length} cards.` };
  }

  const team = new Set(teamPlayerIds);
  for (const code of want) {
    if (!team.has(assignment[code])) {
      return { ok: false, error: 'You can only name players on your own team.' };
    }
  }

  const wrong = want.filter((code) => !(hands[assignment[code]] || []).includes(code));
  return { ok: true, correct: wrong.length === 0, wrong };
}

/** Sets where this team genuinely holds every card. The engine uses this to
 *  spot a player who has no legal ask left and must claim. */
export function completeSetsFor(teamPlayerIds, hands, claimedSetIds, config = DEFAULTS) {
  const pool = new Set(teamPlayerIds.flatMap((id) => hands[id] || []));
  const done = new Set(claimedSetIds);
  return setsInPlay(config).filter(
    (setId) => !done.has(setId) && setCards(setId).every((code) => pool.has(code)),
  );
}
