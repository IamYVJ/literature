// ============================================================================
// cards.js — Cards and the SET taxonomy. Start reading here.
//
// Literature (also called Fish, Canadian Fish, or Kanadian) is played with one
// deck, and the only structure that matters is the SET — a half-suit of six
// cards:
//
//   LOW   2 3 4 5 6 7        HIGH   9 10 J Q K A
//
// Four suits x two halves = 8 sets x 6 cards = 48 cards. The four 8s are left
// out of the box game, which is why a 48-card deck divides cleanly among 4, 6
// or 8 players. A common house rule keeps them in as a ninth set of four cards
// (see EIGHTS below); rules.js gates that, this module just describes it.
//
// A set is the unit of everything:
//   - You may only ask for a card in a set you already hold a card of.
//   - You claim a whole set at once, naming who holds each card.
//   - The game is won on sets claimed, never on individual cards.
//
// Card codes are two characters, rank then suit, e.g. 'QH', 'TS'. The ten is
// stored as 'T' so every code is exactly two characters and can be used as a
// map key or compared with ===. One deck means a code is already unique, so a
// code IS the card's identity — there are no separate card ids.
//
// This module is pure data and total functions over it. It imports nothing.
// Deck building, house rules and legality live in rules.js.
// ============================================================================

// ---- Suits and ranks -------------------------------------------------------
export const SUITS = Object.freeze(['S', 'H', 'D', 'C']);

export const LOW_RANKS = Object.freeze(['2', '3', '4', '5', '6', '7']);
export const HIGH_RANKS = Object.freeze(['9', 'T', 'J', 'Q', 'K', 'A']);

/** The odd one out. Excluded from the 48-card game, a ninth set when included. */
export const EIGHT_RANK = '8';

/** Ascending, so hands and sets sort the way a player would fan them. */
export const RANKS = Object.freeze([...LOW_RANKS, EIGHT_RANK, ...HIGH_RANKS]);

export const SET_SIZE = 6;
export const EIGHTS_SET_SIZE = SUITS.length;

export function rankOf(code) { return code[0]; }
export function suitOf(code) { return code[1]; }
export function isEight(code) { return rankOf(code) === EIGHT_RANK; }
export function isRedSuit(code) { return suitOf(code) === 'H' || suitOf(code) === 'D'; }

const SUIT_GLYPHS = Object.freeze({ S: '♠', H: '♥', D: '♦', C: '♣' });
const SUIT_NAMES = Object.freeze({ S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' });

export function suitGlyph(code) { return SUIT_GLYPHS[suitOf(code)] || ''; }

/** Display rank — 'T' is stored for the ten so all codes are two characters. */
export function rankLabel(code) { return rankOf(code) === 'T' ? '10' : rankOf(code); }

/** Full human label, e.g. '10♥'. */
export function cardLabel(code) { return rankLabel(code) + suitGlyph(code); }

/** Spoken label for the ask log and screen readers, e.g. '10 of Hearts'. */
export function cardSpoken(code) {
  const names = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };
  const rank = names[rankOf(code)] || rankOf(code);
  return `${rank} of ${SUIT_NAMES[suitOf(code)]}`;
}

// ---- Sets ------------------------------------------------------------------
// A set id is two characters: suit + 'L'/'H' for the half-suits, and the
// literal 'E8' for the eights, which span all four suits and so have no suit
// of their own. Two characters keeps set ids the same shape as card codes.

export const EIGHTS = 'E8';

/** The eight half-suits, in a stable display order: low then high, per suit. */
export const HALF_SUIT_SETS = Object.freeze(SUITS.flatMap((s) => [`${s}L`, `${s}H`]));

/** Every set id that can ever exist, eights last. */
export const ALL_SETS = Object.freeze([...HALF_SUIT_SETS, EIGHTS]);

/** Which set a card belongs to. Total over all 52 codes. */
export function setOf(code) {
  if (isEight(code)) return EIGHTS;
  return suitOf(code) + (LOW_RANKS.includes(rankOf(code)) ? 'L' : 'H');
}

/** The suit a set sits in, or null for the eights. Used for colour only. */
export function setSuit(setId) { return setId === EIGHTS ? null : setId[0]; }

export function isHighSet(setId) { return setId[1] === 'H'; }

/** The exact cards in a set, ascending. Frozen — never mutate the result. */
export const SET_CARDS = Object.freeze(Object.fromEntries([
  ...HALF_SUIT_SETS.map((setId) => {
    const suit = setId[0];
    const ranks = isHighSet(setId) ? HIGH_RANKS : LOW_RANKS;
    return [setId, Object.freeze(ranks.map((r) => r + suit))];
  }),
  [EIGHTS, Object.freeze(SUITS.map((s) => EIGHT_RANK + s))],
]));

export function setCards(setId) { return SET_CARDS[setId] || []; }
export function setSize(setId) { return setCards(setId).length; }

/** e.g. 'Low ♠', 'High ♥', 'Eights'. Short enough for a chip. */
export function setLabel(setId) {
  if (setId === EIGHTS) return 'Eights';
  return `${isHighSet(setId) ? 'High' : 'Low'} ${SUIT_GLYPHS[setSuit(setId)]}`;
}

/** Spelt out with its range, for tooltips and the rules panel. */
export function setLongLabel(setId) {
  if (setId === EIGHTS) return 'Eights (all four suits)';
  const suit = SUIT_NAMES[setSuit(setId)];
  return isHighSet(setId) ? `High ${suit} (9–A)` : `Low ${suit} (2–7)`;
}

// ---- Grouping helpers ------------------------------------------------------

/** Sort card codes into canonical order: by set, then ascending rank. */
export function sortCards(codes) {
  const setRank = new Map(ALL_SETS.map((s, i) => [s, i]));
  return [...codes].sort((a, b) => {
    const bySet = setRank.get(setOf(a)) - setRank.get(setOf(b));
    if (bySet !== 0) return bySet;
    return RANKS.indexOf(rankOf(a)) - RANKS.indexOf(rankOf(b));
  });
}

/** Group card codes by set id, preserving ALL_SETS order. Empty sets omitted. */
export function groupBySet(codes) {
  const groups = new Map();
  for (const code of sortCards(codes)) {
    const setId = setOf(code);
    if (!groups.has(setId)) groups.set(setId, []);
    groups.get(setId).push(code);
  }
  return groups;
}

/** The distinct sets represented in a collection of cards. */
export function setsHeld(codes) {
  return [...new Set(codes.map(setOf))].sort(
    (a, b) => ALL_SETS.indexOf(a) - ALL_SETS.indexOf(b),
  );
}
