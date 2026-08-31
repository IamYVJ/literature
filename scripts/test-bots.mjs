// ============================================================================
// test-bots.mjs — Exercises the bot brain and the intent dispatcher.
// Run: node scripts/test-bots.mjs
//
// Two things matter here and neither is "does the bot play well":
//
//   SOUNDNESS. Every fact the bot calls certain is checked against the real
//   hands on every single turn of every game. A bot that deduces something false
//   would make confident claims that fail, which is indistinguishable from
//   cheating badly, and much harder to notice by playing.
//
//   NO PEEKING. A bot must not be able to conclude anything about a teammate's
//   cards that it was not told. The fixtures below set up exactly the situation
//   where peeking would show: a teammate holding a whole set, with nothing in
//   the public record about it.
// ============================================================================

function seedCrypto(seed) {
  let s = seed >>> 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i += 1) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          arr[i] = s;
        }
        return arr;
      },
    },
  });
}
seedCrypto(20260831);

const { readFileSync } = await import('node:fs');
const { setCards, sortCards } = await import('../js/cards.js');
const { PLAYER_COUNTS, buildDeck, totalSets, majorityTarget } = await import('../js/rules.js');
const { GameEngine, PHASES } = await import('../js/state.js');
const { AskMemory, buildAssignment, chooseBotMove, deduceHolders } = await import('../js/bots.js');
const { applyGameIntent } = await import('../js/intents.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error('  x FAIL:', msg); }
}
function section(t) { console.log('\n- ' + t); }

function botTable(numPlayers, config = {}) {
  const e = new GameEngine({ hostId: 'p0' });
  e.addPlayer('p0', 'Host', { isHost: true, clientId: 'c0' });
  e.setConfig('p0', { numPlayers, ...config });
  e.fillWithBots('p0');
  return e;
}

function setHands(e, map) {
  e.hands = {};
  for (const p of e.players) e.hands[p.id] = sortCards(map[p.id] || []);
}

// ---- The boundary ----------------------------------------------------------
section('bots: the module cannot reach the engine');
{
  const src = readFileSync(new URL('../js/bots.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import[^;]+from\s+'([^']+)'/gm)].map((m) => m[1]);
  ok(!imports.includes('./state.js'), `bots.js does not import state.js (imports: ${imports})`);
  ok(!imports.includes('./net.js'), 'bots.js does not import net.js');
  ok(!/\bengine\b/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'no code path in bots.js touches an engine');
}

// ---- Memory: what an ask tells the table -----------------------------------
section('bots: reading a question and its answer');
{
  const m = new AskMemory();
  m.observeAsk({ n: 1, askerId: 'a', targetId: 'b', code: '4S', setId: 'SL', gotIt: true });
  ok(m.holderOf('4S') === 'a', 'a yes means the asker holds it now');
  ok(m.hasInterest('a', 'SL') === true, 'asking shows you hold a card of that set');
  ok(m.hasInterest('b', 'SL') === true, 'handing one over shows the same');

  m.observeAsk({ n: 2, askerId: 'c', targetId: 'd', code: '5S', setId: 'SL', gotIt: false });
  ok(m.holderOf('5S') === null, 'a no names no holder');
  ok(m.isExcluded('5S', 'd') === true, 'the person who said no does not hold it');
  ok(m.isExcluded('5S', 'c') === true, 'nor does the asker, who could not have asked otherwise');
  ok(m.isExcluded('5S', 'a') === false, 'and nothing is implied about anyone else');

  // A later yes has to win, or the memory would go stale the moment a card moved.
  m.observeAsk({ n: 3, askerId: 'd', targetId: 'a', code: '4S', setId: 'SL', gotIt: true });
  ok(m.holderOf('4S') === 'd', 'a later yes moves the card');

  m.observeClaim({ setId: 'SL' });
  ok(m.holderOf('4S') === null, 'a resolved set is forgotten');
  ok(m.knownCountFor('d') === 0, 'and stops counting against a hand');

  const m2 = new AskMemory();
  const pub = {
    claims: [],
    history: [
      { n: 1, askerId: 'a', targetId: 'b', code: '2S', setId: 'SL', gotIt: true },
      { n: 2, askerId: 'a', targetId: 'b', code: '3S', setId: 'SL', gotIt: true },
    ],
  };
  m2.syncFrom(pub);
  m2.syncFrom(pub);
  ok(m2.seen === 2 && m2.knownCountFor('a') === 2, 'syncFrom is idempotent');
}

// ---- No peeking ------------------------------------------------------------
section('bots: a teammate\'s cards are not visible');

/**
 * Deal a real 4-player game by hand: everyone gets twelve cards, so the counting
 * rules in deduceHolders() face the same arithmetic they would in play. A
 * fixture that leaves cards held by nobody lets those rules prove things that
 * are only true of the fixture — which is a bug in the fixture, not the bot.
 *
 * The leftovers are dealt round-robin rather than in slices. buildDeck() returns
 * cards grouped by set, so contiguous slices hand somebody a complete set, and a
 * player holding a whole set has no legal ask and is forced to claim — not the
 * situation any of these fixtures is trying to set up.
 */
function dealtTable(assign) {
  const e = botTable(4);
  e.startGame('p0');
  const seats = e.players.map((p) => p.id);
  const fixed = assign(seats);

  const spoken = new Set(Object.values(fixed).flat());
  const rest = buildDeck(e.config).filter((c) => !spoken.has(c));

  const hands = {};
  const need = {};
  for (const id of seats) {
    hands[id] = [...(fixed[id] || [])];
    need[id] = 12 - hands[id].length;
  }

  let at = 0;
  for (const code of rest) {
    let guard = 0;
    while (need[seats[at % seats.length]] === 0 && guard < seats.length) {
      at += 1;
      guard += 1;
    }
    const id = seats[at % seats.length];
    hands[id].push(code);
    need[id] -= 1;
    at += 1;
  }

  setHands(e, hands);
  e.turn = 0;
  return { e, seats };
}

{
  // Seats 0 and 2 are a team. Give seat 2 the whole of Low Spades and tell seat
  // 0 nothing whatsoever about it.
  const { e, seats } = dealtTable((s) => ({ [s[2]]: setCards('SL') }));
  const mem = new AskMemory();
  const priv = e.privateStateFor(seats[0]);
  const deduced = deduceHolders(mem, e.publicState(), priv);

  ok([...deduced.values()].every((who) => who === seats[0]),
    'with nothing heard, the only cards placed are my own');
  ok(setCards('SL').every((c) => !deduced.has(c)), 'the teammate\'s set is invisible');

  const built = buildAssignment(deduced, priv, 'SL');
  ok(built !== null, 'the set is not ruled out — a teammate might hold it');
  ok(built.confident === false, 'but nothing about it is known, so it is a guess');

  const move = chooseBotMove(mem, e.publicState(), priv);
  ok(move !== null, 'the bot still has a move');
  ok(move.type === 'ask', `an unforced bot asks rather than guessing a claim, got ${move.type}`);
  ok(priv.mustClaim === false, 'and it was genuinely not forced');
}
{
  // Once it has heard the cards go across, the same bot is certain.
  const { e, seats } = dealtTable((s) => ({
    [s[0]]: ['2S', '3S', '4S'],
    [s[2]]: ['5S', '6S', '7S'],
  }));
  const mem = new AskMemory();
  for (const code of ['5S', '6S', '7S']) {
    mem.observeAsk({ n: mem.seen + 1, askerId: seats[2], targetId: seats[1], code, setId: 'SL', gotIt: true });
  }

  const priv = e.privateStateFor(seats[0]);
  const deduced = deduceHolders(mem, e.publicState(), priv);
  const built = buildAssignment(deduced, priv, 'SL');
  ok(built.confident === true, 'having heard every card land, the bot is certain');

  const move = chooseBotMove(mem, e.publicState(), priv);
  ok(move.type === 'claim' && move.setId === 'SL', `and it claims, got ${move.type}`);
  const res = applyGameIntent(e, seats[0], move);
  ok(res.ok && res.correct, 'the confident claim is correct');
}
{
  // A known opponent holding a card rules the set out entirely.
  const { e, seats } = dealtTable((s) => ({
    [s[0]]: ['2S', '3S'],
    [s[2]]: ['4S', '5S', '6S'],
    [s[1]]: ['7S'],
  }));
  const mem = new AskMemory();
  mem.observeAsk({ n: 1, askerId: seats[1], targetId: seats[3], code: '7S', setId: 'SL', gotIt: true });

  const priv = e.privateStateFor(seats[0]);
  const deduced = deduceHolders(mem, e.publicState(), priv);
  ok(deduced.get('7S') === seats[1], 'the opponent is placed on that card');
  ok(buildAssignment(deduced, priv, 'SL') === null,
    'a set an opponent demonstrably holds part of is not claimable');
}
{
  // Counting, which is how the endgame actually gets solved. A real endgame:
  // every set but Low Spades is already resolved, so only six cards are live and
  // the public hand sizes account for all of them.
  const e = botTable(4);
  e.startGame('p0');
  const seats = e.players.map((p) => p.id);
  const { setsInPlay } = await import('../js/rules.js');
  for (const setId of setsInPlay(e.config)) {
    if (setId === 'SL') continue;
    e.claims.push({ setId, team: e.claims.length % 2, byId: seats[0], byName: 'x', correct: true, wrong: [] });
  }
  setHands(e, {
    [seats[0]]: ['2S', '3S'],
    [seats[1]]: ['4S'],
    [seats[2]]: ['5S', '6S'],
    [seats[3]]: ['7S'],
  });
  e.turn = 0;

  const mem = new AskMemory();
  for (const c of e.claims) mem.observeClaim(c);
  mem.observeAsk({ n: 1, askerId: seats[1], targetId: seats[0], code: '4S', setId: 'SL', gotIt: true });
  mem.observeAsk({ n: 2, askerId: seats[3], targetId: seats[2], code: '7S', setId: 'SL', gotIt: true });

  const priv = e.privateStateFor(seats[0]);
  const deduced = deduceHolders(mem, e.publicState(), priv);
  ok(deduced.get('5S') === seats[2] && deduced.get('6S') === seats[2],
    'the last two cards can only be with the one player who still has room');
  ok(deduced.size === 6, `all six live cards are placed, got ${deduced.size}`);
  for (const [code, who] of deduced) {
    ok(e.cardsOf(who).includes(code), `deduction for ${code} matches the real hand`);
  }

  const built = buildAssignment(deduced, priv, 'SL');
  ok(built === null, 'and the set is correctly ruled out, since opponents hold two of it');
}

// ---- Full bot games --------------------------------------------------------
section('bots: full games are legal, sound and finish');
{
  let totalSteps = 0;
  let confidentClaims = 0;
  let guessedClaims = 0;

  for (let game = 0; game < 30; game += 1) {
    seedCrypto(5000 + game);
    const numPlayers = PLAYER_COUNTS[game % PLAYER_COUNTS.length];
    const eightsAsSet = game % 3 === 0;
    const e = botTable(numPlayers, { eightsAsSet, showHistory: game % 2 === 0 });
    ok(e.startGame('p0').ok, `game ${game}: started`);

    const mem = new AskMemory();
    let step = 0;
    let illegal = 0;
    let unsound = 0;
    let wrongConfident = 0;
    let stuck = 0;

    while (e.phase === PHASES.PLAY && step < 6000) {
      step += 1;

      // SOUNDNESS: every certainty is checked against the truth, every turn.
      for (const [code, who] of mem.holder) {
        if (mem.retired.has(code)) continue;
        if (!e.cardsOf(who).includes(code)) unsound += 1;
      }
      for (const [code, nots] of mem.excluded) {
        if (mem.retired.has(code)) continue;
        for (const who of nots) if (e.cardsOf(who).includes(code)) unsound += 1;
      }

      const me = e.turnPlayer;
      const priv = e.privateStateFor(me.id);

      // And the same for everything DERIVED, which is the part that could be
      // subtly wrong without any single remembered fact being wrong.
      const deduced = deduceHolders(mem, e.publicState(), priv);
      for (const [code, who] of deduced) {
        if (!e.cardsOf(who).includes(code)) unsound += 1;
      }
      const move = chooseBotMove(mem, e.publicState(), priv);
      if (!move) { stuck += 1; break; }

      // A claim is proven or it is a gamble, and only the proven ones carry a
      // promise. `priv.mustClaim` does NOT distinguish them: a bot also gambles
      // when it has a legal ask whose answer it already knows, which is a real
      // position and the one that used to deadlock two bots against each other.
      const built = move.type === 'claim'
        ? buildAssignment(deduced, priv, move.setId)
        : null;

      const res = applyGameIntent(e, me.id, move);
      if (!res.ok) illegal += 1;

      if (move.type === 'claim') {
        if (built?.confident) {
          confidentClaims += 1;
          if (!res.correct) wrongConfident += 1;
        } else {
          guessedClaims += 1;
        }
        if (res.ok) mem.observeClaim(e.claims.at(-1));
      } else if (res.ok) {
        mem.observeAsk(e.history.at(-1));
      }
    }

    ok(illegal === 0, `game ${game}: every bot move was legal`);
    ok(unsound === 0, `game ${game}: every deduction matched the real hands`);
    ok(wrongConfident === 0, `game ${game}: every proven claim was right`);
    ok(stuck === 0, `game ${game}: no bot ever ran out of moves`);
    ok(e.phase === PHASES.GAME_OVER, `game ${game}: finished in ${step} steps`);

    const scores = e.scores();
    ok(scores[0] >= majorityTarget(e.config)
      || scores[1] >= majorityTarget(e.config)
      || e.claims.length === totalSets(e.config),
      `game ${game}: ended for a real reason (${scores})`);

    const held = e.players.flatMap((p) => e.cardsOf(p.id));
    const retired = e.claims.flatMap((c) => setCards(c.setId));
    ok(new Set([...held, ...retired]).size === held.length + retired.length,
      `game ${game}: cards conserved`);

    totalSteps += step;
  }

  ok(confidentClaims > 0, `bots do make deduced claims (${confidentClaims} across 30 games)`);
  // The gamble path is what breaks a table out of a position where nobody has a
  // question left worth asking. If it ever stops being exercised, the deadlock
  // this replaced is back and no other assertion here would notice.
  ok(guessedClaims > 0, `bots do gamble when asking cannot help (${guessedClaims})`);
  console.log(`  (${totalSteps} moves, ${confidentClaims} proven claims, ${guessedClaims} gambled)`);
}

// ---- Dispatcher ------------------------------------------------------------
section('intents: the dispatcher bounds what it accepts');
{
  const e = botTable(4);
  e.startGame('p0');
  const me = e.turnPlayer;

  ok(!applyGameIntent(e, me.id, { type: 'nonsense' }).ok, 'an unknown intent is refused');
  ok(!applyGameIntent(null, me.id, { type: 'ask' }).ok, 'no engine is refused');
  ok(!applyGameIntent(e, null, { type: 'ask' }).ok, 'no actor is refused');

  ok(!applyGameIntent(e, me.id, { type: 'ask', targetId: 'x', code: 'ZZZZ' }).ok, 'a junk code is refused');
  ok(!applyGameIntent(e, me.id, { type: 'ask', targetId: 'x', code: 'A'.repeat(9999) }).ok, 'a huge code is refused');
  ok(!applyGameIntent(e, me.id, { type: 'ask', targetId: '', code: '2S' }).ok, 'an empty target is refused');

  ok(!applyGameIntent(e, me.id, { type: 'claim', setId: 'nope', assignment: {} }).ok, 'a junk set is refused');
  ok(!applyGameIntent(e, me.id, { type: 'claim', setId: 'SL', assignment: {} }).ok, 'an empty claim is refused');
  ok(!applyGameIntent(e, me.id, { type: 'claim', setId: 'SL', assignment: [1, 2] }).ok, 'an array claim is refused');

  const huge = {};
  for (let i = 0; i < 500; i += 1) huge[`k${i}`] = 'v';
  ok(!applyGameIntent(e, me.id, { type: 'claim', setId: 'SL', assignment: huge }).ok, 'a huge claim is refused');
  ok(!applyGameIntent(e, me.id, { type: 'setConfig', patch: huge }).ok, 'a huge config patch is refused');
  ok(!applyGameIntent(e, me.id, { type: 'setConfig', patch: null }).ok, 'a null patch is refused');

  ok(applyGameIntent(e, me.id, { type: 'ask', targetId: 'x', code: '2S' }).changed === false,
    'a refused intent reports no change');
}
{
  const e = botTable(4);
  const res = applyGameIntent(e, 'p0', { type: 'startGame' });
  ok(res.ok && res.changed, 'a good intent reports a change');
  ok(!applyGameIntent(e, e.players[1].id, { type: 'startGame' }).ok, 'host-only stays host-only through the dispatcher');
}

// ---- Guards ----------------------------------------------------------------
section('guards: frames and buckets');
{
  const { decodePeerFrame, validEnvelope, TokenBucket, validClaimAssignment, validCardCode } =
    await import('../js/guards.js');

  ok(validEnvelope({ type: 'ask' }) !== null, 'a well-formed envelope passes');
  ok(validEnvelope([{ type: 'ask' }]) === null, 'an array is not an envelope');
  ok(validEnvelope({ type: 'x'.repeat(500) }) === null, 'a huge type is refused');
  ok(validEnvelope(null) === null, 'null is not an envelope');

  ok(decodePeerFrame('{"type":"ask"}') !== null, 'a JSON text frame decodes');
  ok(decodePeerFrame('not json') === null, 'a malformed frame is refused');
  ok(decodePeerFrame('x'.repeat(70000)) === null, 'an oversized frame is refused');
  ok(decodePeerFrame(new ArrayBuffer(8)) === null, 'a binary frame is refused');

  ok(validCardCode('2S') === '2S', 'a real code passes');
  ok(validCardCode('1S') === null, 'a fake rank fails');
  ok(validCardCode('2X') === null, 'a fake suit fails');
  ok(validCardCode('10S') === null, 'the ten must be written T');

  ok(validClaimAssignment({ '2S': 'a' }) !== null, 'a small assignment passes');
  ok(validClaimAssignment({ zz: 'a' }) === null, 'a bad card key fails the whole assignment');
  ok(validClaimAssignment({ '2S': '' }) === null, 'a bad holder fails the whole assignment');

  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: 0 });
  ok(b.take(0) && b.take(0) && b.take(0), 'the bucket spends its capacity');
  ok(!b.take(0), 'and then refuses');
  ok(b.take(1000), 'a second later it has refilled one');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
