// ============================================================================
// state.js — The host-authoritative game engine.
//
// ONE of these exists per game, owned by the host's browser. Everyone else
// holds a copy of what it chooses to tell them. Every method validates, mutates
// and returns { ok: true, ... } or { ok: false, error: 'human sentence' } — it
// never throws for bad input, because "bad input" here means a peer sent
// something odd, which is routine rather than exceptional.
//
// THE PRIVACY RULE, which is the whole reason this file is shaped like it is:
// Literature is a hidden-hand game, so the engine's own fields are NOT safe to
// broadcast. Two views exist and only these two ever go on the wire:
//
//   publicState()        — everything the whole table can legitimately see:
//                          hand SIZES, the record of asks, claims, whose turn.
//   privateStateFor(id)  — that one player's cards, and what they may do.
//
// Anything derived from another player's cards must not appear in either. The
// awkward case is `mustClaim`: it looks like a leak, but it only ever fires when
// the player could already work it out from their own hand plus the public card
// counts. See _hasLegalAsk() for why that is exact rather than approximate.
//
// Pure rules live in rules.js and cards.js; this file is the state machine.
// ============================================================================

import {
  cardLabel, cardSpoken, setCards, setLabel, setOf, sortCards,
} from './cards.js';
import {
  DEFAULTS, NUM_TEAMS, askProblem, askableBySet, buildDeck, checkClaim,
  dealCounts, defaultConfig, majorityTarget, sanitizeConfigPatch, setsInPlay,
  teamName, teamOfSeat, totalSets,
} from './rules.js';

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  PLAY: 'play',
  GAME_OVER: 'gameOver',
});

const MAX_NAME = 16;
const LOG_KEEP = 24;
const HISTORY_KEEP = 120;

/** On-theme stand-ins, so a table of bots reads like a shelf. */
const BOT_NAMES = Object.freeze([
  'Austen', 'Borges', 'Calvino', 'Dickens', 'Eliot',
  'Ferrante', 'Gogol', 'Hurston', 'Ishiguro', 'Joyce',
]);

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/**
 * Unbiased index in [0, bound). Rejection-sampled so shuffles are not skewed by
 * the modulo. Tests swap globalThis.crypto for a seeded stub, which is why this
 * reads the global every call instead of capturing it.
 */
function randomInt(bound) {
  if (bound <= 1) return 0;
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / bound) * bound;
  let n;
  do {
    globalThis.crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return n % bound;
}

function shuffled(cards) {
  const out = [...cards];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class GameEngine {
  constructor({ hostId = null } = {}) {
    this.phase = PHASES.LOBBY;
    this.hostId = hostId;

    /** Seat order IS array order. team is derived in _resyncSeating(). */
    this.players = [];

    this.config = defaultConfig();

    /** playerId -> card codes. The secret. Never broadcast. */
    this.hands = {};

    /** Resolved sets, in the order they were resolved.
     *  { setId, team: 0|1|null, byId, byName, correct, wrong: [codes] } */
    this.claims = [];

    /** Seat index of whoever must ask next. */
    this.turn = 0;

    /** Wall-clock ms deadline, or null when there is no clock. Nothing in here
     *  counts down; whoever owns the engine calls checkTurnTimeout(now). */
    this.turnEndsAt = null;

    /** The public record of asks. This is the game's memory. */
    this.history = [];
    this.askCount = 0;

    /** Table talk: deals, claims, timeouts, results. Asks are NOT in here —
     *  they live in history so config.showHistory can gate them alone. */
    this.log = [];

    this.winner = null;
    this.drawn = false;
    this.gamesPlayed = 0;
    this.startSeat = 0;
  }

  // ---- Players -------------------------------------------------------------

  seatOf(playerId) { return this.players.findIndex((p) => p.id === playerId); }
  playerById(playerId) { return this.players.find((p) => p.id === playerId) || null; }
  get turnPlayer() { return this.players[this.turn] || null; }

  teammatesOf(playerId) {
    const me = this.playerById(playerId);
    if (!me) return [];
    return this.players.filter((p) => p.team === me.team);
  }

  opponentsOf(playerId) {
    const me = this.playerById(playerId);
    if (!me) return [];
    return this.players.filter((p) => p.team !== me.team);
  }

  cardsOf(playerId) { return this.hands[playerId] || []; }

  /**
   * Add or reconnect a player.
   *
   * A seat is bound to a `clientId` and to nothing else. Matching on the display
   * name as well would mean a seat can be taken by naming it, and the prize is
   * the hand: _remapPlayerId moves the cards onto the caller's connection and
   * the next hostSync posts them there. A room code is four characters on a
   * public broker, so "only my friends know it" is not a control. It also fires
   * by accident the moment two people pick the same name.
   *
   * The cost is that losing the clientId means losing the seat — rejoining
   * mid-game from a second device is deliberately not possible, and the host
   * re-seats you instead. See the device-identity note in js/util.js.
   */
  addPlayer(id, name, { isHost = false, clientId = null, isBot = false } = {}) {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'Enter a name first.' };

    const existing = clientId ? this.players.find((p) => p.clientId === clientId) : null;
    const named = this.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());

    if (existing) {
      const prevId = existing.id;
      if (prevId !== id) this._remapPlayerId(prevId, id);
      existing.online = true;
      // Only let them take the typed name if it is not someone else's.
      if (!named || named === existing) existing.name = clean;
      if (isHost) {
        existing.isHost = true;
        this.hostId = id;
      }
      return { ok: true, reconnected: true, prevId };
    }

    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: 'That game has already started.' };
    }
    // Without this two seats share a name, and since the name is all anyone else
    // can see, neither player can tell which one is theirs.
    if (named) {
      return { ok: false, error: 'Someone here is already using that name — pick another.' };
    }
    if (this.players.length >= this.config.numPlayers) {
      return { ok: false, error: 'The table is full.' };
    }

    this.players.push({
      id, name: clean, clientId, isHost, isBot, online: true, team: 0,
    });
    if (isHost) this.hostId = id;
    this._resyncSeating();
    return { ok: true, reconnected: false };
  }

  /** Seat a bot. Host-only; bots are just players the host plays for. */
  addBot(actorId) {
    const gate = this._requireHost(actorId, PHASES.LOBBY);
    if (gate) return gate;
    if (this.players.length >= this.config.numPlayers) {
      return { ok: false, error: 'The table is full.' };
    }

    const taken = new Set(this.players.map((p) => p.name.toLowerCase()));
    const name = BOT_NAMES.find((n) => !taken.has(n.toLowerCase()))
      || `Bot ${this.players.length + 1}`;

    const id = `bot:${name.toLowerCase()}`;
    this.players.push({
      id, name, clientId: null, isHost: false, isBot: true, online: true, team: 0,
    });
    this._resyncSeating();
    return { ok: true, id };
  }

  /** Top the table up to numPlayers with bots, so a short table can still play. */
  fillWithBots(actorId) {
    const gate = this._requireHost(actorId, PHASES.LOBBY);
    if (gate) return gate;
    let added = 0;
    while (this.players.length < this.config.numPlayers) {
      const res = this.addBot(actorId);
      if (!res.ok) break;
      added += 1;
    }
    return { ok: true, added };
  }

  removePlayer(actorId, playerId) {
    const gate = this._requireHost(actorId, PHASES.LOBBY);
    if (gate) return gate;
    const seat = this.seatOf(playerId);
    if (seat < 0) return { ok: false, error: 'No such player.' };
    if (this.players[seat].isHost) return { ok: false, error: 'The host cannot leave the table.' };

    this.players.splice(seat, 1);
    delete this.hands[playerId];
    this._resyncSeating();
    return { ok: true };
  }

  /** Shuffle seat order, which is how teams get mixed up between games. */
  shuffleSeats(actorId) {
    const gate = this._requireHost(actorId, PHASES.LOBBY);
    if (gate) return gate;
    this.players = shuffled(this.players);
    this._resyncSeating();
    return { ok: true };
  }

  /** Nudge a player one seat along, so the host can hand-build the teams. */
  moveSeat(actorId, playerId, delta) {
    const gate = this._requireHost(actorId, PHASES.LOBBY);
    if (gate) return gate;
    const from = this.seatOf(playerId);
    if (from < 0) return { ok: false, error: 'No such player.' };

    const to = from + (delta < 0 ? -1 : 1);
    if (to < 0 || to >= this.players.length) return { ok: false, error: 'Already at the end.' };

    [this.players[from], this.players[to]] = [this.players[to], this.players[from]];
    this._resyncSeating();
    return { ok: true };
  }

  setOnline(playerId, online) {
    const p = this.playerById(playerId);
    if (!p) return { ok: false, error: 'No such player.' };
    p.online = !!online;
    return { ok: true };
  }

  /** After the host's tab reloads: it is the host again, and nobody else has
   *  reconnected yet, so every other seat starts off marked away. */
  resumeAsHost(hostId) {
    for (const p of this.players) {
      p.isHost = false;
      if (!p.isBot) p.online = false;
    }
    let me = this.playerById(hostId);
    if (!me) {
      const stale = this.players.find((p) => p.id === this.hostId);
      if (stale) {
        this._remapPlayerId(stale.id, hostId);
        me = stale;
      }
    }
    if (me) {
      me.isHost = true;
      me.online = true;
    }
    this.hostId = hostId;
    this._resyncSeating();
    return { ok: true };
  }

  // ---- Settings ------------------------------------------------------------

  setConfig(actorId, patch) {
    const gate = this._requireHost(actorId, PHASES.LOBBY);
    if (gate) return gate;

    const clean = sanitizeConfigPatch(patch);
    if (!Object.keys(clean).length) return { ok: false, error: 'Nothing to change.' };

    if ('numPlayers' in clean && clean.numPlayers < this.players.length) {
      return { ok: false, error: `${this.players.length} players are already seated.` };
    }

    this.config = { ...this.config, ...clean };
    this._resyncSeating();
    return { ok: true, config: { ...this.config } };
  }

  // ---- Starting ------------------------------------------------------------

  startGame(actorId, now = Date.now()) {
    const gate = this._requireHost(actorId, PHASES.LOBBY);
    if (gate) return gate;

    const seats = this.config.numPlayers;
    if (this.players.length !== seats) {
      return {
        ok: false,
        error: `Need exactly ${seats} players — ${this.players.length} seated.`,
      };
    }

    this._deal();
    this.phase = PHASES.PLAY;
    this.winner = null;
    this.drawn = false;
    this.turn = this.startSeat % seats;
    this._armClock(now);

    this.log = [];
    this.history = [];
    this.askCount = 0;
    this._log(`Dealt ${totalSets(this.config)} sets to ${seats} players.`);
    this._log(`${this.turnPlayer.name} asks first.`, this.turnPlayer.team);
    return { ok: true };
  }

  /** Another round with the same table. Rotates who leads. */
  newGame(actorId, now = Date.now()) {
    const gate = this._requireHost(actorId, null);
    if (gate) return gate;
    if (this.phase === PHASES.PLAY) return { ok: false, error: 'Finish this game first.' };

    this.phase = PHASES.LOBBY;
    this.claims = [];
    this.hands = {};
    this.startSeat = (this.startSeat + 1) % Math.max(1, this.config.numPlayers);
    return this.startGame(actorId, now);
  }

  _deal() {
    const counts = dealCounts(this.config);
    const deck = shuffled(buildDeck(this.config));

    this.hands = {};
    this.claims = [];
    let at = 0;
    this.players.forEach((p, seat) => {
      this.hands[p.id] = sortCards(deck.slice(at, at + counts[seat]));
      at += counts[seat];
    });
  }

  // ---- Asking --------------------------------------------------------------

  /**
   * The core move. Ask one opponent for one card.
   *
   * A hit keeps the turn (and is how you run a table), a miss hands the turn to
   * whoever you asked. Either way the question and its answer are recorded for
   * everyone, which is the information the whole game runs on.
   */
  ask(playerId, targetId, code, now = Date.now()) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'The game is not running.' };

    const asker = this.playerById(playerId);
    if (!asker) return { ok: false, error: 'You are not at this table.' };
    if (this.seatOf(playerId) !== this.turn) return { ok: false, error: 'Not your turn.' };

    const hand = this.cardsOf(playerId);
    const problem = askProblem(hand, code, this.config);
    if (problem) return { ok: false, error: problem };

    const target = this.playerById(targetId);
    if (!target) return { ok: false, error: 'No such player.' };
    if (target.team === asker.team) return { ok: false, error: 'Ask someone on the other team.' };
    if (!this.cardsOf(targetId).length) return { ok: false, error: `${target.name} has no cards left.` };

    const gotIt = this.cardsOf(targetId).includes(code);
    if (gotIt) {
      this.hands[targetId] = this.cardsOf(targetId).filter((c) => c !== code);
      this.hands[playerId] = sortCards([...hand, code]);
    }

    this.askCount += 1;
    this.history.push({
      n: this.askCount,
      askerId: playerId,
      askerName: asker.name,
      askerTeam: asker.team,
      targetId,
      targetName: target.name,
      code,
      setId: setOf(code),
      gotIt,
      // The exchange in words, carried by the record rather than by this call's
      // return value: it has to reach the players who did not make the ask, and
      // pub.history is the only thing that gets to all of them. Reading it out
      // of the record is also what keeps the announcement honest when the record
      // is switched off, since then the record holds one question and so does
      // everybody's screen.
      spoken: `${asker.name} asked ${target.name} for the ${cardSpoken(code)} — ${gotIt ? 'handed over' : 'no'}.`,
    });
    if (this.history.length > HISTORY_KEEP) this.history.shift();

    if (!gotIt) this.turn = this.seatOf(targetId);
    this._armClock(now);

    return { ok: true, gotIt };
  }

  // ---- Claiming ------------------------------------------------------------

  /**
   * Claim a set by naming who on your team holds each of its cards.
   *
   * The set leaves play either way — a claim resolves it. Getting it right
   * banks it for your team; getting it wrong hands it to the opposition (unless
   * the host turned that off, in which case nobody scores it and a draw becomes
   * possible even with nine sets).
   */
  claim(playerId, setId, assignment, now = Date.now()) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'The game is not running.' };

    const player = this.playerById(playerId);
    if (!player) return { ok: false, error: 'You are not at this table.' };
    if (!this.config.claimAnyTime && this.seatOf(playerId) !== this.turn) {
      return { ok: false, error: 'You can only claim on your own turn.' };
    }
    if (!setsInPlay(this.config).includes(setId)) {
      return { ok: false, error: 'That set is not in play.' };
    }
    if (this.claims.some((c) => c.setId === setId)) {
      return { ok: false, error: 'That set has already been claimed.' };
    }

    const teamIds = this.teammatesOf(playerId).map((p) => p.id);
    const checked = checkClaim(setId, assignment, this.hands, teamIds);
    if (!checked.ok) return checked;

    const opponent = (player.team + 1) % NUM_TEAMS;
    const team = checked.correct
      ? player.team
      : (this.config.wrongClaimAwardsOpponent ? opponent : null);

    for (const code of setCards(setId)) {
      for (const p of this.players) {
        this.hands[p.id] = this.cardsOf(p.id).filter((c) => c !== code);
      }
    }

    this.claims.push({
      setId, team, byId: playerId, byName: player.name,
      correct: checked.correct, wrong: checked.wrong,
    });

    if (checked.correct) {
      this._log(`${player.name} claimed ${setLabel(setId)} for ${teamName(player.team)}.`, player.team);
    } else {
      const missed = checked.wrong.map(cardLabel).join(', ');
      this._log(
        team === null
          ? `${player.name} miscalled ${setLabel(setId)} (${missed}) — the set is void.`
          : `${player.name} miscalled ${setLabel(setId)} (${missed}) — it goes to ${teamName(opponent)}.`,
        team === null ? undefined : opponent,
      );
    }

    // A claim can strip the current asker's last card, and it can end the game.
    if (!this._checkGameOver()) {
      if (!this.cardsOf(this.turnPlayer.id).length) this._advanceTurn(now);
      else this._armClock(now);
    }

    return { ok: true, correct: checked.correct, wrong: checked.wrong, team };
  }

  // ---- Clock ---------------------------------------------------------------

  /** Called on a repeating interval by whoever owns the engine. The engine has
   *  no timers of its own so that tests can drive it a millisecond at a time. */
  checkTurnTimeout(now = Date.now()) {
    if (this.phase !== PHASES.PLAY || this.turnEndsAt === null) return { fired: false };
    if (now < this.turnEndsAt) return { fired: false };

    const p = this.turnPlayer;
    this._log(`${p.name} ran out of time.`, p.team);
    this._advanceTurn(now);
    return { fired: true, playerName: p.name };
  }

  _armClock(now = Date.now()) {
    const secs = this.config.turnSeconds;
    this.turnEndsAt = this.phase === PHASES.PLAY && secs > 0 ? now + secs * 1000 : null;
  }

  /** Next seat round the table that still holds cards. */
  _advanceTurn(now = Date.now()) {
    const seats = this.players.length;
    for (let step = 1; step <= seats; step += 1) {
      const seat = (this.turn + step) % seats;
      if (this.cardsOf(this.players[seat].id).length) {
        this.turn = seat;
        this._armClock(now);
        return true;
      }
    }
    // Nobody holds a card: every set has been resolved, so this is the end.
    this._checkGameOver();
    return false;
  }

  // ---- Result --------------------------------------------------------------

  scores() {
    const out = new Array(NUM_TEAMS).fill(0);
    for (const c of this.claims) if (c.team !== null) out[c.team] += 1;
    return out;
  }

  _checkGameOver() {
    if (this.phase !== PHASES.PLAY) return false;

    const target = majorityTarget(this.config);
    const scores = this.scores();
    const leader = scores.findIndex((n) => n >= target);
    const allResolved = this.claims.length >= totalSets(this.config);

    if (leader < 0 && !allResolved) return false;

    this.phase = PHASES.GAME_OVER;
    this.turnEndsAt = null;
    this.gamesPlayed += 1;

    if (leader >= 0) {
      this.winner = leader;
      this.drawn = false;
      this._log(`${teamName(leader)} wins ${scores[leader]}–${scores[(leader + 1) % NUM_TEAMS]}.`, leader);
    } else if (scores[0] === scores[1]) {
      this.winner = null;
      this.drawn = true;
      this._log(`Every set resolved — a draw at ${scores[0]}–${scores[1]}.`);
    } else {
      this.winner = scores[0] > scores[1] ? 0 : 1;
      this.drawn = false;
      this._log(`${teamName(this.winner)} wins ${Math.max(...scores)}–${Math.min(...scores)}.`, this.winner);
    }
    return true;
  }

  // ---- Legality ------------------------------------------------------------

  /**
   * Can this player ask anything at all?
   *
   * False means they must claim instead, and the two ways that happens are both
   * things the player can already see for themselves:
   *   - no opponent holds a card, so there is nobody to ask (card counts are
   *     public), or
   *   - every set they hold, they hold entirely (their own hand tells them).
   * In both cases their team demonstrably holds a complete set, so `mustClaim`
   * is always satisfiable and never a dead end. test-engine.mjs asserts this.
   */
  _hasLegalAsk(playerId) {
    const hand = this.cardsOf(playerId);
    if (!hand.length) return false;
    if (!this.opponentsOf(playerId).some((p) => this.cardsOf(p.id).length)) return false;
    return askableBySet(hand, this.config).size > 0;
  }

  unclaimedSets() {
    const done = new Set(this.claims.map((c) => c.setId));
    return setsInPlay(this.config).filter((setId) => !done.has(setId));
  }

  // ---- Views ---------------------------------------------------------------

  /** Safe for the whole table. Contains no card identities beyond resolved
   *  sets, and hand sizes only as counts. */
  publicState() {
    const showHistory = !!this.config.showHistory;
    return {
      phase: this.phase,
      hostId: this.hostId,
      config: { ...this.config },
      turn: this.turn,
      turnId: this.turnPlayer?.id ?? null,
      turnEndsAt: this.turnEndsAt,
      players: this.players.map((p, seat) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        seat,
        online: p.online,
        isHost: p.isHost,
        isBot: p.isBot,
        cards: this.cardsOf(p.id).length,
      })),
      claims: this.claims.map((c) => ({ ...c })),
      scores: this.scores(),
      target: majorityTarget(this.config),
      setsInPlay: setsInPlay(this.config),
      unclaimedSets: this.unclaimedSets(),
      // With the record off, only the question just asked is public — the same
      // as at a table, where you hear it and then have to remember it.
      history: showHistory ? this.history.map((h) => ({ ...h })) : this.history.slice(-1),
      historyHidden: !showHistory,
      log: this.log.map((l) => ({ ...l })),
      winner: this.winner,
      drawn: this.drawn,
      gamesPlayed: this.gamesPlayed,
    };
  }

  /** One player's cards and options. Goes only to that player. */
  privateStateFor(playerId) {
    const me = this.playerById(playerId);
    if (!me) return null;

    const hand = this.cardsOf(playerId);
    const isTurn = this.phase === PHASES.PLAY && this.seatOf(playerId) === this.turn;
    const askable = [...askableBySet(hand, this.config).entries()]
      .map(([setId, codes]) => ({ setId, codes }));

    return {
      id: playerId,
      team: me.team,
      hand: hand.map((code) => ({ code, setId: setOf(code) })),
      isTurn,
      askable: isTurn ? askable : [],
      targets: isTurn
        ? this.opponentsOf(playerId)
          .filter((p) => this.cardsOf(p.id).length)
          .map((p) => ({ id: p.id, name: p.name, cards: this.cardsOf(p.id).length }))
        : [],
      // Teammates you may name in a claim. Names and ids only, never cards.
      teammates: this.teammatesOf(playerId).map((p) => ({
        id: p.id, name: p.name, cards: this.cardsOf(p.id).length, isMe: p.id === playerId,
      })),
      canClaim: this.phase === PHASES.PLAY && (this.config.claimAnyTime || isTurn),
      mustClaim: isTurn && !this._hasLegalAsk(playerId),
    };
  }

  // ---- Persistence ---------------------------------------------------------

  serialize() {
    return {
      v: 1,
      phase: this.phase,
      hostId: this.hostId,
      players: this.players.map((p) => ({ ...p })),
      config: { ...this.config },
      hands: Object.fromEntries(Object.entries(this.hands).map(([k, v]) => [k, [...v]])),
      claims: this.claims.map((c) => ({ ...c })),
      turn: this.turn,
      turnEndsAt: this.turnEndsAt,
      history: this.history.map((h) => ({ ...h })),
      askCount: this.askCount,
      log: this.log.map((l) => ({ ...l })),
      winner: this.winner,
      drawn: this.drawn,
      gamesPlayed: this.gamesPlayed,
      startSeat: this.startSeat,
    };
  }

  static restore(snap) {
    const e = new GameEngine();
    if (!snap || snap.v !== 1) return e;

    e.phase = snap.phase ?? PHASES.LOBBY;
    e.hostId = snap.hostId ?? null;
    e.players = (snap.players || []).map((p) => ({ ...p }));
    e.config = { ...DEFAULTS, ...(snap.config || {}) };
    e.hands = Object.fromEntries(Object.entries(snap.hands || {}).map(([k, v]) => [k, [...v]]));
    e.claims = (snap.claims || []).map((c) => ({ ...c }));
    e.turn = snap.turn ?? 0;
    e.turnEndsAt = snap.turnEndsAt ?? null;
    e.history = (snap.history || []).map((h) => ({ ...h }));
    e.askCount = snap.askCount ?? e.history.length;
    e.log = (snap.log || []).map((l) => ({ ...l }));
    e.winner = snap.winner ?? null;
    e.drawn = !!snap.drawn;
    e.gamesPlayed = snap.gamesPlayed ?? 0;
    e.startSeat = snap.startSeat ?? 0;
    e._resyncSeating();
    return e;
  }

  // ---- Internals -----------------------------------------------------------

  _requireHost(actorId, phase) {
    if (!this.hostId || actorId !== this.hostId) return { ok: false, error: 'Only the host can do that.' };
    if (phase && this.phase !== phase) {
      return {
        ok: false,
        error: phase === PHASES.LOBBY ? 'The game is already running.' : 'Not now.',
      };
    }
    return null;
  }

  /** Teams follow seats, so equal teams need no policing beyond seat order. */
  _resyncSeating() {
    this.players.forEach((p, seat) => { p.team = teamOfSeat(seat); });
  }

  /** A reconnecting player arrives under a new peer id. Everything keyed by the
   *  old one has to follow, or their cards and their history detach. */
  _remapPlayerId(prevId, nextId) {
    const p = this.playerById(prevId);
    if (!p || prevId === nextId) return;

    p.id = nextId;
    if (prevId in this.hands) {
      this.hands[nextId] = this.hands[prevId];
      delete this.hands[prevId];
    }
    for (const h of this.history) {
      if (h.askerId === prevId) h.askerId = nextId;
      if (h.targetId === prevId) h.targetId = nextId;
    }
    for (const c of this.claims) {
      if (c.byId === prevId) c.byId = nextId;
    }
    if (this.hostId === prevId) this.hostId = nextId;
  }

  _log(text, team) {
    this.log.push(team === undefined ? { text } : { text, team });
    if (this.log.length > LOG_KEEP) this.log.shift();
  }
}
