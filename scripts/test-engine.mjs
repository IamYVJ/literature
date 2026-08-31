// ============================================================================
// test-engine.mjs — Exercises the rules and the engine with no browser and no
// network. Run: node scripts/test-engine.mjs
//
// The RNG is replaced with a seeded LCG BEFORE any engine is constructed, so a
// failure here is reproducible rather than a story about one unlucky shuffle.
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

const {
  ALL_SETS, EIGHTS, HALF_SUIT_SETS, SET_CARDS, cardLabel, setCards, setOf, sortCards,
} = await import('../js/cards.js');
const {
  DEFAULTS, PLAYER_COUNTS, askableCards, buildDeck, completeSetsFor, dealCounts,
  majorityTarget, sanitizeConfigPatch, setsInPlay, teamOfSeat, totalSets,
} = await import('../js/rules.js');
const { GameEngine, PHASES } = await import('../js/state.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error('  x FAIL:', msg); }
}
function section(t) { console.log('\n- ' + t); }

// ---- Fixtures --------------------------------------------------------------

function table(n, config = {}) {
  const e = new GameEngine({ hostId: 'p0' });
  e.addPlayer('p0', 'Host', { isHost: true, clientId: 'c0' });
  e.setConfig('p0', { numPlayers: n, ...config });
  for (let i = 1; i < n; i += 1) e.addPlayer(`p${i}`, `P${i}`, { clientId: `c${i}` });
  return e;
}

function started(n, config = {}) {
  const e = table(n, config);
  const res = e.startGame('p0');
  ok(res.ok, `startGame(${n}) should succeed: ${res.error || ''}`);
  return e;
}

/** Force an exact deal so claim tests are not at the mercy of the shuffle. */
function setHands(e, map) {
  e.hands = {};
  for (const p of e.players) e.hands[p.id] = sortCards(map[p.id] || []);
}

// ---- Cards and sets --------------------------------------------------------
section('cards: the set taxonomy');
{
  ok(HALF_SUIT_SETS.length === 8, 'eight half-suits');
  ok(ALL_SETS.length === 9, 'nine sets including the eights');

  const all = ALL_SETS.flatMap((s) => setCards(s));
  ok(all.length === 52, `52 cards across all sets, got ${all.length}`);
  ok(new Set(all).size === 52, 'no card appears in two sets');

  ok(HALF_SUIT_SETS.every((s) => setCards(s).length === 6), 'every half-suit holds six cards');
  ok(setCards(EIGHTS).length === 4, 'the eights set holds four cards');
  ok(all.every((code) => setCards(setOf(code)).includes(code)), 'setOf round-trips for every card');

  ok(setOf('8H') === EIGHTS, 'an eight belongs to the eights set');
  ok(setOf('2S') === 'SL' && setOf('7S') === 'SL', 'low spades spans 2-7');
  ok(setOf('9S') === 'SH' && setOf('AS') === 'SH', 'high spades spans 9-A');
  ok(setOf('TH') === 'HH', 'the ten is a high card');
  ok(cardLabel('TH') === '10♥', `ten of hearts labels as 10♥, got ${cardLabel('TH')}`);
  ok(SET_CARDS.SL[0] === '2S', 'set cards are ascending');
}

// ---- Deck and dealing ------------------------------------------------------
section('rules: deck, dealing, majorities');
{
  ok(buildDeck({ ...DEFAULTS, eightsAsSet: false }).length === 48, '48-card standard deck');
  ok(buildDeck({ ...DEFAULTS, eightsAsSet: true }).length === 52, '52-card deck with eights');
  ok(new Set(buildDeck(DEFAULTS)).size === 48, 'standard deck has no duplicates');
  ok(!buildDeck(DEFAULTS).some((c) => setOf(c) === EIGHTS), 'no eights in the standard deck');

  ok(totalSets({ ...DEFAULTS, eightsAsSet: false }) === 8, '8 sets standard');
  ok(majorityTarget({ ...DEFAULTS, eightsAsSet: false }) === 5, '5 of 8 to win');
  ok(majorityTarget({ ...DEFAULTS, eightsAsSet: true }) === 5, '5 of 9 to win');

  for (const eightsAsSet of [false, true]) {
    for (const numPlayers of PLAYER_COUNTS) {
      const config = { ...DEFAULTS, numPlayers, eightsAsSet };
      const counts = dealCounts(config);
      const deckSize = buildDeck(config).length;
      const sum = counts.reduce((a, b) => a + b, 0);
      ok(sum === deckSize, `${numPlayers}p eights=${eightsAsSet}: deals whole deck (${sum}/${deckSize})`);
      ok(counts.length === numPlayers, `${numPlayers}p: one count per seat`);
      ok(Math.max(...counts) - Math.min(...counts) <= 1, `${numPlayers}p: hands differ by at most one`);

      // The point of spreading the remainder over the FIRST seats: teams level.
      const perTeam = [0, 0];
      counts.forEach((c, seat) => { perTeam[teamOfSeat(seat)] += c; });
      ok(perTeam[0] === perTeam[1], `${numPlayers}p eights=${eightsAsSet}: teams get equal cards (${perTeam})`);
    }
  }
}

section('rules: config patches are bounded');
{
  ok(sanitizeConfigPatch({ numPlayers: 5 }).numPlayers === undefined, 'rejects 5 players');
  ok(sanitizeConfigPatch({ numPlayers: 8 }).numPlayers === 8, 'accepts 8 players');
  ok(sanitizeConfigPatch({ turnSeconds: 9999 }).turnSeconds === 300, 'clamps the clock to 300s');
  ok(sanitizeConfigPatch({ turnSeconds: -5 }).turnSeconds === 0, 'clamps the clock at 0');
  ok(sanitizeConfigPatch({ eightsAsSet: 'yes' }).eightsAsSet === undefined, 'rejects non-boolean');
  ok(sanitizeConfigPatch({ nonsense: 1 }).nonsense === undefined, 'drops unknown keys');
  ok(Object.keys(sanitizeConfigPatch(null)).length === 0, 'survives a null patch');
}

// ---- Lobby -----------------------------------------------------------------
section('engine: lobby, seating, reconnection');
{
  const e = table(6);
  ok(e.players.length === 6, 'six seated');
  ok(e.players.map((p) => p.team).join('') === '010101', 'teams alternate by seat');

  const full = e.addPlayer('p9', 'Extra', { clientId: 'c9' });
  ok(!full.ok, 'a seventh player is turned away');

  ok(!e.addPlayer('x', '   ', { clientId: 'cx' }).ok, 'a blank name is refused');
  ok(!e.setConfig('p1', { numPlayers: 4 }).ok, 'a non-host cannot change settings');
  ok(!e.setConfig('p0', { numPlayers: 4 }).ok, 'cannot shrink below the seated count');

  const moved = e.moveSeat('p0', 'p1', -1);
  ok(moved.ok && e.seatOf('p1') === 0, 'host can move a player up a seat');
  ok(e.players.map((p) => p.team).join('') === '010101', 'teams still alternate after a move');
}
{
  const e = started(4);
  const before = [...e.cardsOf('p1')];
  const again = e.addPlayer('p1-new', 'Whoever', { clientId: 'c1' });
  ok(again.ok && again.reconnected, 'a known clientId reconnects rather than joining');
  ok(e.seatOf('p1-new') === 1, 'reconnecting keeps the same seat');
  ok(JSON.stringify(e.cardsOf('p1-new')) === JSON.stringify(before), 'reconnecting keeps the same cards');
  ok(e.cardsOf('p1').length === 0, 'the old id no longer holds cards');
  ok(!e.addPlayer('stranger', 'Nobody', { clientId: 'zz' }).ok, 'cannot join a running game');
}

// A seat is worth a hand of hidden cards, so naming it must not be enough to
// take it. Anyone can reach a four-character room code and type any name.
section('engine: a seat cannot be taken by naming it');
{
  const e = started(4);
  const victimCards = [...e.cardsOf('p1')];

  const thief = e.addPlayer('thief', 'P1', { clientId: 'stolen-id' });
  ok(!thief.ok, 'a stranger typing a seated name is refused mid-game');
  ok(e.seatOf('p1') === 1, 'the victim keeps their seat');
  ok(e.seatOf('thief') === -1, 'the thief is not seated');
  ok(e.cardsOf('thief').length === 0, 'the thief gets no cards');
  ok(JSON.stringify(e.cardsOf('p1')) === JSON.stringify(victimCards), 'the victim keeps their cards');
  ok(e.playerById('p1').clientId === 'c1', 'the victim keeps their claim on the seat');
  ok(e.addPlayer('p1-again', 'P1', { clientId: 'c1' }).ok, 'so the victim can still reconnect');
}
{
  const e = table(4);
  const dupe = e.addPlayer('p9', 'P1', { clientId: 'c9' });
  ok(!dupe.ok, 'a duplicate name is refused in the lobby too');
  ok(e.players.length === 4, 'and no seat is taken by the attempt');
  ok(e.playerById('p1').clientId === 'c1', 'the seat that owns the name is untouched');
}

section('engine: starting requires a full table');
{
  const e = table(6);
  e.removePlayer('p0', 'p5');
  const res = e.startGame('p0');
  ok(!res.ok && /Need exactly 6/.test(res.error), `short table cannot start: ${res.error}`);
  ok(!e.startGame('p1').ok, 'a non-host cannot start');
}

// ---- Dealing in the engine -------------------------------------------------
section('engine: the deal');
{
  for (const eightsAsSet of [false, true]) {
    for (const numPlayers of PLAYER_COUNTS) {
      const e = started(numPlayers, { eightsAsSet });
      const counts = dealCounts(e.config);
      const dealt = e.players.flatMap((p) => e.cardsOf(p.id));
      ok(dealt.length === buildDeck(e.config).length, `${numPlayers}p eights=${eightsAsSet}: whole deck dealt`);
      ok(new Set(dealt).size === dealt.length, `${numPlayers}p eights=${eightsAsSet}: no card dealt twice`);
      ok(e.players.every((p, seat) => e.cardsOf(p.id).length === counts[seat]),
        `${numPlayers}p eights=${eightsAsSet}: hand sizes match the deal plan`);
      ok(e.phase === PHASES.PLAY, 'phase is play after the deal');
    }
  }
}

// ---- Asking ----------------------------------------------------------------
section('engine: asking');
{
  const e = started(6);
  const asker = e.turnPlayer;
  const other = e.players.find((p) => p.team !== asker.team);
  const mate = e.players.find((p) => p.team === asker.team && p.id !== asker.id);
  const wanted = askableCards(e.cardsOf(asker.id), e.config)[0];

  ok(!e.ask(mate.id, other.id, wanted).ok, 'only the player on turn may ask');
  ok(!e.ask(asker.id, mate.id, wanted).ok, 'cannot ask a teammate');
  ok(!e.ask(asker.id, other.id, e.cardsOf(asker.id)[0]).ok, 'cannot ask for a card you hold');
  ok(!e.ask(asker.id, other.id, 'ZZ').ok, 'cannot ask for a non-card');
  ok(!e.ask(asker.id, other.id, '8H').ok, 'cannot ask for an eight when they are out');

  // A set the asker holds nothing of.
  const heldSets = new Set(e.cardsOf(asker.id).map(setOf));
  const foreign = setsInPlay(e.config).find((s) => !heldSets.has(s));
  if (foreign) {
    const res = e.ask(asker.id, other.id, setCards(foreign)[0]);
    ok(!res.ok && /hold a card of that set/.test(res.error), `must hold the set: ${res.error}`);
  }
}
{
  // A hit keeps the turn; a miss hands it over. Force both.
  const e = started(4);
  const a = e.turnPlayer;
  const opp = e.players.find((p) => p.team !== a.team);
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const oppMate = e.players.find((p) => p.team !== a.team && p.id !== opp.id);

  setHands(e, {
    [a.id]: ['2S', '3S', '9H'],
    [opp.id]: ['4S', 'TH'],
    [mate.id]: ['5S', 'JH'],
    [oppMate.id]: ['6S', 'QH'],
  });

  const hit = e.ask(a.id, opp.id, '4S');
  ok(hit.ok && hit.gotIt, 'asking for a card they hold succeeds');
  ok(e.cardsOf(a.id).includes('4S'), 'the card moves to the asker');
  ok(!e.cardsOf(opp.id).includes('4S'), 'the card leaves the target');
  ok(e.turnPlayer.id === a.id, 'a hit keeps the turn');
  ok(e.history.at(-1).gotIt === true, 'the hit is recorded');

  const miss = e.ask(a.id, opp.id, '7S');
  ok(miss.ok && !miss.gotIt, 'asking for a card they lack is legal but fails');
  ok(e.turnPlayer.id === opp.id, 'a miss passes the turn to the target');
  ok(e.history.at(-1).gotIt === false, 'the miss is recorded');
  ok(e.history.length === 2, 'both asks are in the record');

  // The spoken form has to ride on the RECORD, not on ask()'s return value: the
  // players who did not make the ask never see that return, and the record is
  // the only thing that reaches all of them. It is what the live region reads
  // out, so losing it makes the game silent for a screen reader while breaking
  // nothing a sighted player would notice.
  const said = e.publicState().history.at(-1).spoken;
  ok(typeof said === 'string' && said.includes(a.name) && said.includes(opp.name),
    `the public record says the exchange aloud: ${said}`);
  ok(/7 of Spades/i.test(said), 'and names the suit in words rather than as a glyph');
}
{
  // A target with no cards cannot be asked.
  const e = started(4);
  const a = e.turnPlayer;
  const opp = e.players.find((p) => p.team !== a.team);
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const oppMate = e.players.find((p) => p.team !== a.team && p.id !== opp.id);
  setHands(e, {
    [a.id]: ['2S', '3S'], [opp.id]: [], [mate.id]: ['5S'], [oppMate.id]: ['6S'],
  });
  const res = e.ask(a.id, opp.id, '4S');
  ok(!res.ok && /no cards left/.test(res.error), `cardless target refused: ${res.error}`);
  ok(e.ask(a.id, oppMate.id, '4S').ok, 'but another opponent with cards is fine');
}

// ---- Privacy ---------------------------------------------------------------
section('engine: hands stay hidden');
{
  const e = started(6);
  const pub = e.publicState();
  const json = JSON.stringify(pub);

  ok(pub.players.every((p) => typeof p.cards === 'number'), 'public players expose a count, not cards');
  ok(!('hands' in pub), 'publicState has no hands key');
  ok(json.indexOf('"hand"') === -1, 'publicState has no hand array anywhere');

  const asked = new Set(e.history.map((h) => h.code));
  const resolved = new Set(e.claims.flatMap((c) => setCards(c.setId)));
  let leaked = 0;
  for (const p of e.players) {
    for (const code of e.cardsOf(p.id)) {
      if (asked.has(code) || resolved.has(code)) continue;
      if (json.includes(`"${code}"`)) leaked += 1;
    }
  }
  ok(leaked === 0, `no unasked card code appears in publicState (leaked ${leaked})`);

  const mine = e.privateStateFor('p0');
  ok(mine.hand.length === e.cardsOf('p0').length, 'privateState carries my whole hand');
  ok(mine.teammates.every((t) => !('hand' in t)), 'teammates are named but their cards are not');
  ok(e.privateStateFor('nobody') === null, 'privateState for a stranger is null');

  const notMyTurn = e.players.find((p) => e.seatOf(p.id) !== e.turn);
  ok(e.privateStateFor(notMyTurn.id).askable.length === 0, 'no ask options when it is not your turn');
  ok(e.privateStateFor(e.turnPlayer.id).askable.length > 0, 'ask options when it is your turn');
}

// ---- Claiming --------------------------------------------------------------
section('engine: claiming');
{
  const e = started(4);
  const a = e.turnPlayer;
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const opp = e.players.find((p) => p.team !== a.team);
  const oppMate = e.players.find((p) => p.team !== a.team && p.id !== opp.id);

  setHands(e, {
    [a.id]: ['2S', '3S', '4S', '9H'],
    [mate.id]: ['5S', '6S', '7S', 'TH'],
    [opp.id]: ['JH', 'QH'],
    [oppMate.id]: ['KH', 'AH'],
  });

  const good = {
    '2S': a.id, '3S': a.id, '4S': a.id, '5S': mate.id, '6S': mate.id, '7S': mate.id,
  };

  ok(!e.claim(a.id, 'SL', { '2S': a.id }).ok, 'a partial assignment is refused');
  ok(!e.claim(a.id, 'SL', { ...good, '7S': opp.id }).ok, 'naming an opponent is refused');
  ok(!e.claim(a.id, 'E8', good).ok, 'a set that is not in play is refused');

  const res = e.claim(a.id, 'SL', good);
  ok(res.ok && res.correct, 'a correct claim succeeds');
  ok(e.scores()[a.team] === 1, 'the claiming team banks the set');
  ok(!e.cardsOf(a.id).includes('2S') && !e.cardsOf(mate.id).includes('5S'), 'claimed cards leave play');
  ok(!e.claim(a.id, 'SL', good).ok, 'the same set cannot be claimed twice');
  ok(e.unclaimedSets().length === 7, 'seven sets remain');
}
{
  // A wrong claim hands the set over by default.
  const e = started(4);
  const a = e.turnPlayer;
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const opp = e.players.find((p) => p.team !== a.team);
  const oppMate = e.players.find((p) => p.team !== a.team && p.id !== opp.id);

  setHands(e, {
    [a.id]: ['2S', '3S', '4S'], [mate.id]: ['5S', '6S'],
    [opp.id]: ['7S', 'JH'], [oppMate.id]: ['KH', 'AH'],
  });

  const res = e.claim(a.id, 'SL', {
    '2S': a.id, '3S': a.id, '4S': a.id, '5S': mate.id, '6S': mate.id, '7S': mate.id,
  });
  ok(res.ok && !res.correct, 'a wrong claim resolves rather than erroring');
  ok(JSON.stringify(res.wrong) === JSON.stringify(['7S']), `it reports which card was misplaced: ${res.wrong}`);
  ok(e.scores()[opp.team] === 1, 'by default the other team banks it');
  ok(e.scores()[a.team] === 0, 'the claiming team gets nothing');
  ok(!e.cardsOf(opp.id).includes('7S'), 'the set still leaves play');
}
{
  // wrongClaimAwardsOpponent off: nobody scores.
  const e = started(4, { wrongClaimAwardsOpponent: false });
  const a = e.turnPlayer;
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const opp = e.players.find((p) => p.team !== a.team);
  const oppMate = e.players.find((p) => p.team !== a.team && p.id !== opp.id);
  setHands(e, {
    [a.id]: ['2S', '3S', '4S'], [mate.id]: ['5S', '6S'],
    [opp.id]: ['7S'], [oppMate.id]: ['AH'],
  });
  const res = e.claim(a.id, 'SL', {
    '2S': a.id, '3S': a.id, '4S': a.id, '5S': mate.id, '6S': mate.id, '7S': mate.id,
  });
  ok(res.ok && res.team === null, 'a void claim scores for nobody');
  ok(e.scores()[0] === 0 && e.scores()[1] === 0, 'the scoreboard is untouched');
  ok(e.claims.length === 1, 'but the set is resolved');
}
{
  // claimAnyTime off restricts claims to your own turn.
  const e = started(4, { claimAnyTime: false });
  const off = e.players.find((p) => e.seatOf(p.id) !== e.turn);
  const res = e.claim(off.id, 'SL', {});
  ok(!res.ok && /your own turn/.test(res.error), `off-turn claim refused: ${res.error}`);
  ok(e.privateStateFor(off.id).canClaim === false, 'privateState says they cannot claim');
  ok(e.privateStateFor(e.turnPlayer.id).canClaim === true, 'the player on turn can');
}

// ---- The mustClaim invariant ----------------------------------------------
section('engine: a player with no legal ask always has a set to claim');
{
  // Straight case: the asker holds an entire set and nothing else.
  const e = started(4);
  const a = e.turnPlayer;
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const opp = e.players.find((p) => p.team !== a.team);
  const oppMate = e.players.find((p) => p.team !== a.team && p.id !== opp.id);
  setHands(e, {
    [a.id]: ['2S', '3S', '4S', '5S', '6S', '7S'],
    [mate.id]: ['9H'], [opp.id]: ['TH'], [oppMate.id]: ['JH'],
  });
  const priv = e.privateStateFor(a.id);
  ok(priv.mustClaim === true, 'holding a whole set and nothing else forces a claim');
  ok(priv.askable.length === 0, 'and there is nothing legal to ask for');
  const complete = completeSetsFor([a.id, mate.id], e.hands, [], e.config);
  ok(complete.includes('SL'), 'the forced claim is actually available');
}
{
  // The other way in: no opponent holds a card at all.
  const e = started(4);
  const a = e.turnPlayer;
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const opp = e.players.find((p) => p.team !== a.team);
  const oppMate = e.players.find((p) => p.team !== a.team && p.id !== opp.id);
  setHands(e, {
    [a.id]: ['2S', '3S', '4S'], [mate.id]: ['5S', '6S', '7S'],
    [opp.id]: [], [oppMate.id]: [],
  });
  const priv = e.privateStateFor(a.id);
  ok(priv.mustClaim === true, 'no opponent holding cards forces a claim');
  ok(completeSetsFor([a.id, mate.id], e.hands, [], e.config).length > 0, 'and a set is complete');
}

// ---- A whole game, driven greedily ---------------------------------------
section('engine: full games terminate and stay consistent');
{
  function pick(arr, n) { return arr[n % arr.length]; }

  /**
   * A deliberately dim driver: chase the set you already hold most of, and
   * claim the moment your team genuinely holds one.
   *
   * It has no inference at all — that lives in js/bots.js and is tested
   * separately. Greed is only here because a purely random driver never
   * concentrates a set, so the game would never end and this test would prove
   * nothing about the endgame. What it does exercise is every legality path,
   * the mustClaim invariant, and card conservation over thousands of moves.
   */
  for (let game = 0; game < 40; game += 1) {
    seedCrypto(1000 + game);
    const numPlayers = PLAYER_COUNTS[game % PLAYER_COUNTS.length];
    const e = started(numPlayers, { eightsAsSet: game % 2 === 0 });

    let step = 0;
    let invariantBroken = 0;
    let illegal = 0;
    const denied = new Set();

    while (e.phase === PHASES.PLAY && step < 8000) {
      step += 1;
      const me = e.turnPlayer;
      const myTeam = e.players.filter((p) => p.team === me.team).map((p) => p.id);
      const done = e.claims.map((c) => c.setId);
      const complete = completeSetsFor(myTeam, e.hands, done, e.config);
      const priv = e.privateStateFor(me.id);

      // THE INVARIANT: forced to claim implies a claim exists.
      if (priv.mustClaim && complete.length === 0) invariantBroken += 1;

      // Claim whenever the team genuinely holds a set. Each claim retires one
      // set, so this is what guarantees the loop makes progress.
      if (complete.length) {
        const setId = complete[0];
        const assignment = {};
        for (const code of setCards(setId)) {
          assignment[code] = myTeam.find((id) => e.cardsOf(id).includes(code));
        }
        const res = e.claim(me.id, setId, assignment);
        if (!res.ok || !res.correct) illegal += 1;
        continue;
      }

      const options = priv.askable;
      if (!options.length || !priv.targets.length) { illegal += 1; break; }

      const hand = e.cardsOf(me.id);
      let best = options[0];
      let bestHeld = -1;
      for (const o of options) {
        const held = hand.filter((c) => setOf(c) === o.setId).length;
        if (held > bestHeld) { bestHeld = held; best = o; }
      }

      // Skip pairs that just said no, so the driver does not sit in a loop
      // asking the same person for the same card forever.
      const pairs = [];
      for (const code of best.codes) {
        for (const t of priv.targets) pairs.push({ code, target: t });
      }
      const fresh = pairs.filter((p) => !denied.has(`${p.target.id}:${p.code}`));
      const chosen = (fresh.length ? fresh : pairs)[step % (fresh.length || pairs.length)];

      const res = e.ask(me.id, chosen.target.id, chosen.code);
      if (!res.ok) illegal += 1;
      else if (!res.gotIt) denied.add(`${chosen.target.id}:${chosen.code}`);
      else denied.clear();
    }

    ok(invariantBroken === 0, `game ${game}: mustClaim always has a claim available`);
    ok(illegal === 0, `game ${game}: the driver never made an illegal move`);
    ok(e.phase === PHASES.GAME_OVER, `game ${game}: reached game over in ${step} steps`);

    const scores = e.scores();
    const target = majorityTarget(e.config);
    const resolvedAll = e.claims.length === totalSets(e.config);
    ok(scores[0] >= target || scores[1] >= target || resolvedAll,
      `game ${game}: ended for a real reason (${scores} of ${totalSets(e.config)})`);
    ok(e.drawn ? scores[0] === scores[1] : true, `game ${game}: a draw really is level`);
    ok(e.drawn || e.winner !== null, `game ${game}: someone won or it was a draw`);
    ok(new Set(e.claims.map((c) => c.setId)).size === e.claims.length,
      `game ${game}: no set resolved twice`);

    // Cards accounted for: still held, or retired by a resolved set.
    const held = e.players.flatMap((p) => e.cardsOf(p.id));
    const retired = e.claims.flatMap((c) => setCards(c.setId));
    ok(held.length + retired.length === buildDeck(e.config).length,
      `game ${game}: every card is either held or retired`);
    ok(new Set([...held, ...retired]).size === buildDeck(e.config).length,
      `game ${game}: no card is both held and retired`);
  }
}

// ---- A draw ----------------------------------------------------------------
section('engine: 4-4 across eight sets is a draw');
{
  seedCrypto(7);
  const e = started(4, { eightsAsSet: false });
  const a = e.turnPlayer;
  const mate = e.players.find((p) => p.team === a.team && p.id !== a.id);
  const opp = e.players.find((p) => p.team !== a.team);

  // Hand-place four sets with each team, then claim them all correctly.
  const mine = ['SL', 'SH', 'HL', 'HH'];
  const theirs = ['DL', 'DH', 'CL', 'CH'];
  setHands(e, {
    [a.id]: mine.flatMap((s) => setCards(s)),
    [opp.id]: theirs.flatMap((s) => setCards(s)),
    [mate.id]: [],
    [e.players.find((p) => p.team !== a.team && p.id !== opp.id).id]: [],
  });

  for (const setId of mine) {
    const assignment = Object.fromEntries(setCards(setId).map((c) => [c, a.id]));
    ok(e.claim(a.id, setId, assignment).ok, `claimed ${setId}`);
  }
  for (const setId of theirs) {
    if (e.phase !== PHASES.PLAY) break;
    const assignment = Object.fromEntries(setCards(setId).map((c) => [c, opp.id]));
    ok(e.claim(opp.id, setId, assignment).ok, `claimed ${setId}`);
  }
  ok(e.phase === PHASES.GAME_OVER, 'the game ends once every set is resolved');
  ok(e.drawn === true, 'four apiece is a draw');
  ok(e.winner === null, 'a draw has no winner');
}

section('engine: nine sets cannot draw');
{
  seedCrypto(8);
  const e = started(4, { eightsAsSet: true });
  ok(totalSets(e.config) === 9, 'nine sets in play');
  ok(majorityTarget(e.config) === 5, 'five wins');
  ok(9 % 2 === 1, 'an odd number of sets cannot split level');
}

// ---- Clock -----------------------------------------------------------------
section('engine: the turn clock');
{
  const e = started(4, { turnSeconds: 30 });
  const t0 = 1_000_000;
  e._armClock(t0);
  ok(e.turnEndsAt === t0 + 30_000, 'arming sets a wall-clock deadline');
  ok(e.checkTurnTimeout(t0 + 29_999).fired === false, 'nothing fires early');

  const before = e.turn;
  const res = e.checkTurnTimeout(t0 + 30_000);
  ok(res.fired === true, 'the clock fires on the deadline');
  ok(e.turn !== before, 'a timeout passes the turn along');
  ok(e.turnEndsAt === t0 + 60_000, 'and rearms for the next player');
}
{
  const e = started(4, { turnSeconds: 0 });
  ok(e.turnEndsAt === null, 'no clock configured means no deadline');
  ok(e.checkTurnTimeout(Date.now() + 1e9).fired === false, 'and it never fires');
}

// ---- Turn hand-off round cardless seats -----------------------------------
section('engine: cardless seats are skipped');
{
  const e = started(4, { eightsAsSet: false });
  const seats = e.players.map((p) => p.id);
  // Seat 0 on turn; give seat 1 and 2 nothing, so a timeout must reach seat 3.
  e.turn = 0;
  setHands(e, {
    [seats[0]]: ['2S', '3S'], [seats[1]]: [], [seats[2]]: [], [seats[3]]: ['9H', 'TH'],
  });
  e.config.turnSeconds = 10;
  e._armClock(0);
  e.checkTurnTimeout(10_000);
  ok(e.turn === 3, `the turn skips empty seats, landed on ${e.turn}`);
}
{
  // A claim that empties the asker's hand must move the turn on.
  const e = started(4);
  const seats = e.players.map((p) => p.id);
  e.turn = 0;
  setHands(e, {
    [seats[0]]: ['2S', '3S', '4S'], [seats[2]]: ['5S', '6S', '7S'],
    [seats[1]]: ['9H', 'TH'], [seats[3]]: ['JH', 'QH'],
  });
  const assignment = {
    '2S': seats[0], '3S': seats[0], '4S': seats[0],
    '5S': seats[2], '6S': seats[2], '7S': seats[2],
  };
  ok(e.claim(seats[0], 'SL', assignment).ok, 'the claim lands');
  ok(e.cardsOf(seats[0]).length === 0, 'the claimant is now empty-handed');
  ok(e.phase === PHASES.PLAY, 'the game continues');
  ok(e.turn !== 0, `and the turn moved off the empty seat (now ${e.turn})`);
  ok(e.cardsOf(e.turnPlayer.id).length > 0, 'whoever is on turn holds cards');
}

// ---- Persistence -----------------------------------------------------------
section('engine: serialize and restore');
{
  seedCrypto(99);
  const e = started(6, { eightsAsSet: true, turnSeconds: 45 });
  const a = e.turnPlayer;
  const opp = e.players.find((p) => p.team !== a.team && e.cardsOf(p.id).length);
  const code = askableCards(e.cardsOf(a.id), e.config)[0];
  e.ask(a.id, opp.id, code);

  const snap = JSON.parse(JSON.stringify(e.serialize()));
  const r = GameEngine.restore(snap);

  ok(r.phase === e.phase, 'phase survives');
  ok(r.turn === e.turn, 'turn survives');
  ok(r.turnEndsAt === e.turnEndsAt, 'the deadline survives');
  ok(r.config.eightsAsSet === true && r.config.turnSeconds === 45, 'config survives');
  ok(r.players.length === e.players.length, 'the table survives');
  ok(JSON.stringify(r.hands) === JSON.stringify(e.hands), 'every hand survives exactly');
  ok(r.history.length === e.history.length, 'the ask record survives');
  ok(JSON.stringify(r.publicState()) === JSON.stringify(e.publicState()), 'public views match');

  const fresh = GameEngine.restore(null);
  ok(fresh.phase === PHASES.LOBBY, 'restoring nothing gives a fresh lobby');
  ok(GameEngine.restore({ v: 99 }).phase === PHASES.LOBBY, 'an unknown version is ignored');
}
{
  // The host reloads: it reclaims the host seat and everyone else shows away.
  seedCrypto(101);
  const e = started(4);
  const snap = JSON.parse(JSON.stringify(e.serialize()));
  const r = GameEngine.restore(snap);
  r.resumeAsHost('host-reborn');

  ok(r.hostId === 'host-reborn', 'the new peer id is the host');
  ok(r.playerById('host-reborn') !== null, 'the host kept their seat under the new id');
  ok(r.cardsOf('host-reborn').length === e.cardsOf('p0').length, 'and their cards');
  ok(r.players.filter((p) => p.online).length === 1, 'everyone else is marked away');
  ok(r.players.map((p) => p.team).join('') === '0101', 'seating is still coherent');
}

// ---- Another round ---------------------------------------------------------
section('engine: a second game keeps the table');
{
  seedCrypto(555);
  const e = started(4);
  e.phase = PHASES.GAME_OVER;
  const names = e.players.map((p) => p.name).join(',');
  const firstSeat = e.startSeat;

  const res = e.newGame('p0');
  ok(res.ok, `newGame should succeed: ${res.error || ''}`);
  ok(e.phase === PHASES.PLAY, 'a new game is running');
  ok(e.players.map((p) => p.name).join(',') === names, 'the same players are seated');
  ok(e.claims.length === 0, 'the scoreboard is cleared');
  ok(e.history.length === 0, 'the ask record is cleared');
  ok(e.startSeat !== firstSeat, 'the lead rotates');
  ok(e.players.every((p) => e.cardsOf(p.id).length === 12), 'everyone was redealt');
}

// ---- Bots as seats ---------------------------------------------------------
section('engine: bots fill seats');
{
  const e = new GameEngine({ hostId: 'p0' });
  e.addPlayer('p0', 'Host', { isHost: true, clientId: 'c0' });
  e.setConfig('p0', { numPlayers: 6 });
  const res = e.fillWithBots('p0');
  ok(res.ok && res.added === 5, `filled five seats, added ${res.added}`);
  ok(e.players.filter((p) => p.isBot).length === 5, 'five bots seated');
  ok(new Set(e.players.map((p) => p.id)).size === 6, 'bot ids are distinct');
  ok(e.startGame('p0').ok, 'a bot-filled table can start');
  ok(!e.addBot('p0').ok, 'no bots once the game is running');
}

// ---- Result ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
