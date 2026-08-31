// ============================================================================
// bots.js — Players the host plays for.
//
// THE ONE RULE THAT SHAPES THIS FILE: a bot may only know what a person in that
// seat would know. Bots run on the host, which owns the engine and therefore
// knows every hand, so it would be trivial — and invisible — to let them cheat.
// They are given exactly two things instead:
//
//   priv  — engine.privateStateFor(botId): its own cards and legal options.
//   pub   — engine.publicState(): hand SIZES, claims, whose turn.
//
// plus an AskMemory, which is fed the same questions and answers everyone at the
// table hears. Nothing in here takes an engine, so a bot cannot reach past that
// boundary even by accident. test-bots.mjs asserts the deductions are sound by
// checking every "certain" conclusion against the real hands afterwards.
//
// WHY MEMORY IS NOT READ OFF publicState.history
//   config.showHistory can hide the written record, and that should change what
//   the UI shows a human, not what a bot remembers — a person at a table
//   remembers the last question whether or not anyone wrote it down. So the host
//   feeds observations in as they happen and the bot's memory is independent of
//   the display setting.
//
// The bots are not strong. They deduce what is deducible, chase the set they
// hold most of, and never make a claim they know to be wrong. That is enough to
// be a real opponent without pretending to be a good one.
// ============================================================================

import { setCards, setOf } from './cards.js';

/** How long the host pauses before playing a bot's move, so a table of bots is
 *  watchable rather than instantaneous. */
export const BOT_THINK_MS = 900;

/** How long an away player's seat is left alone before the house plays it.
 *  Longer than a bot's pause on purpose: a phone that drops Wi-Fi for a moment
 *  should not cost somebody their turn. */
export const AWAY_PLAY_MS = 8000;

/**
 * What the table has heard.
 *
 * Only public facts go in here, so a single instance is safely shared by every
 * bot at the table — each one's private knowledge arrives separately, in `priv`.
 */
export class AskMemory {
  constructor() { this.reset(); }

  reset() {
    /** code -> playerId certainly holding it right now. */
    this.holder = new Map();
    /** code -> Set of playerIds certainly NOT holding it right now. */
    this.excluded = new Map();
    /** playerId -> Set of setIds they have shown they hold a card of. */
    this.interest = new Map();
    /** Cards retired by a resolved set; knowledge about them is worthless. */
    this.retired = new Set();
    /** Highest ask number folded in, so syncFrom() can be called repeatedly. */
    this.seen = 0;
  }

  /**
   * Fold in one question and its answer.
   *
   * Both outcomes are informative, and the negative one is the reason a real
   * player leans forward when someone else is asking:
   *   - the asker holds a card of that set (they had to, to ask) and does NOT
   *     hold the card named;
   *   - a yes means the target held it and the asker holds it now;
   *   - a no means neither of them holds it.
   *
   * A later yes overwrites the holder, which is what keeps these facts true
   * rather than merely once-true: a card only changes hands through an ask we
   * also hear, or through a claim, which retires it.
   */
  observeAsk(h) {
    if (!h || this.retired.has(h.code)) return;
    if (typeof h.n === 'number') this.seen = Math.max(this.seen, h.n);

    const setId = h.setId || setOf(h.code);
    this._noteInterest(h.askerId, setId);

    if (h.gotIt) {
      this._noteInterest(h.targetId, setId);
      this.holder.set(h.code, h.askerId);
      this.excluded.delete(h.code);
    } else {
      // Deliberately NOT clearing the known holder. A no from one person says
      // nothing about a card someone else was seen to take: you may legally ask
      // for a card that a third player is sitting on, and forgetting that on
      // every miss threw away most of what the table had heard.
      this._exclude(h.code, h.targetId);
      this._exclude(h.code, h.askerId);
    }
  }

  /** A resolved set leaves play, so forget it rather than reason about ghosts. */
  observeClaim(claim) {
    if (!claim) return;
    for (const code of setCards(claim.setId)) {
      this.retired.add(code);
      this.holder.delete(code);
      this.excluded.delete(code);
    }
  }

  /** Catch up from a public state. Idempotent via the ask counter, so it is safe
   *  to call on every render. */
  syncFrom(pub) {
    if (!pub) return;
    for (const c of pub.claims || []) this.observeClaim(c);
    for (const h of pub.history || []) {
      if (typeof h.n === 'number' && h.n <= this.seen) continue;
      this.observeAsk(h);
    }
  }

  holderOf(code) { return this.retired.has(code) ? null : (this.holder.get(code) || null); }

  isExcluded(code, playerId) {
    return !!this.excluded.get(code)?.has(playerId);
  }

  hasInterest(playerId, setId) {
    return !!this.interest.get(playerId)?.has(setId);
  }

  /** How many live cards this player is known to hold, ignoring one set. Used to
   *  work out how much room is left in a hand whose SIZE is public. */
  knownCountFor(playerId, exceptSetId = null) {
    let n = 0;
    for (const [code, who] of this.holder) {
      if (who !== playerId || this.retired.has(code)) continue;
      if (exceptSetId && setOf(code) === exceptSetId) continue;
      n += 1;
    }
    return n;
  }

  _exclude(code, playerId) {
    if (!this.excluded.has(code)) this.excluded.set(code, new Set());
    this.excluded.get(code).add(playerId);
  }

  _noteInterest(playerId, setId) {
    if (!this.interest.has(playerId)) this.interest.set(playerId, new Set());
    this.interest.get(playerId).add(setId);
  }
}

const EMPTY = new Set();

/**
 * Everything that FOLLOWS from what the table has heard.
 *
 * AskMemory only stores what was said outright. This is the part a good player
 * does in their head, and without it a bot can never claim a card that was dealt
 * to a teammate and never asked about — which is most of them, so games between
 * bots simply never ended.
 *
 * Three facts feed it, all of them legitimately available:
 *   - my own hand, which I know exactly, so every other card is NOT mine;
 *   - who was heard to take or refuse each card;
 *   - how many cards each player is holding, which is public.
 *
 * Then two rules run to a fixpoint:
 *   ONE CANDIDATE   — if everyone but one player is ruled out of a card, that
 *                     player holds it.
 *   COUNTING        — a player holding three cards, two of them known, has room
 *                     for exactly one more; if only one card is still possible
 *                     for them, it is theirs, and if none is, they are ruled out
 *                     of everything else.
 *
 * Every conclusion is a certainty, not a guess. test-bots.mjs checks the whole
 * map against the real hands on every turn of every game, because an unsound
 * deduction here would look exactly like a bot that cheats.
 */
export function deduceHolders(memory, pub, priv) {
  const live = (pub.unclaimedSets || []).flatMap((setId) => setCards(setId));
  const players = pub.players || [];
  const mine = new Set(priv.hand.map((c) => c.code));

  const holder = new Map();
  const excluded = new Map();

  const setHolder = (code, id) => {
    if (holder.get(code) === id) return false;
    holder.set(code, id);
    return true;
  };
  const exclude = (code, id) => {
    if (!excluded.has(code)) excluded.set(code, new Set());
    const s = excluded.get(code);
    if (s.has(id)) return false;
    s.add(id);
    return true;
  };
  const notsFor = (code) => excluded.get(code) || EMPTY;

  for (const code of live) {
    if (mine.has(code)) {
      holder.set(code, priv.id);
      continue;
    }
    exclude(code, priv.id); // I know my own hand, so this one is not in it.
    const who = memory.holderOf(code);
    if (who) holder.set(code, who);
    for (const id of memory.excluded.get(code) || EMPTY) exclude(code, id);
  }

  // An empty hand holds nothing at all.
  for (const p of players) {
    if (p.cards) continue;
    for (const code of live) if (holder.get(code) !== p.id) exclude(code, p.id);
  }

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 24) {
    changed = false;
    rounds += 1;

    for (const code of live) {
      if (holder.has(code)) continue;
      const nots = notsFor(code);
      const cands = players.filter((p) => p.cards > 0 && !nots.has(p.id));
      if (cands.length === 1 && setHolder(code, cands[0].id)) changed = true;
    }

    for (const p of players) {
      let known = 0;
      const possible = [];
      for (const code of live) {
        const who = holder.get(code);
        if (who === p.id) { known += 1; continue; }
        if (who === undefined && !notsFor(code).has(p.id)) possible.push(code);
      }
      const room = p.cards - known;

      if (room <= 0) {
        for (const code of possible) if (exclude(code, p.id)) changed = true;
      } else if (room === possible.length && possible.length) {
        for (const code of possible) if (setHolder(code, p.id)) changed = true;
      }
    }
  }

  return holder;
}

/**
 * Work out who on my team holds each card of a set.
 *
 * Returns null when the set demonstrably is NOT ours (a known holder is an
 * opponent, or nobody on my team has room for a card). Otherwise `confident`
 * says whether every holder was deduced or some were guessed — the caller only
 * volunteers a claim when confident, and only guesses when the engine says it
 * has no legal ask left.
 */
export function buildAssignment(deduced, priv, setId) {
  const codes = setCards(setId);
  const mine = new Set(priv.hand.map((c) => c.code));
  const team = priv.teammates;
  const teamIds = new Set(team.map((t) => t.id));

  const assignment = {};
  const unknown = [];

  for (const code of codes) {
    if (mine.has(code)) { assignment[code] = priv.id; continue; }
    const who = deduced.get(code);
    if (who && teamIds.has(who)) { assignment[code] = who; continue; }
    if (who) return null; // An opponent holds it: this set is not ours to claim.
    unknown.push(code);
  }

  if (!unknown.length) return { assignment, confident: true };

  // Guess the rest, respecting the arithmetic: hand sizes are public, so a
  // teammate holding two cards cannot be hiding a third.
  const placed = new Map(team.map((t) => [t.id, 0]));
  for (const code of Object.keys(assignment)) {
    placed.set(assignment[code], (placed.get(assignment[code]) || 0) + 1);
  }
  const deducedElsewhere = (id) => {
    let n = 0;
    for (const [code, who] of deduced) {
      if (who === id && setOf(code) !== setId) n += 1;
    }
    return n;
  };

  for (const code of unknown) {
    const room = team
      .filter((t) => !t.isMe) // If it were mine, `mine` would have caught it.
      .map((t) => ({ t, spare: t.cards - placed.get(t.id) - deducedElsewhere(t.id) }))
      .filter((x) => x.spare > 0)
      .sort((a, b) => b.spare - a.spare);

    if (!room.length) return null; // Nobody on my team has room for it.
    assignment[code] = room[0].t.id;
    placed.set(room[0].t.id, placed.get(room[0].t.id) + 1);
  }

  return { assignment, confident: false };
}

/**
 * The move this bot would like to make, or null if it is not its turn.
 *
 * Bots act only on their own turn even when the host allows claims at any time.
 * Interrupting is legal, but a table of bots all claiming the instant they can
 * would be unreadable, and the cost is only that a bot occasionally banks a set
 * one turn later than it could have.
 */
export function chooseBotMove(memory, pub, priv) {
  if (!priv || !priv.isTurn) return null;

  const unclaimed = pub.unclaimedSets || [];
  const deduced = deduceHolders(memory, pub, priv);

  // 1. Bank anything we can prove is ours.
  for (const setId of unclaimed) {
    const built = buildAssignment(deduced, priv, setId);
    if (built?.confident) {
      return { type: 'claim', setId, assignment: built.assignment };
    }
  }

  // 2. An ask that could actually land.
  const ask = chooseAsk(memory, deduced, priv);
  if (ask) return { type: 'ask', ...ask };

  // 3. Nothing left to ask for, so call a set on a guess.
  //
  //    Two different situations arrive here and they deserve the same answer.
  //    Either the engine reports no legal ask at all (priv.mustClaim), or every
  //    card we could legally ask for has been ruled out of every opponent's hand
  //    — which means a teammate holds it, but we cannot prove which one. The
  //    second case used to fall through to an ask we already knew would fail,
  //    and because these bots are deterministic, two of them facing each other
  //    in that position re-asked the same dead question forever.
  //
  //    A guessed claim may well be wrong. A miscall hands the set to the
  //    opponents, which is a real cost and a legitimate way for a game to move
  //    on; asking a question whose answer we already know is not a move at all.
  const byHeld = [...unclaimed].sort((a, b) => heldIn(priv, b) - heldIn(priv, a));
  for (const setId of byHeld) {
    const built = buildAssignment(deduced, priv, setId);
    if (built) return { type: 'claim', setId, assignment: built.assignment };
  }
  // No set is even constructible: name the one we hold most of and put every
  // unknown card on ourselves. It will fail, and that resolves the set.
  if (byHeld.length) {
    const setId = byHeld[0];
    return {
      type: 'claim',
      setId,
      assignment: Object.fromEntries(setCards(setId).map((c) => [c, priv.id])),
    };
  }
  return null;
}

function heldIn(priv, setId) {
  return priv.hand.filter((c) => c.setId === setId).length;
}

/**
 * The best question available, or null if every legal one is already answered.
 *
 * Null is a meaningful result, not a failure: it says this hand has nothing left
 * to learn by asking, and the caller should call a set instead. Returning a
 * known-futile ask here would be worse than useless, because a bot's move is a
 * pure function of what it knows, so two bots stuck in that position repeat the
 * same exchange for as long as the game is allowed to run.
 */
function chooseAsk(memory, deduced, priv) {
  const teamIds = new Set(priv.teammates.map((t) => t.id));
  const scored = [];

  for (const { setId, codes } of priv.askable) {
    const held = heldIn(priv, setId);
    // How close this set already is to being claimable. Chasing the set we are
    // nearest to finishing is what turns a hand into a claim.
    const nearlyOurs = setCards(setId)
      .filter((c) => teamIds.has(deduced.get(c))).length;

    for (const code of codes) {
      const who = deduced.get(code);
      // Already ours: asking an opponent for it is a guaranteed wasted turn.
      if (who && teamIds.has(who)) continue;

      for (const t of priv.targets) {
        if (who && who !== t.id) continue; // Worked out to be in a different hand.
        if (!who && memory.isExcluded(code, t.id)) continue; // They said no.

        scored.push({
          targetId: t.id,
          code,
          // A known holder outweighs any amount of guesswork: a hit keeps the
          // turn, and a run of hits is how a set actually gets collected.
          score: (who === t.id ? 1000 : 0)
            + nearlyOurs * 25
            + (memory.hasInterest(t.id, setId) ? 40 : 0)
            + held * 10
            + t.cards,
        });
      }
    }
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
  return { targetId: scored[0].targetId, code: scored[0].code };
}
