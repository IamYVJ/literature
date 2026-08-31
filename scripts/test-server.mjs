// ============================================================================
// test-server.mjs — Headless end-to-end test of the Literature SERVER. No
// browser, no `ws`, no install:
//   node scripts/test-server.mjs
//
// The server is deliberately arranged so that this is possible. guards.js is
// pure policy with no imports of its own; rooms.js talks to anything with a
// `.send()` and a numeric `.readyState`; session.js takes a frame and a clock.
// Only index.js knows about sockets, and nothing here imports it — so `npm test`
// stays dependency-free and every rule below is exercised against the real code
// rather than against a mock of it.
//
// Three halves, which is one more than there should be:
//   1. The Part D hardening checklist from GAME-SERVER-PLATFORM.md, one
//      assertion at a time. This server sits on the public internet with no
//      accounts, so every one of them is a hole that would otherwise be open.
//   2. Whole games played over the wire by stub sockets, through the same
//      Session.handleFrame() a real client reaches — proving the shared engine
//      and the shared intent dispatcher work on this transport too.
//   3. The things that are only true here: the clock interval, the bot
//      interval, the away-seat rule, and the operator log.
//
// WHAT MATTERS MOST IN THIS GAME SPECIFICALLY. Literature is not a board game
// with a shared position and a private hand as a garnish — the hand IS the game,
// and one glimpse of another player's cards decides every set that is left. So
// the privacy assertions here are not box-ticking: they check that no card of
// Bob's appears ANYWHERE in a payload addressed to Alice, at the deal and again
// after hundreds of turns.
// ============================================================================

// The deal, the room codes and the bot tie-breaks all draw on crypto, so the RNG
// is replaced BEFORE anything is imported. A failure here has to be reproducible
// rather than a story about one unlucky shuffle.
let prng = 0;
function seed(n) { prng = n >>> 0; }
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  writable: true,
  value: {
    getRandomValues(buf) {
      for (let i = 0; i < buf.length; i += 1) {
        prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0;
        // The state is advanced by an LCG but it is NOT handed out raw. Every
        // consumer here takes a remainder — a room code is `word % 32` — and the
        // low bits of a power-of-two LCG have a period as short as two, so the
        // low five bits repeat every 32 draws and the fourth room code would
        // collide with the first. Mix the word (lowbias32) so the bits a caller
        // actually looks at are the well-behaved ones.
        let x = prng;
        x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
        x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
        x ^= x >>> 16;
        buf[i] = x >>> 0;
      }
      return buf;
    },
  },
});
seed(20260901);

const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');

const { GameEngine, PHASES, cleanName } = await import('../js/state.js');
const { PLAYER_COUNTS, teamName, totalSets } = await import('../js/rules.js');
const { AskMemory, chooseBotMove } = await import('../js/bots.js');
const { RoomManager, Room, send, DEFAULT_LIMITS } = await import('../server/rooms.js');
const { Session, withinBounds } = await import('../server/session.js');
const {
  originAllowed, parseOrigins, TokenBucket, decodeFrame,
  validClientId, validCardCode, validSetId, validPlayerId,
  validConfigPatch, validClaimAssignment,
} = await import('../server/guards.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error('  x FAIL:', msg); }
}
function section(t) { console.log('\n- ' + t); }

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Everything a socket has to be for rooms.js and session.js to use it.
 *
 * `send` THROWS if the socket is closed, which is what the real `ws` does — so a
 * write to a departed player is a test failure here rather than something the
 * production code discovers on the Pi. rooms.send() checks readyState first, so
 * a throw means that check was skipped.
 */
class StubSocket {
  constructor(label = '') {
    this.label = label;
    this.readyState = 1;            // OPEN
    this.sent = [];
    this.closes = [];
  }

  send(text) {
    if (this.readyState !== 1) throw new Error(`send() on a closed socket (${this.label})`);
    this.sent.push(JSON.parse(text));
  }

  close(code, reason) {
    this.readyState = 3;            // CLOSED
    this.closes.push({ code, reason });
  }

  /** Most recent message, optionally of one type. */
  last(type) {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (!type || this.sent[i].type === type) return this.sent[i];
    }
    return null;
  }

  all(type) { return this.sent.filter((m) => m.type === type); }
  clear() { this.sent.length = 0; return this; }
}

/** A connected client: the socket, its Session, and a way to speak. */
function connect(manager, label, opts) {
  const ws = new StubSocket(label);
  const session = new Session(ws, manager, opts);
  return {
    ws, session, label,
    send(msg, now) { session.handleFrame(JSON.stringify(msg), false, now); return this; },
    raw(data, isBinary, now) { session.handleFrame(data, isBinary, now); return this; },
    drop(now) { session.detach(now); ws.close(1001, 'gone'); return this; },
    get state() { return this.ws.last('state'); },
    get playerId() { const w = this.ws.all('welcome'); return w.length ? w[w.length - 1].playerId : null; },
  };
}

/** A clientId of the shape guards.js will accept: 8-64 of [A-Za-z0-9_-]. */
function cid(name) { return `client-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-0001`; }

const FOUR = ['Alice', 'Bob', 'Cara', 'Dan'];
const SIX = [...FOUR, 'Eve', 'Finn'];

/**
 * A room with one client per name, the first of them the owner.
 *
 * Unlike Sequence, Literature will not deal to an arbitrary number of players:
 * the deck has to divide, so a table is exactly 4, 6 or 8. The helper therefore
 * sets numPlayers to match the roster whenever the roster is a legal size, which
 * is what makes `startGame` reachable in the tests below.
 */
function table(names = FOUR, limits) {
  const manager = new RoomManager(limits);
  const clients = [];
  const owner = connect(manager, names[0]);
  owner.send({ type: 'createRoom', name: names[0], clientId: cid(names[0]) });
  const code = owner.ws.last('welcome').code;
  clients.push(owner);
  if (PLAYER_COUNTS.includes(names.length)) {
    owner.send({ type: 'setConfig', patch: { numPlayers: names.length } });
  }
  for (const name of names.slice(1)) {
    const c = connect(manager, name);
    c.send({ type: 'join', code, name, clientId: cid(name) });
    clients.push(c);
  }
  return { manager, code, room: manager.get(code), clients, owner };
}

/**
 * Play a seat the way a real client would: from the public state and its OWN
 * private state, and nothing else.
 *
 * This is the sharpest privacy test in the file, and it is structural rather
 * than an assertion — the driver physically cannot cheat, because the only
 * inputs it is handed are the two halves of the state message that arrived on
 * that client's own socket.
 */
function playFrom(client, memory) {
  const st = client.state;
  if (!st || !st.priv) return null;
  memory.syncFrom(st.pub);
  const move = chooseBotMove(memory, st.pub, st.priv);
  if (!move) return null;
  client.send(move);
  return move;
}

// ===========================================================================
section('guards: the origin allowlist is anti-CSRF, and fails closed in production');
// ===========================================================================
{
  const prod = { allowed: ['https://iamyvj.github.io'], production: true };
  const dev = { allowed: ['https://iamyvj.github.io'], production: false };

  ok(originAllowed('https://iamyvj.github.io', prod), 'the real client origin is allowed');
  ok(!originAllowed('https://evil.example', prod), 'another site is refused');
  ok(!originAllowed('https://iamyvj.github.io.evil.example', prod),
    'a suffix attack on the allowed origin is refused');
  ok(!originAllowed('http://iamyvj.github.io', prod), 'the same host over http is a different origin');

  // A browser cannot omit Origin on a WebSocket handshake. Something that omits
  // it is a script, and no script is a player.
  ok(!originAllowed(undefined, prod), 'a missing Origin is refused in production');
  ok(!originAllowed('', prod), 'an empty Origin is refused in production');
  ok(originAllowed(undefined, dev), 'a missing Origin is allowed outside production');

  // A stray '*' in the Pi's environment must not open the door on the real
  // deployment — which is the whole reason production is a separate flag rather
  // than just an empty allowlist.
  ok(!originAllowed('https://evil.example', { allowed: ['*'], production: true }),
    'a wildcard is ignored in production');
  ok(originAllowed('https://evil.example', { allowed: ['*'], production: false }),
    'a wildcard is honoured outside production');
  ok(!originAllowed('https://evil.example', { allowed: [], production: true }),
    'an empty allowlist refuses everything in production');

  ok(originAllowed('http://localhost:8000', dev), 'localhost is allowed in development');
  ok(!originAllowed('http://localhost:8000', prod), 'localhost is refused in production');
  ok(!originAllowed('http://localhost.evil.example', dev),
    'a host that merely starts with localhost is refused');

  const parsed = parseOrigins(' https://a.example , https://b.example ,, ');
  ok(parsed.length === 2 && parsed[0] === 'https://a.example' && parsed[1] === 'https://b.example',
    'parseOrigins trims, splits and drops blanks');
  ok(parseOrigins(undefined).length === 0, 'parseOrigins survives a missing variable');
}

// ===========================================================================
section('guards: the token bucket sits in front of the broadcast, not behind it');
// ===========================================================================
{
  const b = new TokenBucket({ capacity: 5, refillPerSec: 10, now: 1000 });
  let allowed = 0;
  for (let i = 0; i < 20; i += 1) if (b.take(1000)) allowed += 1;
  ok(allowed === 5, `a burst is capped at the capacity (got ${allowed})`);

  ok(!b.take(1000), 'an empty bucket refuses');
  ok(b.take(1100), 'a tenth of a second at 10/s buys exactly one message');
  ok(!b.take(1100), 'and only one');

  // Real play is bursty in Literature more than in most games: a hit KEEPS the
  // turn, so a good run is a rapid string of asks from one seat. A fixed window
  // would punish exactly the player who is doing well.
  const c = new TokenBucket({ capacity: 40, refillPerSec: 15, now: 0 });
  for (let i = 0; i < 40; i += 1) c.take(0);
  let after = 0;
  for (let i = 0; i < 40; i += 1) if (c.take(10_000)) after += 1;
  ok(after === 40, 'ten idle seconds refill the whole bucket, not more');

  // A clock that goes backwards (NTP, a suspended laptop) must not mint tokens.
  const d = new TokenBucket({ capacity: 3, refillPerSec: 1, now: 5000 });
  d.take(5000); d.take(5000); d.take(5000);
  ok(!d.take(1000), 'a backwards clock does not refill the bucket');
}

// ===========================================================================
section('guards: frame decoding refuses everything that is not a text JSON object');
// ===========================================================================
{
  ok(decodeFrame(JSON.stringify({ type: 'startGame' }), false).type === 'startGame', 'a good frame decodes');
  ok(decodeFrame(Buffer.from(JSON.stringify({ type: 'startGame' })), false).type === 'startGame',
    'a text frame arriving as a Buffer decodes');

  ok(decodeFrame(Buffer.from([0x00, 0x01, 0xff]), true) === null, 'a binary frame is refused');
  ok(decodeFrame('not json at all', false) === null, 'garbage is refused');
  ok(decodeFrame('', false) === null, 'an empty frame is refused');
  ok(decodeFrame('null', false) === null, 'JSON null is refused');
  ok(decodeFrame('42', false) === null, 'a bare number is refused');
  ok(decodeFrame('"startGame"', false) === null, 'a bare string is refused');
  // An array is JSON, is typeof 'object', and has no .type — it would sail past
  // a naive check, so it is excluded by name.
  ok(decodeFrame('[{"type":"startGame"}]', false) === null, 'an array is refused');
  ok(decodeFrame('{"nope":1}', false) === null, 'an object with no type is refused');
  ok(decodeFrame('{"type":123}', false) === null, 'a non-string type is refused');
  ok(decodeFrame(`{"type":"${'x'.repeat(41)}"}`, false) === null, 'an over-long type is refused');
  ok(decodeFrame(`{"type":"${'x'.repeat(40)}"}`, false) !== null, 'a 40-character type is the limit');
}

// ===========================================================================
section('guards: the validators bound work and memory');
// ===========================================================================
{
  ok(validClientId('abcd1234') === 'abcd1234', 'an 8-character clientId is accepted');
  ok(validClientId('abcd123') === null, 'a 7-character clientId is refused');
  ok(validClientId('x'.repeat(64)) !== null && validClientId('x'.repeat(65)) === null,
    'the clientId length ceiling is 64');
  ok(validClientId('has space 1') === null, 'a clientId with a space is refused');
  ok(validClientId('drop/../table') === null, 'a clientId with punctuation is refused');
  ok(validClientId(null) === null && validClientId(12345678) === null,
    'a non-string clientId is refused');

  ok(validCardCode('AS') === 'AS' && validCardCode('TH') === 'TH', 'a card code is accepted');
  ok(validCardCode('8C') === '8C', 'an eight is a card code even when the set is off');
  ok(validCardCode('1S') === null, 'there is no rank 1');
  ok(validCardCode('as') === null, 'card codes are upper case');
  ok(validCardCode('ASS') === null, 'three characters is not a card');
  ok(validCardCode('x'.repeat(9999)) === null, 'a huge string is refused before any hand is walked');

  ok(validSetId('SL') === 'SL' && validSetId('CH') === 'CH', 'the eight half-suits are set ids');
  ok(validSetId('E8') === 'E8', 'and so is the eights set');
  ok(validSetId('SX') === null && validSetId('E9') === null, 'anything else is not');

  ok(validPlayerId('p12') === 'p12' && validPlayerId('x'.repeat(65)) === null,
    'player ids are bounded');
  ok(validPlayerId('') === null, 'an empty player id is refused');

  ok(validConfigPatch({ showHistory: false }) !== null, 'a one-key patch is accepted');
  ok(validConfigPatch({}) === null, 'an empty patch is refused');
  ok(validConfigPatch([]) === null, 'an array is not a patch');
  ok(validConfigPatch(null) === null, 'null is not a patch');
  ok(validConfigPatch('showHistory') === null, 'a string is not a patch');
  const wide = {};
  for (let i = 0; i < 17; i += 1) wide['k' + i] = i;
  ok(validConfigPatch(wide) === null, 'a 17-key patch is refused');

  // The claim assignment is the one payload with attacker-controlled KEYS in it,
  // so it is checked on both sides of every entry.
  ok(validClaimAssignment({ AS: 'p1', KS: 'p2' }) !== null, 'a small assignment is accepted');
  ok(validClaimAssignment({}) === null, 'an empty assignment is refused');
  ok(validClaimAssignment({ notacard: 'p1' }) === null, 'a key that is not a card is refused');
  ok(validClaimAssignment({ AS: '' }) === null, 'a holder that is not a player id is refused');
  ok(validClaimAssignment({ AS: { nested: 1 } }) === null, 'a structured holder is refused');
  const big = {};
  for (const r of ['2', '3', '4', '5', '6', '7', '9', 'T', 'J']) big[r + 'S'] = 'p1';
  ok(Object.keys(big).length === 9 && validClaimAssignment(big) === null,
    'nine cards is more than any set, so it is refused whole');
}

// ===========================================================================
section('guards: intent payload bounds are an allowlist, not a filter');
// ===========================================================================
{
  ok(withinBounds({ type: 'ask', targetId: 'p2', code: 'AS' }), 'a well-formed ask passes');
  ok(!withinBounds({ type: 'ask', targetId: 'p2' }), 'an ask with no card does not');
  ok(!withinBounds({ type: 'ask', code: 'AS' }), 'nor one with no target');
  ok(!withinBounds({ type: 'ask', targetId: 'p2', code: 'x'.repeat(9999) }),
    'a huge card code is refused before it is compared against every hand');
  ok(!withinBounds({ type: 'ask', targetId: { n: 1 }, code: 'AS' }), 'a structured target is refused');

  ok(withinBounds({ type: 'claim', setId: 'SL', assignment: { AS: 'p1' } }), 'a claim passes');
  ok(!withinBounds({ type: 'claim', setId: 'ZZ', assignment: { AS: 'p1' } }), 'with a real set id');
  ok(!withinBounds({ type: 'claim', setId: 'SL', assignment: {} }), 'and a non-empty assignment');

  ok(withinBounds({ type: 'setConfig', patch: { eightsAsSet: true } }), 'a config patch passes');
  ok(!withinBounds({ type: 'setConfig', patch: 'everything' }), 'a stringy patch does not');
  ok(withinBounds({ type: 'removePlayer', playerId: 'p3' }), 'removePlayer needs a player id');
  ok(!withinBounds({ type: 'removePlayer' }), 'and is refused without one');
  ok(withinBounds({ type: 'moveSeat', playerId: 'p3', delta: -1 }), 'moveSeat needs a numeric delta');
  ok(!withinBounds({ type: 'moveSeat', playerId: 'p3', delta: 'up' }), 'and refuses a stringy one');

  for (const t of ['addBot', 'fillBots', 'shuffleSeats', 'startGame', 'newGame']) {
    ok(withinBounds({ type: t }), `${t} carries no payload to bound`);
  }

  // THE POINT of the allowlist. Literature's applyGameIntent answers an unknown
  // type with an ordinary { ok: false, error: 'Unknown intent: …' }, so a
  // permissive default would turn every junk frame into a reply — one small frame
  // in, one frame out, from a server whose job is to be reachable by strangers.
  ok(!withinBounds({ type: 'notAnIntent' }), 'an unknown type is refused, not passed through');
  ok(!withinBounds({ type: '__proto__' }), 'and so is one that names a prototype key');
  ok(!withinBounds({ type: 'toString' }), 'a switch cannot be tricked by an inherited method name');
}

// ===========================================================================
section('guards: withinBounds has not fallen behind intents.js');
// ===========================================================================
{
  // The allowlist above is a second list of intents, and a second list drifts.
  // This reads the real dispatcher's cases out of its source and insists every
  // one of them is reachable from the wire with a well-formed payload — so
  // adding a move to intents.js without naming it here fails the suite instead
  // of shipping as an intent nobody can send.
  const src = readFileSync(fileURLToPath(new URL('../js/intents.js', import.meta.url)), 'utf8');
  const cases = [...src.matchAll(/case\s+'([a-zA-Z]+)'/g)].map((m) => m[1]);
  ok(cases.length >= 10, `found the intents in intents.js (${cases.length})`);

  // A well-formed example of each. A type that reaches this list without an
  // example fails loudly rather than being silently skipped.
  const sample = {
    setConfig:    { type: 'setConfig', patch: { eightsAsSet: true } },
    addBot:       { type: 'addBot' },
    fillBots:     { type: 'fillBots' },
    removePlayer: { type: 'removePlayer', playerId: 'p2' },
    shuffleSeats: { type: 'shuffleSeats' },
    moveSeat:     { type: 'moveSeat', playerId: 'p2', delta: 1 },
    startGame:    { type: 'startGame' },
    newGame:      { type: 'newGame' },
    ask:          { type: 'ask', targetId: 'p2', code: 'AS' },
    claim:        { type: 'claim', setId: 'SL', assignment: { AS: 'p1' } },
  };
  for (const type of cases) {
    ok(sample[type] !== undefined, `test-server.mjs knows an example of '${type}'`);
    if (sample[type]) ok(withinBounds(sample[type]), `'${type}' is reachable through withinBounds`);
  }
}

// ===========================================================================
section('rooms: allocation, listing and the caps');
// ===========================================================================
{
  const m = new RoomManager({ maxRooms: 3 });
  const a = m.create(0), b = m.create(0), c = m.create(0);
  ok(a.ok && b.ok && c.ok, 'rooms open up to the cap');
  const d = m.create(0);
  ok(!d.ok && /capacity/i.test(d.error), 'the room after the cap is refused with a reason');
  ok(m.size === 3, 'the refused room was not created');

  const codes = new Set([a.room.code, b.room.code, c.room.code]);
  ok(codes.size === 3, 'codes are unique');
  ok([...codes].every((code) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code)),
    'codes use the unambiguous 4-character alphabet');
  ok(m.get(a.room.code) === a.room, 'a room can be found by its code');
  ok(m.get('ZZZZ') === null, 'an unknown code returns null rather than throwing');

  // 500 codes from the real generator, all distinct: the collision check in
  // _freeCode is doing its job and the alphabet is not degenerate.
  const many = new RoomManager({ maxRooms: 600 });
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(many.create(0).room.code);
  ok(seen.size === 500, `500 rooms got 500 distinct codes (got ${seen.size})`);

  ok(DEFAULT_LIMITS.maxRooms === 50 && DEFAULT_LIMITS.emptyTtlMs < DEFAULT_LIMITS.idleTtlMs,
    'the shipped defaults collect an empty room sooner than a quiet one');
}

// ===========================================================================
section('rooms: idle collection, on two different clocks');
// ===========================================================================
{
  const m = new RoomManager({ maxRooms: 10, emptyTtlMs: 1000, idleTtlMs: 100_000 });

  const empty = m.create(0).room;
  ok(empty.isEmpty, 'a room with no sockets reports itself empty');
  ok(m.sweep(500) === 0, 'an empty room survives inside the short TTL');
  ok(m.sweep(2000) === 1 && m.size === 0, 'an empty room is collected past the short TTL');

  // A room with a socket attached but no traffic is a table thinking hard. In
  // Literature that is a real thing — working out who must be holding the last
  // diamond takes as long as it takes — so it gets hours, not minutes.
  const live = m.create(0).room;
  live.sockets.set('p1', new StubSocket('live'));
  ok(!live.isEmpty, 'a room with an open socket is not empty');
  ok(m.sweep(2000) === 0, 'a live room is not collected on the short TTL');
  ok(m.sweep(200_000) === 1, 'a live room is collected once it is genuinely idle');

  // A closed socket is a departure, not an occupant.
  const stale = m.create(300_000).room;
  const dead = new StubSocket('dead');
  stale.sockets.set('p1', dead);
  dead.close();
  ok(stale.isEmpty, 'a closed socket does not keep a room alive');
  ok(stale.sockets.size === 0, 'and it is dropped from the socket map on sight');

  // Hitting the cap sweeps first, so a day of abandoned lobbies cannot lock the
  // server out of service until somebody restarts it.
  const tight = new RoomManager({ maxRooms: 2, emptyTtlMs: 1000, idleTtlMs: 1000 });
  tight.create(0); tight.create(0);
  const after = tight.create(50_000);
  ok(after.ok && tight.size === 1, 'a room at the cap sweeps the dead ones and then opens');
}

// ===========================================================================
section('rooms: fan-out gives every device the table and only its own hand');
// ===========================================================================
{
  seed(11);
  const room = new Room('TEST', 0);
  room.engine.addPlayer('p1', 'Alice', { isHost: true });
  room.engine.setConfig('p1', { numPlayers: 4 });
  room.engine.addPlayer('p2', 'Bob');
  room.engine.addPlayer('p3', 'Cara');
  room.engine.addPlayer('p4', 'Dan');
  ok(room.engine.startGame('p1').ok, 'four seats and the game deals');

  const sockets = ['p1', 'p2', 'p3', 'p4'].map((id) => {
    const ws = new StubSocket(id);
    room.sockets.set(id, ws);
    return ws;
  });
  room.broadcast();

  const [a, b] = sockets;
  const sa = a.last('state'), sb = b.last('state');
  ok(sa && sb, 'both sockets got a state message');
  ok(sa.priv.id === 'p1' && sb.priv.id === 'p2', 'each private half is addressed to its own seat');
  ok(sa.priv.hand.length === 12 && sb.priv.hand.length === 12, 'both hands were dealt');
  ok(JSON.stringify(sa.pub) === JSON.stringify(sb.pub), 'the public half is identical for everyone');
  ok(!('hands' in sa.pub), 'the public half carries no hands');
  ok(sa.pub.players.every((p) => typeof p.cards === 'number'),
    'only a count of how many cards each player holds');

  // THE test of the split, and the one that matters most in this game: Alice's
  // payload must not say where a card of Bob's is, and not merely under a
  // different key than `hands`.
  //
  // Two places name cards Alice does not hold, and BOTH are supposed to.
  //   - priv.askable is computed from Alice's own hand and the config alone
  //     (rules.js askableBySet): it is the list she is ALLOWED to ask for. It
  //     says a card exists in a set she holds, which she can see for herself.
  //   - pub.history and pub.log are the public record of asks, which are
  //     announced out loud at a real table and are the whole information game.
  // Neither is a statement about who is holding what. Everywhere else is, so
  // everywhere else must be clean.
  const askableCodes = new Set(sa.priv.askable.flatMap((s) => s.codes));
  ok(sa.priv.askable.every((s) => !('holder' in s) && !('who' in s)),
    'askable names cards, never the player holding them');
  ok([...askableCodes].every((code) => !sa.priv.hand.some((c) => c.code === code)),
    'and never a card Alice already holds');

  const { askable: _askable, ...privRest } = sa.priv;
  const { history: _history, log: _log, ...pubRest } = sa.pub;
  const alicePayload = JSON.stringify({ pub: pubRest, priv: privRest });
  const bobCards = sb.priv.hand.map((c) => c.code);
  const leaked = bobCards.filter((code) => new RegExp(`"${code}"`).test(alicePayload));
  ok(leaked.length === 0, `no card of Bob's is located in the payload addressed to Alice (${leaked})`);

  // At the deal the two exempted keys are empty anyway, so nothing is being
  // waved through here yet. The played-out games later re-run this check after
  // hundreds of asks, when they are not.
  ok(sa.pub.history.length === 0 && sa.pub.log.length <= 2,
    'nothing has been announced yet, so the exemption is currently vacuous');

  // The teammate list is the one place another player's cards are nearly
  // mentioned — a claim has to name who holds what — so it is checked by name.
  ok(sa.priv.teammates.every((t) => !('hand' in t) && typeof t.cards === 'number'),
    'a teammate is a name and a card count, never a hand');

  // A departed socket must not be written to. StubSocket throws on that, so the
  // absence of a throw here is the assertion.
  b.close();
  let threw = false;
  try { room.broadcast(); } catch (_) { threw = true; }
  ok(!threw, 'a closed socket is skipped rather than written to');
  ok(room.sockets.size === 3, 'and is dropped from the room');

  ok(send(null, { type: 'x' }) === false, 'send() to nothing returns false rather than throwing');
  const circular = {}; circular.self = circular;
  ok(send(new StubSocket('c'), circular) === false, 'send() survives an unserialisable payload');
}

// ===========================================================================
section('session: hosting and joining');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(FOUR);
  const welcome = owner.ws.all('welcome')[0];
  ok(welcome.owner === true, 'the creator is told it owns the room');
  ok(welcome.playerId === 'p1', 'seats are server-issued, starting at p1');
  ok(manager.get(code).engine.hostId === 'p1', 'and the engine agrees who the host is');
  ok(clients[1].ws.last('welcome').owner === false, 'a joiner is told it does not own the room');
  ok(clients[1].playerId === 'p2', 'the second seat is p2');

  const pub = clients[1].state.pub;
  ok(pub.players.length === 4 && pub.players[1].name === 'Bob', 'the join was broadcast to everybody');
  ok(pub.players[0].team !== pub.players[1].team, 'and teams alternate around the table');

  // One room per socket. A connection that could hold two would be a connection
  // that could hold fifty.
  owner.ws.clear();
  owner.send({ type: 'createRoom', name: 'Alice', clientId: cid('Alice') });
  ok(owner.ws.last('error'), 'a second createRoom on the same socket is refused');
  ok(manager.size === 1, 'and no second room was created');
  owner.ws.clear();
  owner.send({ type: 'join', code, name: 'Alice', clientId: cid('Alice') });
  ok(owner.ws.last('error'), 'so is a join on a socket that already has a seat');

  // Bad input on the way in.
  const bad = connect(manager, 'bad');
  bad.send({ type: 'join', code: 'NOPE', name: 'X', clientId: cid('x') });
  ok(bad.ws.last('rejected').reason === 'bad-code', 'a code outside the alphabet is refused');
  bad.ws.clear();
  bad.send({ type: 'join', code, name: 'Zoe', clientId: 'short' });
  ok(bad.ws.last('rejected').reason === 'bad-client', 'a malformed clientId is refused');
  bad.ws.clear();
  bad.send({ type: 'join', code, name: '   ', clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'bad-name', 'a blank name is refused');
  bad.ws.clear();
  bad.send({ type: 'join', code, name: 'x'.repeat(500), clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'bad-name', 'a name that is really a payload is refused');
  bad.ws.clear();

  // 'no-room' is the signal the client falls back to P2P on, so it has to be
  // distinguishable from every other refusal.
  bad.send({ type: 'join', code: 'ZZZZ', name: 'Zoe', clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'no-room', 'an unknown code says no-room, not bad-code');

  // Names are unique at a table, and in the lobby the refusal must come before
  // the engine's own name check is reachable.
  bad.ws.clear();
  bad.send({ type: 'join', code, name: 'alice', clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'name-taken', 'a duplicate name is refused, case-insensitively');
  ok(manager.get(code).engine.players.length === 4, 'and the table did not change');
  ok(manager.get(code).engine.players[0].id === 'p1', "and Alice's seat is untouched");

  // A full table refuses the fifth.
  bad.ws.clear();
  bad.send({ type: 'join', code, name: 'Zoe', clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'refused', 'a fifth player at a four-seat table is refused');
  ok(manager.get(code).engine.players.length === 4, 'and the table is still four');
}

// ===========================================================================
section('session: lobbyQuery answers only public facts');
// ===========================================================================
{
  const { manager, code, owner } = table(FOUR);
  const probe = connect(manager, 'probe');
  probe.send({ type: 'lobbyQuery', code });
  const info = probe.ws.last('lobbyInfo').info;
  ok(info && info.hostName === 'Alice' && info.playerCount === 4, 'lobbyQuery reports host and count');
  ok(info.maxPlayers === 4 && info.joinable === false,
    'a table that is full is not joinable, and says how big it is');
  ok(!('players' in info) && !('seats' in info) && !JSON.stringify(info).includes('client'),
    'and carries no seat, hand or device identifiers');

  probe.ws.clear();
  probe.send({ type: 'lobbyQuery', code: 'ZZZZ' });
  ok(probe.ws.last('lobbyInfo').info === null, 'an unknown code returns null rather than an error');
  probe.ws.clear();
  probe.send({ type: 'lobbyQuery', code: 12345 });
  ok(probe.ws.last('lobbyInfo').info === null, 'a non-string code returns null');

  owner.send({ type: 'startGame' });
  probe.ws.clear();
  probe.send({ type: 'lobbyQuery', code });
  ok(probe.ws.last('lobbyInfo').info.joinable === false, 'a started game is not joinable');
  ok(manager.joinable().length === 0, 'and it drops off the public room list');
}

// ===========================================================================
section('session: the room list lists only joinable lobbies');
// ===========================================================================
{
  const m = new RoomManager();
  const a = connect(m, 'a');
  a.send({ type: 'createRoom', name: 'Alice', clientId: cid('alice') });
  const codeA = a.ws.last('welcome').code;
  const b = connect(m, 'b');
  b.send({ type: 'createRoom', name: 'Bea', clientId: cid('bea') });
  const codeB = b.ws.last('welcome').code;

  ok(m.joinable().length === 2, 'both open lobbies are listed');

  // "Full" is per-room in Literature, because the table size is a host setting.
  const room = m.get(codeB);
  room.engine.setConfig('p1', { numPlayers: 4 });
  for (let i = 2; i <= 4; i += 1) room.engine.addPlayer('p' + i, 'Extra' + i);
  ok(room.engine.players.length === 4, 'the room filled up to its own configured size');
  const list = m.joinable();
  ok(list.length === 1 && list[0].code === codeA, 'a full lobby is not offered');
  ok(list[0].hostName === 'Alice' && typeof list[0].playerCount === 'number',
    'the listing carries a host name and a count');
  ok(!JSON.stringify(list[0]).includes('client'), 'and no device identifiers');

  // A six-seat room with four in it is still joinable — the same count that was
  // "full" above.
  const c = connect(m, 'c');
  c.send({ type: 'createRoom', name: 'Cy', clientId: cid('cy') });
  const big = m.get(c.ws.last('welcome').code);
  for (let i = 2; i <= 4; i += 1) big.engine.addPlayer('q' + i, 'Q' + i);
  ok(big.engine.config.numPlayers === 6 && big.info().joinable === true,
    'four at a six-seat table is not full');
}

// ===========================================================================
section('SECURITY: a seat belongs to a clientId, never to a name');
// ===========================================================================
{
  seed(31);
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });
  ok(room.engine.phase === PHASES.PLAY, 'the game started');

  const aliceHand = clients[0].state.priv.hand.map((c) => c.code);
  ok(aliceHand.length === 12, 'Alice holds a full hand');

  // THE attack this server exists to refuse, and in Literature the prize is the
  // whole game rather than an advantage: one look at a hand decides every set
  // that is left. Room codes are four characters and /rooms publishes the open
  // ones, so "type Alice's name into her game and take her hand" has to be
  // impossible rather than unlikely.
  const attacker = connect(manager, 'attacker');
  attacker.send({ type: 'join', code, name: 'Alice', clientId: 'attacker-client-1' });
  const refusal = attacker.ws.last('rejected');
  ok(refusal && refusal.reason === 'in-progress',
    "a stranger using a seated player's name mid-game is refused");
  ok(attacker.ws.all('state').length === 0, 'and is sent no state at all');
  ok(attacker.ws.all('welcome').length === 0, 'and no seat');
  ok(room.engine.playerById('p1').name === 'Alice' && room.engine.hostId === 'p1',
    "Alice's seat and the host id are unchanged");
  ok(JSON.stringify(room.engine.cardsOf('p1')) === JSON.stringify(aliceHand),
    "and Alice's hand is untouched");

  // The same attempt with a name nobody is using is refused for the same reason:
  // mid-game there is no path into addPlayer at all.
  attacker.ws.clear();
  attacker.send({ type: 'join', code, name: 'Nobody', clientId: 'attacker-client-2' });
  ok(attacker.ws.last('rejected').reason === 'in-progress', 'no mid-game joins, full stop');
  ok(room.engine.players.length === 4, 'the table is still four');

  // And the owner's chair cannot be taken by claiming to be the owner.
  attacker.ws.clear();
  attacker.send({ type: 'createRoom', name: 'Alice', clientId: 'attacker-client-3' });
  ok(manager.get(code).engine.hostId === 'p1', 'creating a room elsewhere does not touch this one');
}

// ===========================================================================
section('SECURITY: the right device reclaims the right seat, mid-game');
// ===========================================================================
{
  seed(32);
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });
  const bobHand = JSON.stringify(room.engine.cardsOf('p2'));

  // Bob's phone locks. Unlike Sequence, Literature holds the seat in BOTH phases
  // — the cards are dealt and there is nobody to deal them to again.
  clients[1].drop();
  ok(room.engine.playerById('p2').online === false, 'a mid-game dropout is marked away');
  ok(room.engine.playerById('p2') !== null, 'and keeps the seat');
  ok(room.engine.cardsOf('p2').length > 0, 'and the hand');
  ok(room.sockets.has('p2') === false, 'and the socket is released');
  ok(clients[0].state.pub.players.find((p) => p.id === 'p2').online === false,
    'and the table was told');

  // Bob comes back on a new socket, with a different name in the box, and gets
  // his own seat back — under his own name, because a reclaim is not a rename.
  const back = connect(manager, 'bob-again');
  back.send({ type: 'join', code, name: 'Robert The Impostor', clientId: cid('Bob') });
  const w = back.ws.last('welcome');
  ok(w && w.playerId === 'p2', 'the returning device gets its own seat back');
  ok(room.engine.playerById('p2').name === 'Bob', 'and comes back under the name it left with');
  ok(room.engine.playerById('p2').online === true, 'and is online again');
  ok(JSON.stringify(room.engine.cardsOf('p2')) === bobHand, 'with the same hand');
  ok(back.state.priv.hand.length > 0, 'and is sent that hand immediately');
  ok(room.engine.players.length === 4, 'no extra seat was created');

  // A second device on the same clientId takes over rather than doubling up —
  // and, critically, the OLD socket's close event must not then release the seat
  // the new one just took.
  const third = connect(manager, 'bob-third');
  third.send({ type: 'join', code, name: 'Bob', clientId: cid('Bob') });
  ok(back.ws.last('rejected').reason === 'replaced', 'the displaced socket is told why');
  ok(back.ws.readyState === 3, 'and closed');
  ok(room.sockets.get('p2') === third.ws, 'the seat points at the new socket');
  back.session.detach();
  ok(room.engine.playerById('p2').online === true,
    'the displaced socket closing afterwards does NOT knock the seat offline');
  ok(room.sockets.get('p2') === third.ws, 'and does not unbind it');
}

// ===========================================================================
section('SECURITY: a clientId buys back the seat it owns, and nothing more');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);

  // In the lobby the seat is held too — a Literature seat is a team assignment
  // other people have arranged around, so it is not released on a blip.
  clients[1].drop();
  ok(room.engine.players.length === 4, 'a lobby dropout keeps the seat');
  ok(room.engine.playerById('p2').online === false, 'and is shown as away');
  ok(room.seats.get(cid('Bob')) === 'p2', 'and the device keeps its claim on it');

  const back = connect(manager, 'bob-again');
  back.send({ type: 'join', code, name: 'Bob', clientId: cid('Bob') });
  ok(back.playerId === 'p2', 'the returning device is re-seated at the same id');
  ok(room.engine.players.length === 4, 'with no duplicate');

  // The one way a claimed seat can vanish: the owner removes the chair while the
  // device is out of the room. The stale claim must not become a skeleton key.
  back.drop();
  owner.send({ type: 'removePlayer', playerId: 'p2' });
  ok(room.engine.playerById('p2') === null, 'the owner removed the seat');
  const orphan = connect(manager, 'bob-orphan');
  orphan.send({ type: 'join', code, name: 'Bob', clientId: cid('Bob') });
  ok(orphan.playerId !== null && orphan.playerId !== 'p2',
    'the device rejoins as a stranger, at a fresh seat');
  ok(room.seats.get(cid('Bob')) === orphan.playerId, 'and the stale claim was replaced');

  // The same thing mid-game is simply refused. A stale claim is not a way in.
  const t2 = table(FOUR);
  t2.clients[1].drop();
  t2.owner.send({ type: 'removePlayer', playerId: 'p2' });
  t2.owner.send({ type: 'fillBots' });
  t2.owner.send({ type: 'startGame' });
  ok(t2.room.engine.phase === PHASES.PLAY, 'the game started without Bob');
  const late = connect(t2.manager, 'bob-late');
  late.send({ type: 'join', code: t2.code, name: 'Bob', clientId: cid('Bob') });
  ok(late.ws.last('rejected').reason === 'in-progress',
    'and a stale claim gets no further than a stranger would mid-game');
  ok(late.ws.all('state').length === 0, 'with no state leaked on the way out');
}

// ===========================================================================
section('SECURITY: host-only intents are refused for everyone else');
// ===========================================================================
{
  seed(33);
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);
  const bob = clients[1];

  const before = JSON.stringify(room.engine.config);
  bob.ws.clear();
  bob.send({ type: 'setConfig', patch: { eightsAsSet: true, showHistory: false } });
  ok(/host/i.test(bob.ws.last('error').message), 'a non-host cannot change the house rules');
  ok(JSON.stringify(room.engine.config) === before, 'and the config did not move');

  const order = room.engine.players.map((p) => p.id).join(',');
  bob.ws.clear();
  bob.send({ type: 'moveSeat', playerId: 'p1', delta: -1 });
  ok(bob.ws.last('error'), 'a non-host cannot reseat anybody');
  bob.ws.clear();
  bob.send({ type: 'shuffleSeats' });
  ok(bob.ws.last('error'), 'a non-host cannot shuffle the seating');
  ok(room.engine.players.map((p) => p.id).join(',') === order, 'and the seating did not move');

  // Seat order IS team assignment in Literature, so this is not cosmetic: being
  // able to reseat is being able to choose your own team-mates.
  bob.ws.clear();
  bob.send({ type: 'removePlayer', playerId: 'p3' });
  ok(bob.ws.last('error'), 'a non-host cannot eject another player');
  ok(room.engine.players.length === 4, 'and nobody left the table');
  bob.ws.clear();
  bob.send({ type: 'addBot' });
  bob.send({ type: 'fillBots' });
  ok(room.engine.players.every((p) => !p.isBot), 'a non-host cannot seat a bot');

  bob.ws.clear();
  bob.send({ type: 'startGame' });
  ok(bob.ws.last('error'), 'a non-host cannot start the game');
  ok(room.engine.phase === PHASES.LOBBY, 'and the game did not start');

  owner.send({ type: 'startGame' });
  ok(room.engine.phase === PHASES.PLAY, 'the host can');

  // The host cannot eject themselves and leave an ownerless room, and cannot
  // reseat mid-game.
  owner.ws.clear();
  owner.send({ type: 'removePlayer', playerId: 'p1' });
  ok(owner.ws.last('error'), 'the host cannot remove their own seat');
  owner.ws.clear();
  owner.send({ type: 'shuffleSeats' });
  ok(owner.ws.last('error'), 'and cannot reshuffle the teams mid-game');
  ok(room.engine.players.length === 4 && room.engine.hostId === 'p1', 'the table is intact');
}

// ===========================================================================
section('SECURITY: a player cannot act as another player, or out of turn');
// ===========================================================================
{
  seed(34);
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });

  const byId = new Map(clients.map((c) => [c.playerId, c]));
  const turnId = room.engine.turnPlayer.id;
  const actor = byId.get(turnId);
  const waiting = clients.find((c) => c.playerId !== turnId
    && c.state.priv.team !== actor.state.priv.team);

  // The actor id comes from the socket's own seat, never from the message, so
  // there is no field to forge. Spelled out as a test because it is the kind of
  // thing a later refactor could quietly break.
  // Read everything off the state message BEFORE any ws.clear() below — the
  // client helper's `.state` is just the last state frame on the wire, so
  // clearing the log to isolate the next reply also throws the state away.
  const askable = actor.state.priv.askable[0];
  const target = actor.state.priv.targets[0];
  const mate = actor.state.priv.teammates.find((t) => !t.isMe);
  const held = actor.state.priv.hand[0].code;
  waiting.ws.clear();
  waiting.send({ type: 'ask', targetId: target.id, code: askable.codes[0], playerId: turnId });
  ok(/turn/i.test(waiting.ws.last('error').message), 'asking out of turn is refused');
  ok(room.engine.turnPlayer.id === turnId, 'and the turn did not move');
  ok(room.engine.askCount === 0, 'and nothing was recorded');

  // Asking your own team-mate, which is the rule the whole game rests on.
  actor.ws.clear();
  actor.send({ type: 'ask', targetId: mate.id, code: askable.codes[0] });
  ok(actor.ws.last('error'), 'asking a team-mate is refused');

  // Asking for a card you already hold — the other rule that makes the ask
  // informative to everyone listening.
  actor.ws.clear();
  actor.send({ type: 'ask', targetId: target.id, code: held });
  ok(actor.ws.last('error'), 'asking for a card you already hold is refused');
  ok(room.engine.askCount === 0, 'and still nothing is on the record');

  // Junk that passes the frame decoder but means nothing.
  actor.ws.clear();
  actor.send({ type: 'notAnIntent', code: 'AS' });
  ok(actor.ws.all('error').length === 0 && actor.ws.all('state').length === 0,
    'an unknown intent is dropped in silence, with no reply to amplify');
  actor.send({ type: 'ask' });
  actor.send({ type: 'ask', targetId: null, code: null });
  actor.send({ type: 'ask', targetId: 'p2', code: 'x'.repeat(9999) });
  actor.send({ type: 'claim', setId: 'ZZ', assignment: { AS: 'p1' } });
  actor.send({ type: 'claim', setId: 'SL', assignment: null });
  actor.send({ type: 'setConfig', patch: 'everything' });
  actor.send({ type: 'moveSeat', playerId: { nested: true }, delta: 1 });
  ok(room.engine.phase === PHASES.PLAY && room.engine.askCount === 0 && room.engine.claims.length === 0,
    'a barrage of malformed intents changes nothing');

  // An unseated socket has no actor to be, so its intents go nowhere.
  const lurker = connect(manager, 'lurker');
  lurker.send({ type: 'ask', targetId: target.id, code: askable.codes[0] });
  lurker.send({ type: 'startGame' });
  lurker.send({ type: 'claim', setId: 'SL', assignment: { AS: 'p1' } });
  ok(lurker.ws.sent.length === 0, 'an unseated socket gets no reply to a game intent');
  ok(room.engine.askCount === 0, 'and changes nothing');
}

// ===========================================================================
section('SECURITY: a hostile config patch is dropped, not stored');
// ===========================================================================
{
  const { manager, code, owner } = table(FOUR);
  const room = manager.get(code);

  owner.send({ type: 'setConfig', patch: { __proto__: { polluted: true }, eightsAsSet: true } });
  ok(({}).polluted === undefined, 'a patch cannot pollute Object.prototype');
  ok(room.engine.config.eightsAsSet === true, 'the legitimate key in the same patch applied');
  ok(!('polluted' in room.engine.config), 'the hostile key is not in the config');

  owner.send({ type: 'setConfig', patch: { constructor: 'nope', evil: 1, turnSeconds: 30 } });
  ok(!('evil' in room.engine.config), 'an unknown key is dropped by sanitizeConfigPatch');
  ok(room.engine.config.turnSeconds === 30, 'and the known one survives');

  // Values are clamped rather than trusted.
  owner.send({ type: 'setConfig', patch: { turnSeconds: 1_000_000 } });
  ok(room.engine.config.turnSeconds === 300, 'an absurd clock is clamped to the maximum');
  owner.send({ type: 'setConfig', patch: { turnSeconds: -5 } });
  ok(room.engine.config.turnSeconds === 0, 'and a negative one to no clock at all');
  owner.send({ type: 'setConfig', patch: { showHistory: 'yes please' } });
  ok(room.engine.config.showHistory === true, 'a stringy boolean does not stick');

  // numPlayers is an enum, and a table that does not divide the deck would be a
  // crash in _deal rather than a bad game.
  owner.send({ type: 'setConfig', patch: { numPlayers: 5 } });
  ok(room.engine.config.numPlayers === 4, 'a five-seat table is refused');
  owner.send({ type: 'setConfig', patch: { numPlayers: 3 } });
  ok(room.engine.config.numPlayers === 4, 'and so is a three-seat one');
  ok(PLAYER_COUNTS.includes(room.engine.config.numPlayers), 'the config is always a legal size');

  const wide = {};
  for (let i = 0; i < 40; i += 1) wide['k' + i] = i;
  wide.showHistory = false;
  owner.send({ type: 'setConfig', patch: wide });
  ok(room.engine.config.showHistory === true,
    'an oversized patch is refused whole, legitimate keys and all');
}

// ===========================================================================
section('SECURITY: the rate limit refuses a flood without amplifying it');
// ===========================================================================
{
  seed(35);
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });

  // A flooder at the door. The bucket sits in FRONT of the dispatch, so a
  // refused message costs the room nothing — no broadcast, and no reply either,
  // because answering "too fast" to every packet of a flood is the amplification
  // the bucket exists to prevent.
  const flooder = connect(manager, 'flooder', { rate: { capacity: 5, refillPerSec: 1, now: 0 } });
  flooder.send({ type: 'join', code, name: 'Flo', clientId: cid('flo') }, 0);
  ok(flooder.ws.all('rejected').length === 1, 'the join itself was refused (game under way)');
  flooder.ws.clear();

  let replies = 0;
  for (let i = 0; i < 500; i += 1) {
    flooder.send({ type: 'lobbyQuery', code }, 0);
    replies = flooder.ws.sent.length;
  }
  ok(replies <= 5, `500 messages at a frozen clock produced at most 5 replies (got ${replies})`);

  // Persistent refusal is a script, not a slow phone, so the socket eventually
  // goes.
  ok(flooder.ws.readyState === 3, 'a sustained flood gets the socket closed');
  ok(flooder.ws.closes[0].code === 1008, 'with a policy-violation close code');
  const sentBefore = flooder.ws.sent.length;
  flooder.send({ type: 'lobbyQuery', code }, 0);
  ok(flooder.ws.sent.length === sentBefore, 'a closed session ignores everything after');

  ok(room.engine.phase === PHASES.PLAY && room.engine.players.length === 4,
    'the game carried on through the flood');

  // A run of hits is a legitimate burst from one seat — it is how you win — and
  // must not look like a flood.
  const bob = clients[1];
  bob.ws.clear();
  for (let i = 0; i < 20; i += 1) bob.send({ type: 'lobbyQuery', code }, 1000);
  ok(bob.ws.all('lobbyInfo').length === 20, 'twenty messages in one moment are all served');
}

// ===========================================================================
section('SECURITY: raw frames that are not text JSON objects');
// ===========================================================================
{
  seed(36);
  const { manager, code, owner } = table(FOUR);
  const room = manager.get(code);
  const before = JSON.stringify(room.engine.publicState());

  owner.ws.clear();
  owner.raw(Buffer.from([0xde, 0xad, 0xbe, 0xef]), true);      // binary
  owner.raw('{"type":"startGame"', false);                      // truncated JSON
  owner.raw('[{"type":"startGame"}]', false);                   // array
  owner.raw('"startGame"', false);                              // bare string
  owner.raw('null', false);
  owner.raw(`{"type":"${'x'.repeat(200)}"}`, false);            // type as payload
  owner.raw(Buffer.from(JSON.stringify({ type: 'nonsense' })), false);
  ok(owner.ws.sent.length === 0, 'none of it produced a reply');
  ok(JSON.stringify(room.engine.publicState()) === before, 'and none of it changed the game');

  // A text frame arriving as a Buffer — which is how `ws` delivers it — must
  // still work, or nothing would.
  owner.raw(Buffer.from(JSON.stringify({ type: 'startGame' })), false);
  ok(room.engine.phase === PHASES.PLAY, 'a real intent in a Buffer is honoured');
}

// ===========================================================================
section('SECURITY: the seat map cannot grow without bound');
// ===========================================================================
{
  const { manager, code, owner } = table(['Alice']);
  const room = manager.get(code);
  owner.send({ type: 'setConfig', patch: { numPlayers: 8 } });

  // 200 devices churn at the door. Most are refused (the table is eight seats),
  // but every accepted one leaves a claim behind so that it could come back —
  // and the map has to stay finite either way.
  for (let i = 0; i < 200; i += 1) {
    const c = connect(manager, 'churn' + i);
    c.send({ type: 'join', code, name: 'Churn' + i, clientId: `churn-client-${1000 + i}` });
    c.drop();
  }
  ok(room.seats.size <= 48, `the seat map stayed bounded (${room.seats.size} entries)`);
  ok(room.seatNames.size <= 48, 'and so did the recorded names');
  ok(room.seats.get(cid('Alice')) === 'p1', "the owner's claim was never pruned");
  ok(room.engine.hostId === 'p1', 'so the room is still ownable');
  ok(room.engine.players.length <= 8, 'and the table never grew past its configured size');

  // The owner can still be re-seated after all that.
  owner.drop();
  const back = connect(manager, 'alice-again');
  back.send({ type: 'join', code, name: 'Alice', clientId: cid('Alice') });
  ok(back.ws.last('welcome') && back.ws.last('welcome').owner === true,
    'and the owner comes back as the owner');
}

// ===========================================================================
section('whole games, played over the wire');
// ===========================================================================
{
  // Not a unit test. This drives four sockets through Session.handleFrame() until
  // somebody wins, and each seat decides its move from NOTHING BUT the state
  // message that arrived on its own socket — public half plus its own private
  // half, fed to the same chooseBotMove a browser would call.
  //
  // That makes the privacy guarantee structural rather than asserted: a driver
  // that is only handed its own two halves cannot cheat even if it wanted to. If
  // the private state were ever missing something a player legitimately needs,
  // the games below would stall; if the public state ever carried something it
  // should not, the assertions at the end would catch it.
  for (const [s, names, cfg] of [
    [101, FOUR, { eightsAsSet: false }],
    [102, FOUR, { eightsAsSet: true }],
    [103, SIX, { eightsAsSet: false }],
    [104, SIX, { eightsAsSet: true, claimAnyTime: false }],
    [105, FOUR, { showHistory: false }],
  ]) {
    seed(s);
    const { room, clients, owner } = table(names);
    owner.send({ type: 'setConfig', patch: cfg });
    owner.send({ type: 'startGame' });
    ok(room.engine.phase === PHASES.PLAY, `seed ${s}: the game dealt`);

    const byId = new Map(clients.map((c) => [c.playerId, c]));
    const memories = new Map(clients.map((c) => [c.playerId, new AskMemory()]));
    let moves = 0, errors = 0, asks = 0, claims = 0;
    const cap = 4000;

    while (room.engine.phase === PHASES.PLAY && moves < cap) {
      const actor = byId.get(clients[0].state.pub.turnId);
      if (!actor) break;
      const before = actor.ws.all('error').length;
      const move = playFrom(actor, memories.get(actor.playerId));
      if (!move) break;              // nothing offered: a bug, caught below
      if (move.type === 'ask') asks += 1; else claims += 1;
      if (actor.ws.all('error').length > before) errors += 1;
      moves += 1;

      // Everyone at the table heard that question, not just the seat that will
      // move next. Folding the record into every memory rather than only into
      // the actor's is what a person does by sitting there, and it is load
      // bearing on the showHistory:false seed below: with the record off the
      // public state carries only the LAST question, so a seat that listened
      // only on its own turn would miss most of the game and never learn enough
      // to call a set. That is a property of this stand-in player, not of the
      // server — the real bots read the record off the engine (botdriver.js
      // observe()) precisely because the setting governs what a person is
      // SHOWN, not what the table heard.
      for (const c of clients) if (c.state) memories.get(c.playerId).syncFrom(c.state.pub);
    }

    ok(errors === 0, `seed ${s}: the server never refused a move its own state offered`);
    ok(room.engine.phase === PHASES.GAME_OVER, `seed ${s}: the game finished (${moves} moves)`);
    ok(asks > 0 && claims > 0, `seed ${s}: cards were asked for and sets were called`);

    // NOT "every set was resolved": a game ends the moment one team takes the
    // majority, and the sets still on the table at that point are dead rubber
    // that nobody ever calls. So what has to be true is that no set was resolved
    // twice, and that the game ran until it was actually decided.
    const setIds = room.engine.claims.map((c) => c.setId);
    const total = totalSets(room.engine.config);
    ok(new Set(setIds).size === setIds.length && setIds.length <= total,
      `seed ${s}: no set was resolved twice (${setIds.length}/${total})`);
    ok(setIds.length === total || Math.max(...room.engine.scores()) >= clients[0].state.pub.target,
      `seed ${s}: it ran until a majority or until the sets ran out`);
    ok(room.engine.winner !== null || room.engine.drawn,
      `seed ${s}: with a winner or an honest draw`);

    // Privacy held for the whole game, not just at the deal.
    const finalPub = clients[0].state.pub;
    ok(!('hands' in finalPub), `seed ${s}: the public state never carried hands`);
    for (const c of clients) {
      ok(c.state.priv.id === c.playerId,
        `seed ${s}: ${c.label} only ever received its own private state`);
    }

    // Everyone ended on the same table.
    const boards = clients.map((c) => JSON.stringify(c.state.pub.claims));
    ok(new Set(boards).size === 1, `seed ${s}: every device agrees on how the sets fell`);
    ok(clients.every((c) => c.state.pub.scores.join() === finalPub.scores.join()),
      `seed ${s}: and on the score`);

    // The record is a house rule about what PEOPLE are shown, so it has to hold
    // over the wire too.
    if (cfg.showHistory === false) {
      ok(finalPub.historyHidden === true && finalPub.history.length <= 1,
        `seed ${s}: with the record off, only the last question is public`);
    }

    // And a rematch works over the wire.
    owner.send({ type: 'newGame' });
    ok(room.engine.phase === PHASES.PLAY, `seed ${s}: newGame deals again`);
    ok(clients[clients.length - 1].state.priv.hand.length > 0,
      `seed ${s}: with fresh hands for everybody`);
    ok(room.engine.claims.length === 0, `seed ${s}: and a clean slate of sets`);
  }
}

// ===========================================================================
section('a dropout and a reconnect in the middle of a real game');
// ===========================================================================
{
  seed(121);
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });

  const byId = new Map(clients.map((c) => [c.playerId, c]));
  const memories = new Map(clients.map((c) => [c.playerId, new AskMemory()]));
  for (let i = 0; i < 12 && room.engine.phase === PHASES.PLAY; i += 1) {
    const actor = byId.get(clients[0].state.pub.turnId);
    if (!actor || !playFrom(actor, memories.get(actor.playerId))) break;
  }
  ok(room.engine.askCount > 0, 'a few questions were asked');

  const caraHand = JSON.stringify(room.engine.cardsOf('p3'));
  const claimsBefore = JSON.stringify(room.engine.claims);

  clients[2].drop();
  ok(room.engine.playerById('p3').online === false, 'Cara is away');
  ok(clients[0].state.pub.players.find((p) => p.id === 'p3').online === false,
    'and the table was told');
  ok(JSON.stringify(room.engine.claims) === claimsBefore, 'the resolved sets are untouched');
  ok(JSON.stringify(room.engine.cardsOf('p3')) === caraHand, 'and so is her hand');

  const back = connect(manager, 'cara-again');
  back.send({ type: 'join', code, name: 'Cara', clientId: cid('Cara') });
  ok(back.playerId === 'p3', 'Cara reclaims her seat');
  ok(JSON.stringify(back.state.priv.hand.map((c) => c.code)) === caraHand, 'and her exact hand');
  // The table as it stands NOW, not as she left it — and the public record in
  // particular, because that record is the only way back into a game of
  // Literature. Coming back to a hand without the questions that were asked over
  // it is coming back to a different game.
  ok(back.state.pub.turnId === room.engine.turnPlayer.id, 'and is told whose turn it is now');
  ok(back.state.pub.history.length === room.engine.history.length
    && back.state.pub.history.length >= room.engine.askCount,
    'and every question asked while she was gone');
  ok(back.state.pub.claims.length === room.engine.claims.length,
    'and every set called while she was gone');
  ok(room.engine.playerById('p3').online === true, 'and is online');
  ok(room.engine.players.length === 4, 'with no duplicate seat');

  const views = [clients[0], clients[1], back, clients[3]].map((c) => JSON.stringify(c.state.pub));
  ok(new Set(views).size === 1, 'and every device agrees on the public state');

  // The game can still be finished from here, which is the real test of a
  // reconnect: her memory of what was asked is rebuilt from the public record.
  byId.set('p3', back);
  memories.set('p3', new AskMemory());
  let guard = 0;
  while (room.engine.phase === PHASES.PLAY && guard < 4000) {
    const actor = byId.get(clients[0].state.pub.turnId);
    if (!actor || !playFrom(actor, memories.get(actor.playerId))) break;
    guard += 1;
  }
  ok(room.engine.phase === PHASES.GAME_OVER, 'the game finished after the reconnect');
}

// ===========================================================================
section('the engine is shared, not copied');
// ===========================================================================
{
  // The whole design rests on the server running the same GameEngine the browser
  // runs. If that ever stopped being true — a vendored copy, a divergent import
  // — the two would drift, so it is asserted rather than assumed.
  const room = new Room('SAME', 0);
  ok(room.engine instanceof GameEngine, 'a Room owns a real GameEngine');
  const direct = new GameEngine();
  ok(Object.getPrototypeOf(room.engine) === Object.getPrototypeOf(direct),
    'and it is the very same class the client imports');
  ok(room.engine.phase === PHASES.LOBBY, 'starting, as always, in the lobby');

  // cleanName is likewise one definition for two transports: the server has to
  // bound a name before it reaches addPlayer, and a second copy would be a second
  // answer to "what is a name".
  ok(cleanName('  Anna   Karenina  ') === 'Anna Karenina', 'cleanName collapses whitespace');
  ok(cleanName('Anna\tKarenina') === 'Anna Karenina',
    'a control character becomes a space rather than vanishing');
  ok(!cleanName('Ned\n[game] FORGED').includes('\n'), 'and a newline cannot survive it');
  ok(cleanName('x'.repeat(200)).length === 16, 'and the result is bounded');
}

// ===========================================================================
section('the clock: one interval skips overdue turns in every room');
// ===========================================================================
{
  // The engine half of the turn timer is proved exhaustively in test-engine.mjs.
  // What is only true on this transport is that something actually TICKS it, that
  // the skip reaches the devices, and that a self-advancing game does not thereby
  // become immortal. All three use an explicit `now`, so the suite never waits 15
  // real seconds for a 15-second clock.
  seed(131);
  const { manager, code, clients, owner } = table(FOUR);
  const room = manager.get(code);
  owner.send({ type: 'setConfig', patch: { turnSeconds: 15 } });
  owner.send({ type: 'startGame' });

  const deadline = room.engine.turnEndsAt;
  ok(deadline != null, 'a game started on the server is on the clock');
  ok(clients[0].state.pub.config.turnSeconds === 15, 'and every device is told the duration');
  ok(clients[0].state.pub.turnEndsAt === deadline, 'and the deadline itself, not a countdown');

  const first = room.engine.turnPlayer.id;
  for (const c of clients) c.ws.clear();

  ok(manager.tickClocks(deadline - 1) === 0, 'a tick before the deadline fires nothing');
  ok(clients[0].ws.all('state').length === 0, 'and sends nobody anything');

  ok(manager.tickClocks(deadline) === 1, 'the tick on the deadline skips exactly one room');
  ok(room.engine.turnPlayer.id !== first, 'the turn moved on with no player acting');
  for (const c of clients) {
    ok(c.ws.all('state').length === 1, `${c.label} was told about the skip`);
    ok(c.state.pub.turnId === room.engine.turnPlayer.id,
      `...and ${c.label} agrees on whose turn it now is`);
  }

  // A room whose game is untimed must not be woken up by the shared interval.
  seed(132);
  const idle = table(FOUR);
  idle.owner.send({ type: 'startGame' });
  ok(idle.room.engine.turnEndsAt === null, 'an untimed room has no deadline');
  const who = idle.room.engine.turnPlayer.id;
  ok(idle.manager.tickClocks(Date.now() + 9e9) === 0, 'and is never advanced by the clock');
  ok(idle.room.engine.turnPlayer.id === who, 'so its turn stays where it was');

  // The reason tickClocks does not touch() the rooms it advances: a timed game
  // left running would keep advancing turns forever, and if each skip counted as
  // activity the sweep would never see it go idle.
  seed(133);
  const base = Date.now();
  const abandoned = new RoomManager({ maxRooms: 10, emptyTtlMs: 1000, idleTtlMs: 50_000 });
  const r = abandoned.create(base).room;
  r.engine.addPlayer('p1', 'Alice', { isHost: true });
  r.engine.setConfig('p1', { numPlayers: 4, turnSeconds: 15 });
  for (let i = 2; i <= 4; i += 1) r.engine.addPlayer('p' + i, 'P' + i);
  ok(r.engine.startGame('p1').ok, 'a timed game is running in a room nobody is watching');
  const ws = new StubSocket('zombie');
  r.sockets.set('p1', ws);                     // open socket: not "empty", just idle
  const activity = r.lastActivity;
  let ticks = 0;
  for (let t = base + 20_000; t <= base + 40_000; t += 1000) ticks += abandoned.tickClocks(t);
  ok(ticks > 0, 'an abandoned timed game does keep skipping turns');
  ok(r.lastActivity === activity, 'but the server talking to itself is not activity');
  ok(abandoned.sweep(base + 60_000) === 1 && abandoned.size === 0,
    'so the table is still collected once it is genuinely idle');
}

// ===========================================================================
section('bots and empty chairs on the server transport');
// ===========================================================================
//
// The brain is proved in test-bots.mjs and the seating rules in test-engine.mjs.
// What is left — and what can only be checked here — is what the server adds:
// addBot arrives as a frame through a real Session, tickBots drives the seats off
// the same one-second interval as tickClocks, and a bot is NOT a connection.
{
  seed(141);
  const { manager, room, owner, clients } = table(FOUR);

  // ---- only the host ----------------------------------------------------
  clients[1].send({ type: 'addBot' });
  ok(room.engine.players.length === 4, 'a player who is not the host cannot seat a bot');
  ok(clients[1].ws.all('error').length === 1, 'and is told so');

  // A four-seat table is already full of people, so make room first.
  owner.send({ type: 'removePlayer', playerId: 'p4' });
  owner.send({ type: 'removePlayer', playerId: 'p3' });

  // Being removed is announced the same way on both transports: a state frame
  // whose private half is null, which js/main.js reads as "the host removed you"
  // once it has been welcomed. The socket is left open on purpose — it is the
  // client that leaves, and it needs the frame to know to.
  const ousted = clients[3];
  ok(ousted.state && ousted.state.priv === null,
    'a removed device is told, by a state frame with no hand in it');
  ok(ousted.ws.readyState === 1, 'and is not cut off before it can read the frame');

  const socketsBefore = room.liveSockets().length;
  const seatsBefore = room.seats.size;
  owner.send({ type: 'addBot' });
  owner.send({ type: 'fillBots' });
  const bots = room.engine.players.filter((p) => p.isBot);
  ok(bots.length === 2, 'the host can seat bots over the wire');
  ok(clients[1].state.pub.players.filter((p) => p.isBot).length === 2,
    'and every attached device is told which seats are computers');

  // ---- a bot is not a connection ----------------------------------------
  // Measured as a delta, because the two removed players still have their
  // sockets attached (above) and would otherwise be counted as the bots'.
  ok(room.liveSockets().length === socketsBefore, 'seating two bots opened no sockets');
  ok(bots.every((b) => b.clientId === null), 'a bot carries no clientId to be reclaimed with');
  ok(room.seats.size === seatsBefore, 'and added no entry to the seat map');
  // A bot's id is predictable ("bot:austen"), so if it could be reclaimed the
  // whole clientId rule would be for nothing. The name is read off the engine
  // rather than written in: which author gets seated depends on the seed, and a
  // hard-coded one would quietly start testing "a stranger can join" instead.
  const botName = bots[0].name;
  const impostor = connect(manager, 'impostor');
  impostor.send({ type: 'join', code: room.code, name: botName, clientId: 'impostor-client-1' });
  const refusal = impostor.ws.last('rejected');
  ok(refusal && refusal.reason === 'name-taken', `a bot's name (${botName}) is taken like anyone's`);
  ok(room.engine.players.filter((p) => p.isBot).length === 2, 'and the bot seats are untouched');

  // ---- they play --------------------------------------------------------
  owner.send({ type: 'startGame' });
  ok(room.engine.phase === PHASES.PLAY, 'four seats, and the game starts');

  const base = Date.now();
  let now = base, moved = 0, ticks = 0;
  const byId = new Map(clients.map((c) => [c.playerId, c]));
  const memories = new Map(clients.map((c) => [c.playerId, new AskMemory()]));
  // Driven exactly the way index.js does it: clocks then bots, once a second.
  // The two humans play themselves; the bots are driven by the interval.
  while (room.engine.phase === PHASES.PLAY && ticks < 40_000) {
    ticks += 1;
    manager.tickClocks(now);
    moved += manager.tickBots(now);
    const actor = byId.get(clients[0].state.pub.turnId);
    if (actor) playFrom(actor, memories.get(actor.playerId));
    now += 1000;
  }
  ok(room.engine.phase === PHASES.GAME_OVER, 'a game with bots in it finishes on the server');
  ok(moved > 5, `and the bots made their own moves (${moved} of them)`);
  ok(owner.ws.all('state').length > moved, 'each bot move was broadcast to the table');

  // A room with no bots and nobody away must not be woken by the shared interval.
  seed(142);
  const quiet = table(FOUR);
  quiet.owner.send({ type: 'startGame' });
  const before = quiet.owner.ws.all('state').length;
  ok(quiet.manager.tickBots(Date.now() + 9e9) === 0, 'tickBots does nothing to an all-human room');
  ok(quiet.owner.ws.all('state').length === before, 'and sends nobody anything');
}

// ===========================================================================
section('the away-seat rule: one closed tab must not stop the table');
// ===========================================================================
{
  // This matters far more in Literature than in a game where the turn simply
  // rotates: A HIT KEEPS THE TURN. A seat that goes quiet does not cost the table
  // one beat, it stops the game outright, for as long as the tab stays shut —
  // and with no clock there is nothing else to move it on.
  seed(151);
  const { manager, room, owner, clients } = table(FOUR);
  owner.send({ type: 'startGame' });
  ok(room.engine.config.turnSeconds === 0, 'an untimed game, which is the default');

  const stuckOn = room.engine.turnPlayer.id;
  const victim = clients.find((c) => c.playerId === stuckOn);
  victim.drop();
  ok(room.engine.playerById(stuckOn).online === false, 'the seat on turn went away');

  const base = Date.now();
  // Well inside the away pause: nothing should have happened yet.
  ok(manager.tickBots(base + 1000) === 0, 'a moment of silence is not treated as a departure');
  ok(room.engine.turnPlayer.id === stuckOn, 'and the turn is still theirs');

  const askedBefore0 = room.engine.askCount;
  let moved = 0;
  for (let t = base; t < base + 600_000 && room.engine.turnPlayer.id === stuckOn; t += 1000) {
    moved += manager.tickBots(t);
  }
  ok(moved > 0, `the empty chair was played (${moved} moves)`);
  ok(room.engine.askCount > askedBefore0 || room.engine.claims.length > 0,
    'it really took its turn rather than being skipped');
  ok(room.engine.turnPlayer.id !== stuckOn || room.engine.phase !== PHASES.PLAY,
    'and the table is moving again');

  // It stops there, and that is the point of the rule rather than a shortcoming
  // of it: the other three tabs are still open, so the driver hands the game
  // back the moment the turn reaches a seat somebody is sitting in.
  const nowOn = room.engine.turnPlayer && room.engine.turnPlayer.id;
  ok(manager.tickBots(base + 900_000) === 0, 'a seat with somebody in it is left alone');
  ok(room.engine.turnPlayer.id === nowOn, 'and keeps its turn');

  // When every tab goes, the table finishes by itself. Worth its own assertion:
  // in a game where a hit keeps the turn, "the driver can carry a whole game" is
  // a much stronger claim than "the driver can take one turn".
  for (const c of clients) if (c.playerId !== stuckOn) c.drop();
  let carried = 0;
  for (let t = base; t < base + 3_600_000 && room.engine.phase === PHASES.PLAY; t += 1000) {
    carried += manager.tickBots(t);
  }
  ok(room.engine.phase === PHASES.GAME_OVER,
    `an abandoned game plays itself out (${carried} driven moves)`);
  ok(room.engine.winner !== null || room.engine.drawn, 'and reaches a real result');
  const abandonedSets = room.engine.claims.map((c) => c.setId);
  ok(new Set(abandonedSets).size === abandonedSets.length
    && abandonedSets.length <= totalSets(room.engine.config),
    'with no set called twice on the way');

  // The server is more patient than a browser host, because a server table has
  // nobody in the room to say "hang on, my screen locked".
  const { SERVER_AWAY_MS } = await import('../server/rooms.js');
  const { AWAY_PLAY_MS } = await import('../js/bots.js');
  ok(SERVER_AWAY_MS > AWAY_PLAY_MS,
    'and it waits longer than the peer-to-peer host does before doing it');

  // A player who comes back before the pause is up keeps their own turn.
  seed(152);
  const t2 = table(FOUR);
  t2.owner.send({ type: 'startGame' });
  const onTurn = t2.room.engine.turnPlayer.id;
  const askedBefore = t2.room.engine.askCount;
  t2.clients.find((c) => c.playerId === onTurn).drop();
  const t0 = Date.now();
  t2.manager.tickBots(t0 + 1000);
  const rejoin = connect(t2.manager, 'back');
  rejoin.send({ type: 'join', code: t2.code, name: t2.room.engine.playerById(onTurn).name,
    clientId: cid(t2.room.engine.playerById(onTurn).name) });
  ok(rejoin.playerId === onTurn, 'the seat was reclaimed');
  ok(t2.manager.tickBots(t0 + 120_000) === 0, 'and is no longer played for them');
  ok(t2.room.engine.turnPlayer.id === onTurn && t2.room.engine.askCount === askedBefore,
    'their turn was waiting exactly where they left it');
}

// ===========================================================================
section('bots do not keep an abandoned table alive');
// ===========================================================================
{
  // The sharper version of the tickClocks case: bots go on playing to nobody, so
  // if their moves counted as activity, or if a seated bot counted as an
  // occupant, a room of bots would be immortal on a 2GB box with no accounts.
  seed(161);
  const base = Date.now();
  const manager = new RoomManager({ maxRooms: 10, emptyTtlMs: 1000, idleTtlMs: 50_000 });
  const room = manager.create(base).room;
  room.engine.addPlayer('p1', 'Alice', { isHost: true, clientId: 'alice-client-1' });
  // On the clock, because the seat that walked away is a HUMAN one and the
  // engine still believes somebody is in it — an open tab is what `online` means.
  // The driver will not play an occupied seat, so without a clock this table
  // would sit on Alice's turn forever and the bots would never get a move: that
  // is the away-seat rule declining to act, not the bots failing to. The clock is
  // what hands the turn on, which is exactly the pairing index.js runs.
  room.engine.setConfig('p1', { numPlayers: 4, turnSeconds: 15 });
  room.engine.fillWithBots('p1');
  ok(room.engine.startGame('p1').ok, 'a game of one human and three bots is running');

  const ws = new StubSocket('lonely');
  room.sockets.set('p1', ws);                  // open socket: idle, not empty
  const activity = room.lastActivity;
  let moved = 0;
  for (let t = base + 2000; t <= base + 300_000; t += 1000) {
    manager.tickClocks(t);
    moved += manager.tickBots(t);
  }
  ok(moved > 0, 'the bots do carry on playing while nobody is looking');
  ok(room.lastActivity === activity, 'but the server playing against itself is not activity');
  ok(manager.sweep(base + 400_000) === 1 && manager.size === 0,
    'so the table is still collected once the last human goes idle');

  // And the same room with the socket actually gone must read as empty, not as
  // "three bots are still in here".
  const solo = new RoomManager({ maxRooms: 10, emptyTtlMs: 1000, idleTtlMs: 50_000 });
  const r2 = solo.create(base).room;
  r2.engine.addPlayer('p1', 'Alice', { isHost: true });
  r2.engine.addBot('p1');
  ok(r2.isEmpty === true, 'a room holding a bot and no open socket is empty');
  ok(solo.sweep(base + 5000) === 1, 'and is swept on the short empty timer');
}

// ===========================================================================
section('the operator log: one line when a game starts, one when it ends');
// ===========================================================================
{
  // The Pi's terminal is the only window onto a server whose screens are all in
  // other people's hands, so these two lines are a feature rather than a debug
  // aid. What needs pinning down is that they follow the PHASE TRANSITION and not
  // the broadcast: broadcast() runs on every state change, and a line each time
  // would bury the journal under a game's worth of asks.
  //
  // console.log is swapped out around the actions only — ok() prints through it,
  // so the assertions all happen after it has been put back.
  const capture = (fn) => {
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { fn(); } finally { console.log = real; }
    return lines.filter((l) => l.startsWith('[game]'));
  };

  seed(171);
  const { room, owner, clients } = table(FOUR);
  const code = room.code;

  const started = capture(() => {
    owner.send({ type: 'startGame' });
    room.broadcast();                    // extra fan-outs must not repeat the line
    room.broadcast();
  });
  ok(started.length === 1, 'starting a game prints exactly one line, however many broadcasts follow');
  ok(started[0].startsWith(`[game] ${code} START`), 'tagged [game], and says which room');
  ok(started[0].includes('owner="Alice"'), 'and names the owner');
  ok(FOUR.every((n) => started[0].includes(`"${n}"`)), 'and lists every player at the table');
  ok(started[0].includes('[Ink]') && started[0].includes('[Rust]'),
    'each with the team they are actually on');
  ok(started[0].includes('sets=8'), 'and how many sets are in play');

  // A real finish, played out over the wire, so the winner and the score come
  // from the engine rather than from the test poking fields.
  const byId = new Map(clients.map((c) => [c.playerId, c]));
  const memories = new Map(clients.map((c) => [c.playerId, new AskMemory()]));
  const ended = capture(() => {
    let guard = 0;
    while (room.engine.phase === PHASES.PLAY && guard < 4000) {
      const actor = byId.get(clients[0].state.pub.turnId);
      if (!actor || !playFrom(actor, memories.get(actor.playerId))) break;
      guard += 1;
    }
    room.broadcast();
    room.broadcast();
  });
  ok(room.engine.phase === PHASES.GAME_OVER, 'the game really did finish');
  ok(ended.length === 1, 'and it prints exactly one closing line');
  ok(ended[0].startsWith(`[game] ${code} END`), 'tagged and addressed the same way');
  ok(/WINS|DRAW/.test(ended[0]), 'saying how it ended');
  ok(ended[0].includes('Ink ') && ended[0].includes('Rust '), 'with the score for both teams');
  if (room.engine.winner !== null) {
    ok(ended[0].includes(teamName(room.engine.winner)), 'and naming the winning team');
  }

  // A rematch is a second game, and reads as one.
  const again = capture(() => { owner.send({ type: 'newGame' }); });
  ok(again.length === 1 && again[0].includes('START'),
    'a rematch prints a fresh START and nothing for the trip through the lobby');

  // A table that never gets going says nothing at all.
  seed(172);
  const t3 = table(FOUR);
  const quiet = capture(() => { t3.room.broadcast(); t3.room.broadcast(); });
  ok(quiet.length === 0, 'a lobby that never starts a game stays out of the journal');

  // A name cannot forge a line: control characters are replaced before a player
  // is ever seated, so there is no newline left to break out with.
  seed(173);
  const t4 = table(['Mia']);
  t4.owner.send({ type: 'setConfig', patch: { numPlayers: 4 } });
  connect(t4.manager, 'Ned').send({
    type: 'join', code: t4.code, name: 'Ned\n[game] FORGED START', clientId: cid('Ned'),
  });
  ok(t4.room.engine.players.length === 2, 'a newline name is seated, cleaned, not refused');
  t4.owner.send({ type: 'fillBots' });
  const hostile = capture(() => { t4.owner.send({ type: 'startGame' }); });
  ok(hostile.length === 1, 'and does not buy a second log line');
  ok(!hostile[0].includes('\n'), 'the entry is still a single line');
  // cleanName turns the newline into a space and then cuts at 16 characters, so
  // what lands in the roster is "Ned [game] FORGE" — quoted, inside the list,
  // and missing the word that would have made it look like an entry.
  ok(hostile[0].includes(`"${cleanName('Ned\n[game] FORGED START')}"`),
    'the smuggled text is quoted and truncated inside the roster');
  ok(!/^\[game\] FORGED/m.test(hostile.join('\n')),
    'and no line of the journal begins with it');
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
