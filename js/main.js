// ============================================================================
// main.js — The controller. Owns the app state, the transport and (when
// hosting) the engine; wires taps to intents and intents to renders.
//
// TWO ROLES, ONE INTENT PATH
//   A host runs a GameEngine in this tab. A client runs nothing and only
//   displays what it is sent. Both call actions.send(msg) with the same message,
//   and the only difference is where it goes: through applyGameIntent() locally,
//   or down a DataConnection to the host who does exactly that. So the host's
//   own taps are validated by the same code as a stranger's — there is no
//   "trusted local" path that could drift from the wire path.
//
// THE RULE THIS FILE EXISTS TO KEEP
//   engine.publicState() is safe for everyone. engine.privateStateFor(id) is one
//   player's cards. hostSync() below is the ONLY place state leaves the host,
//   and it sends the private slice per connection — never through broadcast().
//   If that loop is ever rewritten to broadcast one payload, every player sees
//   every hand and the game is over. It is a five-line function for that reason.
// ============================================================================

import { PHASES, GameEngine } from './state.js';
import { applyGameIntent } from './intents.js';
import { AskMemory, AWAY_PLAY_MS, BOT_THINK_MS, chooseBotMove } from './bots.js';
import { validClientId } from './guards.js';
import {
  describePeerError, isFatalPeerError, createHost, joinHost,
} from './net.js';
import {
  clearSession, clientId, copyText, generateRoomCode, loadCode, loadEngineSnapshot,
  loadName, loadSession, saveCode, saveEngineSnapshot, saveName, saveSession,
} from './util.js';
import { announce, render } from './ui.js';

// The host's own seat id. Clients are keyed by peer connection id, which is
// never this, so the two namespaces cannot collide.
const HOST_ID = 'host';

const root = document.getElementById('app');

const app = {
  screen: 'home',
  mode: null,        // 'host' | 'client'
  code: '',
  name: loadName(),
  myId: null,
  pub: null,
  priv: null,
  error: '',
  status: '',
  busy: null,        // 'host' | 'join' — disables the buttons that started it
  connected: false,
  clock: null,
  ui: {
    joinCode: loadCode(),
    setId: null,
    code: null,
    targetId: null,
    claimSetId: null,
    assignment: null,
    panel: 'history',
    copied: false,
  },
};

let engine = null;   // host only
let net = null;
let hostReady = false;

// Shared by every bot at the table: it holds only what was said out loud.
let botMemory = new AskMemory();
let botTimer = null;
let seenAsks = 0;
let seenClaims = 0;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function draw() {
  reconcileUi();
  render(root, app, actions);
}

/**
 * Drop any half-built move that the latest state has made illegal.
 *
 * The alternative — clearing the builder on every update — would mean somebody
 * else's ask wiping a card you had just picked. So selections persist by default
 * and are pruned only when they stop being offerable, which is also what stops a
 * stale selection being submitted and refused.
 */
function reconcileUi() {
  const { pub, priv, ui } = app;
  if (!pub || !priv) return;

  const askable = priv.askable || [];
  if (ui.setId && !askable.some((a) => a.setId === ui.setId)) {
    ui.setId = null;
    ui.code = null;
  }
  const chosen = askable.find((a) => a.setId === ui.setId);
  if (ui.code && (!chosen || !chosen.codes.includes(ui.code))) ui.code = null;
  if (ui.targetId && !(priv.targets || []).some((t) => t.id === ui.targetId)) ui.targetId = null;
  // One askable set is not a choice, so do not make it a tap.
  if (!ui.setId && askable.length === 1) ui.setId = askable[0].setId;

  if (ui.claimSetId && !(pub.unclaimedSets || []).includes(ui.claimSetId)) {
    ui.claimSetId = null;
    ui.assignment = null;
  }
}

function screenForPhase(phase) {
  if (phase === PHASES.PLAY) return 'play';
  if (phase === PHASES.GAME_OVER) return 'over';
  return 'lobby';
}

/** Fold a fresh view into the app, whether it came from our own engine or the
 *  wire, so both paths reach the same screen the same way. */
function applyView(pub, priv) {
  const prevTurn = app.pub ? app.pub.turnId : null;
  const prevPhase = app.pub ? app.pub.phase : null;

  app.pub = pub;
  app.priv = priv;
  app.screen = screenForPhase(pub.phase);
  syncClock();

  speak(pub, priv, prevTurn, prevPhase);
}

// What has already been read out, so an update only announces the new part.
let spoken = { ask: 0, log: 0 };

/**
 * Say what changed.
 *
 * Announcing only the turn is not enough in this game: on a hit the asker keeps
 * the turn, so the whole exchange — the one thing everybody at a real table
 * hears — would pass in silence. Every sentence here is read out of `pub`, which
 * is what keeps a screen reader level with the screen: with the record switched
 * off `pub.history` holds only the question just asked, so listening tells you
 * exactly what looking would and no more.
 *
 * The live region holds one message, so everything new is joined into one.
 */
function speak(pub, priv, prevTurn, prevPhase) {
  const log = pub.log || [];
  const asks = pub.history || [];
  const lastAsk = asks.at(-1)?.n || 0;

  // Two situations arrive with a backlog rather than an event: the first view of
  // the session (a mid-game join hands over the whole record at once) and a
  // rematch, which restarts both counters. Both catch up silently — replaying a
  // finished game into a live region would bury what is happening now.
  const said = [];
  if (prevPhase === null || lastAsk < spoken.ask || log.length < spoken.log) {
    spoken = { ask: lastAsk, log: log.length };
  } else {
    for (const h of asks) {
      if (h.n > spoken.ask) { said.push(h.spoken); spoken.ask = h.n; }
    }
    for (const line of log.slice(spoken.log)) said.push(line.text);
    spoken.log = log.length;
  }

  if (pub.phase === PHASES.PLAY && pub.turnId !== prevTurn) {
    const who = pub.players.find((p) => p.id === pub.turnId);
    said.push(priv && priv.isTurn ? 'Your turn.' : `${who ? who.name : 'Next player'} to play.`);
  }

  if (said.length) announce(said.join(' '));
}

function syncClock() {
  const ends = app.pub ? app.pub.turnEndsAt : null;
  app.clock = ends ? Math.max(0, Math.ceil((ends - Date.now()) / 1000)) : null;
}

// ---------------------------------------------------------------------------
// HOST
// ---------------------------------------------------------------------------

/** Render our own view and send every client the public state plus ONLY their
 *  own hand. The per-connection loop is the privacy boundary. */
function hostSync() {
  applyView(engine.publicState(), engine.privateStateFor(HOST_ID));
  saveEngineSnapshot(engine.serialize());

  for (const connId of net.connections.keys()) {
    net.sendTo(connId, {
      type: 'state',
      pub: app.pub,
      priv: engine.privateStateFor(connId),
    });
  }

  syncBotMemory();
  draw();
  scheduleBot();
}

/**
 * Tell the bots what the table just heard.
 *
 * Read off the ENGINE rather than publicState(), because config.showHistory can
 * blank the record and that setting is about what a person is shown, not about
 * what anyone remembers. A player at a real table still heard the question.
 */
function syncBotMemory() {
  for (const c of engine.claims.slice(seenClaims)) botMemory.observeClaim(c);
  seenClaims = engine.claims.length;
  for (const h of engine.history) if (h.n > seenAsks) botMemory.observeAsk(h);
  seenAsks = engine.askCount;
}

function resetBotMemory() {
  botMemory.reset();
  seenAsks = 0;
  seenClaims = 0;
}

/** Deliver a refusal to one player. The host has no connection to itself, so its
 *  own errors have to be set directly or they vanish. */
function rejectTo(playerId, message) {
  if (playerId === HOST_ID) { app.error = message || ''; return; }
  if (net) net.sendTo(playerId, { type: 'error', message });
}

/**
 * Apply one player's intent. Everything here may have come off the wire from a
 * peer we do not control: the engine decides legality, but a malformed message
 * can still throw, and an exception escaping into PeerJS's data callback would
 * take down the host tab and the whole game with it.
 */
function handleIntent(playerId, msg) {
  try {
    dispatchIntent(playerId, msg);
  } catch (err) {
    console.warn('Dropped an unprocessable message from', playerId, err);
  }
}

function dispatchIntent(playerId, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  // Identity and connection lifecycle belong to the transport, not to the game,
  // so they are handled here rather than in intents.js.
  if (msg.type === 'join') {
    // A malformed clientId is dropped rather than rejected: it costs the sender
    // its claim on a seat, which is the sender's problem.
    const r = engine.addPlayer(playerId, msg.name, {
      isHost: false,
      clientId: validClientId(msg.clientId),
    });
    if (!r.ok) { net.sendTo(playerId, { type: 'rejected', message: r.error }); return; }
    // A reconnect moved a seat onto a new connection id. Drop the orphaned one
    // so its eventual close cannot fire a disconnect against the live seat.
    if (r.reconnected && r.prevId && r.prevId !== playerId) net.dropConnection(r.prevId);
    net.sendTo(playerId, { type: 'welcome', playerId });
    hostSync();
    return;
  }

  const before = engine.phase;
  const res = applyGameIntent(engine, playerId, msg);
  if (!res.ok) { rejectTo(playerId, res.error); draw(); return; }

  // A fresh deal makes every remembered fact worthless, and keeping them would
  // be worse than forgetting: they would be certainties about the last hand.
  if (before !== PHASES.PLAY && engine.phase === PHASES.PLAY) resetBotMemory();

  hostSync();
}

// ---- Bots -----------------------------------------------------------------
//
// One bot moves per timer, then hostSync() schedules the next. A loop would be
// instant and unreadable; this way a table of bots plays at a watchable pace and
// a human's turn interrupts it naturally, because the timer only ever fires for
// whoever is actually on turn.
// A seat nobody is sitting in counts as a bot seat for this purpose. Otherwise
// one closed tab stops the game for everybody: the engine only ever advances the
// turn on a move or on the clock, and the clock is off unless the table turned it
// on. The host holds every hand, so it can play the empty chair itself.
const unattended = (p) => !!p && (p.isBot || !p.online);

function scheduleBot() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (!engine || engine.phase !== PHASES.PLAY) return;

  const turn = engine.turnPlayer;
  if (!unattended(turn)) return;

  botTimer = setTimeout(() => {
    botTimer = null;
    if (!engine || engine.phase !== PHASES.PLAY) return;
    const me = engine.turnPlayer;
    if (!unattended(me)) return;

    const move = chooseBotMove(botMemory, engine.publicState(), engine.privateStateFor(me.id));
    // Only happens with no set left to claim, which is already game over and is
    // caught above. Bailing here would stop the chain for good — nothing else
    // reschedules it, and the turn clock is off unless the table turned it on.
    if (!move) return;
    applyGameIntent(engine, me.id, move);
    hostSync();
  }, turn.isBot ? BOT_THINK_MS : AWAY_PLAY_MS);
}

function hostHandlers() {
  const warn = (text) => { app.status = text; draw(); };
  const clearWarning = () => {
    if (!app.status) return;
    app.status = '';
    draw();
  };

  return {
    onOpen: () => { hostReady = true; app.connected = true; app.status = ''; draw(); },
    onData: (connId, msg) => handleIntent(connId, msg),
    onDisconnect: (connId) => {
      if (!engine.playerById(connId)) return;
      engine.setOnline(connId, false);
      hostSync();
    },

    onBrokerDown: () => warn('Lost the connection server — reconnecting. Players already in the game are unaffected.'),
    onBrokerUp: clearWarning,
    onBrokerLost: () => warn(`Can't reach the connection server, so nobody new can join with code ${app.code}. The game itself carries on.`),

    // A broker failure does NOT break the DataConnections we already have: those
    // run device to device. Tearing the game down over one would throw away a
    // game that is still perfectly playable.
    onError: (err) => {
      if (isFatalPeerError(err) || !hostReady) {
        app.busy = null;
        app.screen = 'home';
        app.error = describePeerError(err);
        app.connected = false;
        draw();
        return;
      }
      warn(describePeerError(err));
    },
  };
}

function startHosting(code, resumed = false) {
  app.mode = 'host';
  app.code = code;
  app.myId = HOST_ID;
  app.busy = null;
  app.connected = false;
  hostReady = false;

  net = createHost(code, hostHandlers());
  saveSession({ mode: 'host', code, name: app.name });
  saveCode(code);

  if (!resumed) {
    engine = new GameEngine({ hostId: HOST_ID });
    engine.addPlayer(HOST_ID, app.name, { isHost: true, clientId: clientId() });
    resetBotMemory();
  }

  hostSync();
}

function host() {
  const name = (app.name || '').trim();
  if (!name) { app.error = 'Enter a name first.'; draw(); return; }
  app.busy = 'host';
  app.error = '';
  draw();
  startHosting(generateRoomCode());
}

// ---------------------------------------------------------------------------
// CLIENT
// ---------------------------------------------------------------------------
function join(rawCode) {
  const name = (app.name || '').trim();
  if (!name) { app.error = 'Enter a name first.'; draw(); return; }

  const code = (rawCode || '').toUpperCase();
  app.mode = 'client';
  app.code = code;
  app.busy = 'join';
  app.error = '';
  app.status = 'Connecting…';
  draw();

  // The broker can report a host that exists and then never bring the data
  // channel up — see the NAT notes in net.js. Nothing fires on that path, so a
  // timeout of our own is the only way the player is ever told.
  const timeout = setTimeout(() => {
    if (app.connected) return;
    app.busy = null;
    app.status = '';
    app.error = 'Could not reach that game. Check the code, or ask the host to re-host.';
    teardownNet();
    draw();
  }, 15000);

  net = joinHost(code, {
    onOpen: () => {
      app.connected = true;
      app.status = 'Joining…';
      net.send({ type: 'join', name, clientId: clientId() });
      draw();
    },
    // Every frame here came off the wire and is rendered more or less directly,
    // and an exception escaping into PeerJS's data callback takes down the tab —
    // which for a client is the whole game. Same reason the host wraps its own
    // dispatch in handleIntent.
    onData: (msg) => {
      try {
        fromHost(msg, timeout, code, name);
      } catch (err) {
        console.warn('Dropped an unusable message from the host', err);
      }
    },
    onClose: () => {
      app.connected = false;
      app.status = 'Lost the host — getting back in.';
      draw();
    },
    onGaveUp: () => {
      app.status = '';
      app.error = 'Could not get back to the game. Reload to try again — your seat is still yours.';
      draw();
    },
    onBrokerLost: () => {
      if (net && net.isOpen()) return;
      app.status = '';
      app.error = "Can't reach the connection server, so there is no way back in. Reload to try again.";
      draw();
    },
    onError: (err) => {
      // Almost every error here is a signalling problem, and signalling is only
      // needed to OPEN a connection — the one we have runs device to device and
      // is unaffected. Reporting it would put a red banner over a game that is
      // still playing perfectly. The host draws the same distinction.
      if (net && net.isOpen() && !isFatalPeerError(err)) return;
      clearTimeout(timeout);
      app.busy = null;
      app.status = '';
      app.error = describePeerError(err);
      if (!app.pub) app.screen = 'home';
      draw();
    },
  });
}

function fromHost(msg, timeout, code, name) {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'welcome':
      clearTimeout(timeout);
      app.myId = msg.playerId;
      app.busy = null;
      app.status = '';
      saveSession({ mode: 'client', code, name });
      saveCode(code);
      draw();
      break;

    case 'state': {
      // `pub` is rendered straight away and ui.js reads pub.players.length, so a
      // truthy-but-wrong object is the difference between a dropped frame and a
      // dead tab. Checking the one field the renderer cannot do without.
      if (!msg.pub || !Array.isArray(msg.pub.players)) return;

      if (!msg.priv) {
        // The host sends priv: null for a connection holding no seat. Once we have
        // been welcomed that means the seat is gone — the host removed us — and
        // dropping the frame would leave a stale lobby on screen with nothing to
        // explain why it stopped moving. Before the welcome it means only that
        // somebody else's move triggered a sync while our `join` was in flight.
        if (!app.myId) return;
        leave();
        app.error = 'The host removed you from the table.';
        draw();
        return;
      }

      clearTimeout(timeout);
      app.busy = null;
      app.status = '';
      applyView(msg.pub, msg.priv);
      draw();
      break;
    }

    case 'rejected':
      clearTimeout(timeout);
      app.busy = null;
      app.status = '';
      app.error = msg.message || 'The host refused the connection.';
      app.screen = 'home';
      teardownNet();
      draw();
      break;

    case 'error':
      app.error = typeof msg.message === 'string' ? msg.message : '';
      draw();
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Leaving and resuming
// ---------------------------------------------------------------------------
function teardownNet() {
  if (net) { net.destroy(); net = null; }
  app.connected = false;
}

function leave() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  teardownNet();
  clearSession();
  engine = null;
  resetBotMemory();

  app.mode = null;
  app.screen = 'home';
  app.code = '';
  app.myId = null;
  app.pub = null;
  app.priv = null;
  app.error = '';
  app.status = '';
  app.busy = null;
  app.clock = null;
  app.ui.claimSetId = null;
  app.ui.assignment = null;
  app.ui.setId = null;
  app.ui.code = null;
  app.ui.targetId = null;
  draw();
}

/** A reload should not lose the game. A host rehydrates its engine from the
 *  snapshot and re-opens the same room code; a client just dials in again and
 *  reclaims its seat with the clientId it already had. */
function resumeIfPossible() {
  const session = loadSession();
  if (!session || !session.code) return false;

  if (session.name) app.name = session.name;

  if (session.mode === 'host') {
    const snap = loadEngineSnapshot();
    if (!snap) return false;
    const restored = GameEngine.restore(snap);
    if (!restored) return false;
    engine = restored;
    engine.resumeAsHost(HOST_ID);
    resetBotMemory();
    syncBotMemory();
    app.status = 'Picking up where you left off.';
    startHosting(session.code, true);
    return true;
  }

  if (session.mode === 'client') {
    app.status = 'Rejoining…';
    join(session.code);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// The tick. One interval drives the turn clock display for everyone and the
// timeout itself for the host, because the engine deliberately owns no timers.
// ---------------------------------------------------------------------------
setInterval(() => {
  if (!app.pub || app.pub.phase !== PHASES.PLAY) return;

  if (engine) {
    const fired = engine.checkTurnTimeout(Date.now());
    if (fired.fired) { hostSync(); return; }
  }

  const before = app.clock;
  syncClock();
  if (app.clock !== before) draw();
}, 500);

// ---------------------------------------------------------------------------
// Actions — the whole surface ui.js is given.
// ---------------------------------------------------------------------------
const actions = {
  /** One intent, one path: the host runs it, a client posts it to the host. */
  send(msg) {
    app.error = '';
    if (app.mode === 'host') handleIntent(HOST_ID, msg);
    else if (net) { net.send(msg); draw(); }
  },

  setUi(patch) {
    Object.assign(app.ui, patch);
    draw();
  },

  setName(value) {
    app.name = value.slice(0, 16);
    saveName(app.name);
    // Has to draw: Host and Join are disabled until there is a name, so skipping
    // the render leaves them dead however much you type. render() puts the caret
    // back, which is what makes redrawing on every keystroke acceptable.
    draw();
  },

  host,
  join,
  leave,

  clearError() { app.error = ''; draw(); },

  openClaim(setId) {
    app.ui.claimSetId = setId;
    // Cards I hold are known, so they are filled in and locked by the UI. Only
    // the rest is a judgement.
    app.ui.assignment = {};
    for (const c of app.priv.hand) {
      if (c.setId === setId) app.ui.assignment[c.code] = app.priv.id;
    }
    draw();
  },

  closeClaim() {
    app.ui.claimSetId = null;
    app.ui.assignment = null;
    draw();
  },

  assign(code, playerId) {
    if (!app.ui.assignment) app.ui.assignment = {};
    app.ui.assignment[code] = playerId;
    draw();
  },

  async copyCode() {
    const ok = await copyText(app.code);
    app.ui.copied = ok;
    draw();
    if (ok) setTimeout(() => { app.ui.copied = false; draw(); }, 1500);
  },
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (!window.Peer) {
  app.error = 'Could not load the networking library. Check your connection and reload.';
}

if (!resumeIfPossible()) draw();

// The service worker is a progressive enhancement: a failure to register means
// no offline shell, which is not a reason to refuse to play.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
