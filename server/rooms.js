// ============================================================================
// rooms.js — Room lifecycle, seat ownership, and fan-out.
//
// WHAT LIVES HERE AND WHAT DOESN'T
//   A Room owns a GameEngine — the same GameEngine the P2P host runs in a browser
//   tab, imported from ../js/state.js, not a reimplementation. Everything about
//   *rules* is therefore already written and already tested; what this file adds
//   is the three things a browser host got for free from PeerJS and now has to be
//   spelled out:
//
//     1. Which socket is which seat        (sockets: playerId -> ws)
//     2. Which device owns which seat      (seats: clientId -> playerId)
//     3. When a room stops existing        (sweep)
//
//   Message handling is in session.js. This file never reads a message.
//
// NO `ws` IMPORT, ON PURPOSE
//   A socket here is anything with `.send(string)` and a numeric `.readyState`, so
//   the test harness drives real rooms with stub sockets and `npm test` stays
//   install-free. That is also why OPEN is a literal 1 rather than `WebSocket.OPEN`.
//
// WHY clientId AND NOT NAME
//   The engine's own addPlayer() reconnects a seat by clientId and refuses a
//   duplicate NAME, which is right for both transports — but the reclaim branch
//   is reachable with nothing but a clientId, and on this transport a clientId is
//   the only secret anybody has. So the server keeps its own seat map and decides
//   for itself, before the engine is called, whether a frame is a returning device
//   or a stranger. The engine is left exactly as the P2P host needs it rather than
//   being taught about untrusted callers: a shared engine that behaved differently
//   for its two owners would be the very drift intents.js exists to prevent.
// ============================================================================

import { GameEngine, PHASES } from '../js/state.js';
import { teamName } from '../js/rules.js';
import { generateRoomCode } from '../js/util.js';
import { createBotDriver } from '../js/botdriver.js';

// The operator log — what shows up in `docker logs` / the Komodo terminal. Same
// [tag] shape as [server], [session] and [gc] so the stream stays greppable.
//
// Player names are safe to put here, but only because cleanName() replaces every
// control character and caps the result at 16 chars — so a name cannot carry a
// newline and forge a log line of its own. Names are still quoted on the way out:
// this server is reachable by anyone with the URL, and a player calling themselves
// "[game] ABCD END" would otherwise produce something that greps like a real
// entry. The quotes make where a name starts and stops unambiguous.
function gameLog(...args) { console.log('[game]', ...args); }

// A socket that is open. `ws` uses 1 for OPEN and so does the browser; not
// importing `ws` just to name the constant keeps this file testable with stubs.
const OPEN = 1;

// ---------------------------------------------------------------------------
// Lifetimes.
//
// Two different clocks, because "nobody is here" and "nobody is playing" are
// different problems. A room whose last socket closed is garbage in minutes: on
// this transport a closed socket is a real departure, and the only reason to wait
// at all is that a phone locking its screen or a train tunnel looks identical to
// leaving for the first minute or two.
//
// A room that still has sockets attached but has seen no message for hours is a
// table that went to bed with the tab open. That one gets the long clock, because
// Literature is a game of long silences — somebody working out who must be
// holding the last diamond is not an idle room.
// ---------------------------------------------------------------------------
export const DEFAULT_LIMITS = Object.freeze({
  maxRooms: 50,
  emptyTtlMs: 15 * 60 * 1000,       // no sockets attached
  idleTtlMs: 6 * 60 * 60 * 1000,    // sockets attached, no traffic
});

/**
 * How long an unattended seat is given before the driver plays it.
 *
 * Much longer than the client's AWAY_PLAY_MS (8s), and that difference is the
 * whole reason createBotDriver takes the option. A P2P host is somebody's phone
 * in a room with the other players, where eight seconds of silence is followed by
 * "hang on, my screen locked". Here there is no such channel: the table is
 * strangers or friends in four places, and nobody can ask the server to wait. The
 * MOVE a driven seat makes is identical either way — only the patience differs.
 */
export const SERVER_AWAY_MS = 30_000;

export class Room {
  constructor(code, now = Date.now(), { awayMs = SERVER_AWAY_MS } = {}) {
    this.code = code;
    this.engine = new GameEngine();
    this.sockets = new Map();       // playerId -> ws
    this.seats = new Map();         // clientId -> playerId
    // The name a seat was claimed under. Kept because the device that comes back
    // must come back as who it was rather than as whoever it now says it is — a
    // rename on reclaim would make a name decide a seat again.
    this.seatNames = new Map();     // playerId -> name
    this.ownerClientId = null;
    this.createdAt = now;
    this.lastActivity = now;
    // Seat ids are server-issued and never reused, so a stale message from a
    // socket that lost its seat can't land on somebody else's.
    this._nextSeat = 0;
    // Operator log bookkeeping. The phase last reported, so a start or a finish
    // is logged once rather than on every broadcast that follows it.
    this._loggedPhase = PHASES.LOBBY;
    this._startedAt = 0;
    // One driver per room, holding the table's shared memory of what was asked
    // out loud plus "which turn am I pausing on". Per-room and not one shared
    // instance, because BOTH of those are per-table: a single driver would have
    // one bot deducing from another table's questions.
    this._bots = createBotDriver({ awayMs });
  }

  newPlayerId() {
    this._nextSeat += 1;
    return `p${this._nextSeat}`;
  }

  touch(now = Date.now()) { this.lastActivity = now; }

  /** Record that a device owns a seat. The two maps are only ever written
   *  together, so they cannot drift out of step. */
  claimSeat(clientId, playerId, name) {
    this.seats.set(clientId, playerId);
    this.seatNames.set(playerId, name);
  }

  dropSeat(clientId) {
    const playerId = this.seats.get(clientId);
    this.seats.delete(clientId);
    if (playerId) this.seatNames.delete(playerId);
  }

  /** Sockets that are still open. A closed socket is dropped on sight. */
  liveSockets() {
    const live = [];
    for (const [playerId, ws] of this.sockets) {
      if (ws && ws.readyState === OPEN) live.push([playerId, ws]);
      else this.sockets.delete(playerId);
    }
    return live;
  }

  get isEmpty() { return this.liveSockets().length === 0; }

  /**
   * Send every attached device the table plus ITS OWN hand, and nothing else.
   *
   * One state message per socket rather than one broadcast, because the private
   * half is different for every recipient and in Literature the private half is
   * the entire game. This is the same split publicState() / privateStateFor()
   * already enforce — the point of doing it per socket is that a hand is never
   * serialised into a payload addressed to anyone else, so there is no filtering
   * step that could be got wrong.
   *
   * privateStateFor() returns null for a player the engine no longer has, and
   * that null is not a bug to paper over: the client reads a null `priv` after a
   * welcome as "you were removed from the table", which is exactly what happened.
   */
  broadcast() {
    const pub = this.engine.publicState();
    for (const [playerId, ws] of this.liveSockets()) {
      send(ws, { type: 'state', pub, priv: this.engine.privateStateFor(playerId) });
    }
    // After the fan-out, not before: a table's move reaching a phone matters more
    // than a line reaching the journal, and this ordering means nothing in the
    // logging can ever sit in front of a send.
    this._noteGamePhase(pub);
  }

  /**
   * One line when a game starts, one when it finishes — the operator's view of a
   * server they cannot see the screens of.
   *
   * Driven by the PHASE TRANSITION rather than by the startGame / newGame
   * intents. Every path that changes room state ends in broadcast(), so watching
   * the phase here catches all of them — a majority win, every set resolved, a
   * draw, and anything added later — where hooking the intents that happen to
   * cause it today would silently miss a third. It also means the log cannot
   * double up: the phase has to actually change for a line to be printed, and
   * broadcast() runs constantly.
   *
   * `pub` is passed in rather than recomputed because broadcast() has just built
   * it, and it already carries the per-team set counts for the final score.
   */
  _noteGamePhase(pub) {
    const phase = this.engine.phase;
    if (phase === this._loggedPhase) return;
    const was = this._loggedPhase;
    this._loggedPhase = phase;

    if (phase === PHASES.PLAY && was !== PHASES.PLAY) {
      this._startedAt = Date.now();
      const host = this.engine.playerById(this.engine.hostId);
      const roster = this.engine.players
        .map((p) => `"${p.name}" [${teamName(p.team)}]`)
        .join(', ');
      gameLog(`${this.code} START  owner="${host ? host.name : '?'}"  ` +
              `players=${this.engine.players.length}  sets=${pub.setsInPlay.length}  ${roster}`);
      return;
    }

    if (phase === PHASES.GAME_OVER) {
      // Three real outcomes, and a draw is one of them — every set resolved at
      // 4–4 with eights in play is a legitimate way for a game to end, so it gets
      // said in words rather than printed as a null winner.
      const team = this.engine.winner;
      const won = team == null
        ? [] : this.engine.players.filter((p) => p.team === team).map((p) => p.name);
      // A winning team with nobody left on it is reachable — players drop, and a
      // seat can empty between the winning claim and this line — and "Ink WINS — "
      // with nothing after the dash reads like the log got truncated. Say it.
      const outcome = team == null
        ? (this.engine.drawn ? 'DRAW' : 'no winner')
        : `${teamName(team)} WINS` +
          (won.length ? ` — ${won.map((n) => `"${n}"`).join(', ')}`
                      : ' (nobody left on the team)');
      const score = pub.scores.map((n, t) => `${teamName(t)} ${n}`).join(' / ');
      gameLog(`${this.code} END    ${outcome}  [${score}]  ${duration(this._startedAt)}`);
    }
  }

  /** The public one-line summary used by /rooms and lobbyQuery. */
  info() {
    const owner = this.engine.playerById(this.engine.hostId);
    return {
      code: this.code,
      hostName: owner ? owner.name : '',
      playerCount: this.engine.players.length,
      // The table size is a host setting in Literature (4, 6 or 8), not a
      // constant, so "full" has to be read off the room's own config rather than
      // off a MAX_PLAYERS — a 4-player table is full at four.
      maxPlayers: this.engine.config.numPlayers,
      phase: this.engine.phase,
      joinable: this.engine.phase === PHASES.LOBBY
        && this.engine.players.length < this.engine.config.numPlayers,
    };
  }
}

/** "12m04s" — how long the game ran. Guards a zero start so a room that somehow
 *  reaches GAME_OVER without a logged start reads as unknown, not as 56 years. */
function duration(startedAt) {
  if (!startedAt) return 'duration unknown';
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Sending. Never throws.
//
// A socket can close between the readyState check and the write, and `ws` throws
// on a write to a closed socket. One dead recipient must not abort the fan-out to
// everyone else, so the failure is swallowed here rather than handled at every
// call site.
// ---------------------------------------------------------------------------
export function send(ws, msg) {
  if (!ws || ws.readyState !== OPEN) return false;
  let text;
  try { text = JSON.stringify(msg); } catch (_) { return false; }
  try { ws.send(text); return true; } catch (_) { return false; }
}

export class RoomManager {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.rooms = new Map();         // code -> Room
  }

  get size() { return this.rooms.size; }

  get(code) { return this.rooms.get(code) || null; }

  /**
   * Open a room, or refuse.
   *
   * The cap is on rooms and not on rooms-per-IP: behind a Tailscale Funnel every
   * connection arrives from the proxy, so there is no client address to count and
   * X-Forwarded-For is whatever the client wrote. A global ceiling is crude but it
   * is the only number that is actually true, and 2GB of Pi is a real limit.
   */
  create(now = Date.now()) {
    // Reclaim dead rooms before refusing a live one, so a day of abandoned
    // lobbies can't lock the server out of service until someone restarts it.
    if (this.rooms.size >= this.limits.maxRooms) this.sweep(now);
    if (this.rooms.size >= this.limits.maxRooms) {
      return { ok: false, error: 'The server is at capacity. Try again in a few minutes.' };
    }
    const code = this._freeCode();
    if (!code) return { ok: false, error: 'Could not allocate a room code. Try again.' };
    const room = new Room(code, now, { awayMs: this.limits.awayMs });
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  /** Codes are 4 chars from a 32-char alphabet, so a collision at this scale is a
   *  formality — but an unchecked collision would hand a joiner somebody else's
   *  game, so it is checked. */
  _freeCode() {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  drop(code) { return this.rooms.delete(code); }

  /**
   * Lobbies anyone may join, in code order.
   *
   * NOTE, and it is deliberately in the code rather than only in the README: this
   * list makes every open lobby on the box enumerable by anyone who can reach the
   * URL, and the URL is on the public internet. Room codes were never secrets (4
   * characters, guessable in an afternoon), so this changes the cost of finding a
   * game, not the security model — the things that must not depend on a code being
   * secret already don't. It is a switch on the server (ROOMS_LIST) because
   * "friends only, share the code yourself" is a legitimate way to run this.
   */
  joinable() {
    const out = [];
    for (const room of this.rooms.values()) {
      const info = room.info();
      if (info.joinable) out.push(info);
    }
    return out.sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * Skip anyone whose turn clock ran out, in every room. Returns how many turns
   * went. This is the server's half of what js/main.js does with an interval in
   * the host's tab — same engine method, same deadline, so a timed game plays the
   * same either way.
   *
   * One interval for the whole box rather than one per room: a room with no timer
   * costs a null check, and a thousand rooms would otherwise be a thousand timers.
   *
   * It deliberately does NOT touch() the rooms it advances. A skip is the server
   * talking to itself, not a player arriving, and counting it as activity would
   * mean a timed game left behind by everyone kept its own room alive forever —
   * the idle sweep would never see it go quiet, because it never would. The cost
   * of letting an abandoned game tick on until the sweep collects it is a log line
   * the engine already caps and a broadcast to zero live sockets.
   */
  tickClocks(now = Date.now()) {
    let fired = 0;
    for (const room of this.rooms.values()) {
      if (!room.engine.checkTurnTimeout(now).fired) continue;
      fired += 1;
      room.broadcast();
    }
    return fired;
  }

  /**
   * Let any bot — or any unattended seat — whose pause is up take its turn.
   * Returns how many moved.
   *
   * Rides the same interval as tickClocks() for the same reasons: the engine holds
   * no timers, one interval for the whole box beats one per room, and a room with
   * nothing to do costs a phase check. Called AFTER tickClocks so a human who ran
   * out of time is skipped first — otherwise a bot could act on a turn that had
   * already expired, on the tick that was about to end it.
   *
   * This matters more in Literature than it would in most games: a hit KEEPS the
   * turn, so a seat that has gone quiet does not simply cost the table one beat —
   * it stops the game outright, for as long as the tab stays shut, unless someone
   * plays the empty chair.
   *
   * Like tickClocks it does not touch() the room. Bots playing on is the server
   * talking to itself; counting it as activity would keep a table everybody left
   * alive forever, because the bots would never let it go quiet. They carry on to
   * an empty room until the sweep collects it, which is a few hundred microseconds
   * of deduction and a broadcast to nobody — cheaper than the bookkeeping needed
   * to pause and resume them, and it means a player whose phone locked mid-game
   * comes back to a game that kept its own time rather than one frozen where they
   * left it.
   */
  tickBots(now = Date.now()) {
    let moved = 0;
    for (const room of this.rooms.values()) {
      if (!room._bots.tick(room.engine, now)) continue;
      moved += 1;
      room.broadcast();
    }
    return moved;
  }

  /**
   * Drop rooms nobody is coming back to. Returns how many went.
   *
   * Called on a timer and again whenever the room cap is hit, because the timer
   * alone would let a burst of abandoned lobbies wedge the server between ticks.
   */
  sweep(now = Date.now()) {
    let dropped = 0;
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      const gone = room.isEmpty
        ? idle > this.limits.emptyTtlMs
        : idle > this.limits.idleTtlMs;
      if (gone) { this.rooms.delete(code); dropped += 1; }
    }
    return dropped;
  }
}
