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
//
// A THIRD MODE THAT IS NOT A THIRD PATH
//   mode 'server' is the client role again, pointed at a WebSocket instead of at
//   a peer. No browser holds the engine there, so even the player who opened the
//   table sends every lobby control over the wire — which is why "am I the host"
//   became a question about pub.hostId (asked in ui.js) rather than about which
//   button was tapped. Everything server-shaped is gated on js/config.js naming a
//   server AND a live health probe, so with the host blanked this file behaves
//   exactly as it did before server mode existed.
// ============================================================================

import { PHASES, GameEngine } from './state.js';
import { applyGameIntent } from './intents.js';
import { createBotDriver } from './botdriver.js';
import { validClientId } from './guards.js';
import {
  describePeerError, describeServerRejection, fetchServerRooms, isFatalPeerError,
  createHost, joinHost, probeServer, serverTransport,
} from './net.js';
import {
  SERVER_HEALTH, SERVER_ROOMS, SERVER_URL, serverConfigured,
} from './config.js';
import {
  CODE_LENGTH, clearSession, clientId, copyText, generateRoomCode, loadCode,
  loadEngineSnapshot, loadName, loadSession, normalizeCode, saveCode,
  saveEngineSnapshot, saveName, saveSession,
} from './util.js';
import { announce, render } from './ui.js';

// The host's own seat id. Clients are keyed by peer connection id, which is
// never this, so the two namespaces cannot collide.
const HOST_ID = 'host';

const root = document.getElementById('app');

const app = {
  screen: 'home',
  mode: null,        // 'host' | 'client' | 'server'
  code: '',
  name: loadName(),
  myId: null,
  pub: null,
  priv: null,
  error: '',
  status: '',
  busy: null,        // 'host' | 'hostOnline' | 'join' — disables the button
  connected: false,
  clock: null,

  // Is there an authoritative server, and is it awake? 'off' means js/config.js
  // names none, and then no server control is ever drawn and none of the code
  // below runs. The other states are the health probe's: 'unknown' before it has
  // been asked, 'checking' while it is in flight, then 'up' or 'down'.
  server: { state: serverConfigured() ? 'unknown' : 'off', version: '' },

  // Open lobbies on the server, or null for "no list" — which covers a server
  // that is down and one with ROOMS_LIST=0 alike, because the UI treats them the
  // same: it shows nothing, and typing a code still works.
  serverRooms: null,

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

// Bot pacing and the shared table memory. The same module the server runs, so a
// bot plays identically whichever machine is holding the engine.
const bots = createBotDriver();

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

  // Keep the table's memory level with the move that just happened rather than
  // waiting for the next tick to catch up. The driver would do it anyway; doing
  // it here means a bot always decides on the very latest question.
  bots.observe(engine);
  draw();
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
  // The driver detects this for itself; saying so explicitly also throws away a
  // pause left over from the game that just ended.
  if (before !== PHASES.PLAY && engine.phase === PHASES.PLAY) bots.reset();

  hostSync();
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
  // Nobody is looking at the home screen any more, and a poll that outlived it
  // would keep asking the Pi for lobbies all through the game.
  stopRoomsPoll();
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
    bots.reset();
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
// CLIENT (peer-to-peer)
//
// Named joinPeer rather than join because there are two joins now and only one of
// them dials a browser. actions.join below is the one a button calls: it decides
// which of the two this code is for.
// ---------------------------------------------------------------------------
function joinPeer(rawCode) {
  const name = (app.name || '').trim();
  if (!name) { app.error = 'Enter a name first.'; draw(); return; }

  stopRoomsPoll();
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
// SERVER MODE — the same game, carried by a WebSocket to an authoritative server.
//
// Structurally this is the JOINING path for everybody, the table's owner included:
// no browser holds a GameEngine here, so `engine` stays null and every tap — the
// owner's lobby controls as much as anyone's ask — travels over the wire through
// the untouched actions.send(). The owner is not a special client; they are just
// the player whose id the server put in pub.hostId.
//
// Identity is this device's clientId, never the name typed on the home screen.
// That is what stops a seat being taken on a public endpoint by anyone who can
// read a name off the lobby, and it is why a reconnect can reclaim a HAND
// mid-game without the server trusting a word the returning socket says about who
// it is. See server/session.js.
// ---------------------------------------------------------------------------

// What this attempt was trying to do, kept so a retry can repeat it and so a
// refusal knows which code the player actually typed.
let serverIntent = null;

// The server transport does no reconnecting of its own — unlike joinHost(), which
// redials the broker — because only this file knows whether a closed socket
// interrupted a game or a doomed join. So the retry loop lives here.
let serverRetry = null;
let serverTries = 0;
const SERVER_RETRIES = 6;      // 1+2+4+8+8+8s ≈ 31s before we call it a night

function startServerGame({ create = false, code = '', name = '', reconnect = false } = {}) {
  const clean = (name || '').trim();
  if (!clean) { app.error = 'Enter a name first.'; draw(); return; }

  // A create has no code yet: the server mints one and sends it back in `welcome`.
  const roomCode = create ? '' : normalizeCode(code);
  if (!create && roomCode.length !== CODE_LENGTH) {
    app.error = 'That room code is not valid.';
    draw();
    return;
  }

  stopRoomsPoll();
  if (!reconnect) clearServerRetry();

  app.mode = 'server';
  app.name = clean;
  saveName(clean);
  // Nothing in this tab for an intent to be applied to, and it matters more than
  // it looks: the tick below calls hostSync() whenever `engine` is set, and
  // hostSync() reaches for net.connections — which a WebSocket does not have.
  engine = null;
  bots.reset();

  if (roomCode) { app.code = roomCode; saveCode(roomCode); }
  else if (!reconnect) app.code = '';
  app.error = '';
  app.connected = false;
  if (!reconnect) {
    app.busy = create ? 'hostOnline' : 'join';
    app.status = 'Connecting…';
  }
  serverIntent = { code: roomCode, name: clean, create: !!create };
  draw();

  // The same deadline the peer join uses, for the same reason: a socket that hangs
  // instead of failing leaves the player watching 'Connecting…' forever. A
  // reconnect needs none — it has the retry loop, and the board stays up.
  let timeout = null;
  if (!reconnect) {
    timeout = setTimeout(() => {
      timeout = null;
      if (app.pub) return;
      app.server.state = 'down';
      giveUpOnServer("The game server didn't answer. It may be switched off — you can still host a game over Wi-Fi.");
    }, 15000);
  }

  net = serverTransport(SERVER_URL, {
    onOpen: () => {
      app.server.state = 'up';
      app.connected = true;
      app.status = create ? 'Opening a table…' : 'Joining…';
      // createRoom happens once, ever. Every attempt after that is a join, or a
      // blip on the owner's phone would open a second empty room and orphan the
      // game everyone else is sitting in — see the welcome handler.
      if (create) net.send({ type: 'createRoom', name: clean, clientId: clientId() });
      else net.send({ type: 'join', code: app.code, name: clean, clientId: clientId() });
      draw();
    },

    // Everything here came off a public endpoint and is rendered more or less
    // directly. Same guard, and same reason, as the peer client's onData.
    onData: (msg) => {
      try {
        fromServer(msg, () => { if (timeout) { clearTimeout(timeout); timeout = null; } });
      } catch (err) {
        console.warn('Dropped an unusable message from the server', err);
      }
    },

    // app.pub marks "we were in a real game" — the case worth retrying rather than
    // abandoning. everOpened separates a server that refused us (an origin check,
    // a full server) from one that is not there at all.
    onClose: ({ everOpened }) => {
      app.connected = false;
      if (app.pub) { scheduleServerRetry(); return; }
      if (timeout) { clearTimeout(timeout); timeout = null; }
      if (!everOpened) app.server.state = 'down';
      giveUpOnServer(everOpened
        ? 'The server closed the connection before the game started.'
        : "Couldn't reach the game server. It may be switched off — you can still host a game over Wi-Fi.");
    },

    onError: () => { /* a close always follows, and that is where we decide */ },
  });
}

/** Abandon a server attempt and say why. Kills the retry loop too, so a failure
 *  the player is reading about is not being quietly retried underneath it. */
function giveUpOnServer(message) {
  clearServerRetry();
  teardownNet();
  serverIntent = null;
  app.mode = null;
  app.busy = null;
  app.status = '';
  app.screen = 'home';
  app.error = message;
  draw();
}

function fromServer(msg, clearJoinTimer) {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'welcome':
      clearJoinTimer();
      app.myId = msg.playerId;
      if (msg.code) { app.code = msg.code; saveCode(app.code); }
      // The room exists from here on, so a retry must join it rather than create
      // another. This is the line that makes the owner's reconnect safe.
      if (serverIntent) serverIntent = { ...serverIntent, code: app.code, create: false };
      saveSession({ mode: 'server', code: app.code, name: app.name });
      app.busy = null;
      app.status = '';
      draw();
      break;

    case 'state': {
      // Same shape check as the peer path: pub is rendered straight away and
      // ui.js reads pub.players, so a truthy-but-wrong object is the difference
      // between a dropped frame and a dead tab.
      if (!msg.pub || !Array.isArray(msg.pub.players)) return;

      if (!msg.priv) {
        // priv: null after a welcome means the seat is gone — the same removal
        // signal the peer host sends, deliberately, so this branch reads the same
        // on both transports. Before the welcome it only means somebody else's
        // move triggered a broadcast while our join was still in flight.
        if (!app.myId) return;
        leave();
        app.error = 'The host removed you from the table.';
        draw();
        return;
      }

      clearJoinTimer();
      clearServerRetry();
      app.busy = null;
      app.status = '';
      app.connected = true;
      applyView(msg.pub, msg.priv);
      draw();
      break;
    }

    case 'rejected':
      clearJoinTimer();
      serverRejected(msg);
      break;

    case 'error':
      app.error = typeof msg.message === 'string' ? msg.message : '';
      draw();
      break;

    default:
      break;
  }
}

/** A refusal is fatal to THIS attempt — the server closes the socket behind it. */
function serverRejected(msg) {
  const reason = msg && msg.reason;
  const wanted = serverIntent;
  clearServerRetry();
  teardownNet();
  serverIntent = null;
  app.mode = null;

  // The server has never heard of this code — but a phone on this Wi-Fi might be
  // hosting it. Falling through to the peer join is what lets ONE Join button
  // cover both kinds of game, so a player never has to know which one they were
  // invited to. Only for a code the player typed, and only before we had a game:
  // a mid-game 'no-room' means the room was swept, not misaddressed.
  if (reason === 'no-room' && wanted && wanted.code && !app.pub) {
    joinPeer(wanted.code);
    return;
  }

  clearSession();
  app.pub = null;
  app.priv = null;
  app.myId = null;
  app.busy = null;
  app.status = '';
  app.screen = 'home';
  app.error = describeServerRejection(reason, msg && msg.message);
  refreshServerRooms();
  draw();
}

/**
 * A dropped socket mid-game is worth retrying before telling anyone their game is
 * over: the address never moves, the seat is still theirs, and the server hands it
 * back on the strength of this device's clientId rather than its name.
 */
function scheduleServerRetry() {
  if (serverRetry) return;
  if (serverTries >= SERVER_RETRIES) {
    clearServerRetry();
    app.status = '';
    app.error = 'Lost the server and could not get back. Reload to try again — your seat is still yours.';
    draw();
    return;
  }
  const delay = Math.min(1000 * 2 ** serverTries, 8000);
  serverTries += 1;
  app.connected = false;
  app.status = 'Lost the server — getting back in.';
  draw();

  serverRetry = setTimeout(() => {
    serverRetry = null;
    teardownNet();
    // Note the absent `create`: a returning owner rejoins the room they already
    // made. serverIntent was rewritten at the welcome for exactly this.
    startServerGame({ code: app.code, name: app.name, reconnect: true });
  }, delay);
}

function clearServerRetry() {
  if (serverRetry) { clearTimeout(serverRetry); serverRetry = null; }
  serverTries = 0;
}

// ---------------------------------------------------------------------------
// Is the server there? Asked once at boot and again whenever the answer could
// have changed. Every server-shaped control in the UI is gated on the result, so a
// Pi that is off, missing or unreachable is simply never offered — which is what
// keeps this an honest peer-to-peer game by default.
// ---------------------------------------------------------------------------

// The in-flight probe, so two callers await one request rather than racing two.
let serverProbe = null;

function checkServer() {
  if (!serverConfigured()) { app.server.state = 'off'; return Promise.resolve(); }
  if (serverProbe) return serverProbe;

  app.server.state = 'checking';
  draw();
  serverProbe = (async () => {
    const info = await probeServer(SERVER_HEALTH);
    app.server.state = info ? 'up' : 'down';
    app.server.version = (info && info.version) || '';
    serverProbe = null;
    draw();
  })();
  return serverProbe;
}

// Open lobbies on the server, polled while the home screen is up.
//
// Codes were never secrets, but this list hands them out — see ROOMS_LIST in
// server/compose.yaml, which can switch it off. It is offered because the public
// PeerJS broker has enumeration disabled, so on the server this is the only way to
// find a game without being told the code.
const ROOMS_POLL_MS = 6000;
let roomsTimer = null;

function refreshServerRooms() {
  stopRoomsPoll();
  if (!serverConfigured()) return;

  const tick = async () => {
    roomsTimer = null;
    const rooms = await fetchServerRooms(SERVER_ROOMS);
    if (app.screen !== 'home') return;      // they left while it was in flight
    app.serverRooms = rooms;
    if (rooms) app.server.state = 'up';
    draw();
    // Stop on null rather than retrying: that is a server which is down or has
    // the list switched off, and neither is worth a request every few seconds.
    // The health probe already tells the player which of the two it is.
    if (rooms) roomsTimer = setTimeout(tick, ROOMS_POLL_MS);
  };
  tick();
}

function stopRoomsPoll() {
  if (roomsTimer) { clearTimeout(roomsTimer); roomsTimer = null; }
}

// ---------------------------------------------------------------------------
// Leaving and resuming
// ---------------------------------------------------------------------------
function teardownNet() {
  if (net) { net.destroy(); net = null; }
  app.connected = false;
}

function leave() {
  teardownNet();
  clearSession();
  clearServerRetry();
  serverIntent = null;
  engine = null;
  bots.reset();

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

  // Back on the home screen, where both of these are worth knowing again and both
  // may have changed while the game was on. Cheap, and neither can fail loudly.
  checkServer();
  refreshServerRooms();
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
    // Rebuild the table's memory from the record the snapshot carried, so the
    // bots come back knowing what they knew rather than starting the second half
    // of a game with amnesia.
    bots.reset();
    bots.observe(engine);
    app.status = 'Picking up where you left off.';
    startHosting(session.code, true);
    return true;
  }

  if (session.mode === 'client') {
    app.status = 'Rejoining…';
    joinPeer(session.code);
    return true;
  }

  // A server game needs nothing rehydrated here — the engine never left the Pi.
  // Rejoining is the whole of it, and this device's clientId is what gets the seat
  // and the hand back. No fall-through to the peer path: the session records which
  // transport the game was on, and a server code means nothing to a phone on this
  // Wi-Fi.
  if (session.mode === 'server' && session.name && serverConfigured()) {
    startServerGame({ code: session.code, name: session.name });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// The tick. One interval drives the turn clock display for everyone, and for a
// host it also drives the timeout itself and the bots — because the engine
// deliberately owns no timers and the driver deliberately owns none either.
//
// A heartbeat rather than a chain of one-shot timers: a bot's move used to
// schedule the next one, so a single missed link stopped the table for good. A
// tick that re-reads the engine every half second cannot lose its place.
// ---------------------------------------------------------------------------
setInterval(() => {
  if (!app.pub || app.pub.phase !== PHASES.PLAY) return;

  if (engine) {
    const now = Date.now();
    // Clock first: a player who has just run out of time has to lose the turn
    // before a bot is offered it, or a bot would move on a turn that was already
    // over — on the very tick that was about to end it.
    if (engine.checkTurnTimeout(now).fired) { hostSync(); return; }
    if (bots.tick(engine, now)) { hostSync(); return; }
  }

  const before = app.clock;
  syncClock();
  if (app.clock !== before) draw();
}, 500);

// ---------------------------------------------------------------------------
// Actions — the whole surface ui.js is given.
// ---------------------------------------------------------------------------
const actions = {
  /**
   * One intent, one path: the host runs it, everyone else posts it.
   *
   * "Everyone else" is both other modes, and that is the point — a peer client
   * writes to a DataConnection and a server client writes to a WebSocket, but
   * net.send is the same call and neither one knows the difference. On the server
   * transport this branch carries the OWNER's lobby controls too, because their
   * browser is holding no engine to apply them to.
   */
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
  leave,

  /** Host on the server instead of in this tab. Only ever offered once the health
   *  probe has come back — see app.server here and the gating in ui.js. */
  hostOnline() {
    const name = (app.name || '').trim();
    if (!name) { app.error = 'Enter a name first.'; draw(); return; }
    app.busy = 'hostOnline';
    app.error = '';
    draw();
    startServerGame({ create: true, name });
  },

  /**
   * ONE Join button for both kinds of game.
   *
   * A player is told a four-character code, not a transport. So when there is a
   * server and it is answering, ask it first; a code it has never heard of falls
   * through to the peer join (see serverRejected). With no server configured, or
   * one that is switched off, this is the peer join it has always been.
   */
  async join(code) {
    const name = (app.name || '').trim();
    if (!name) { app.error = 'Enter a name first.'; draw(); return; }

    // The boot probe may still be in flight. Waiting for it beats guessing: a peer
    // attempt at a server-side code costs the player the whole 15-second join
    // timeout before it admits defeat, and a server that is up answers in ms.
    if (serverConfigured()
        && (app.server.state === 'unknown' || app.server.state === 'checking')) {
      app.busy = 'join';
      app.error = '';
      app.status = 'Looking for that game…';
      draw();
      await checkServer();
      // They started something else while we were asking.
      if (app.busy !== 'join' || app.screen !== 'home') return;
      app.busy = null;
      app.status = '';
    }

    if (app.server.state === 'up') { startServerGame({ code, name }); return; }
    joinPeer(code);
  },

  /** Join a specific open lobby from the server's list. No peer fallback here:
   *  this code came from the server itself, so a refusal is about the room rather
   *  than about which transport the game is on. */
  joinServerRoom(code) {
    const name = (app.name || '').trim();
    if (!name) { app.error = 'Enter a name first.'; draw(); return; }
    app.error = '';
    app.ui.joinCode = code;
    startServerGame({ code, name });
  },

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
/**
 * PeerJS is what the peer-to-peer path needs, and what the server path does not.
 *
 * So the complaint waits until we know whether there is a server: telling a player
 * the app is broken while "Host online" would have worked perfectly is worse than
 * saying nothing for the second or two the probe takes. With no server configured
 * there is nothing to wait for and this fires immediately, exactly as before.
 */
function reportMissingPeer() {
  if (window.Peer || app.error || app.server.state === 'up') return;
  app.error = 'Could not load the networking library. Check your connection and reload.';
  draw();
}

if (!resumeIfPossible()) draw();

if (serverConfigured()) {
  checkServer().then(() => {
    reportMissingPeer();
    if (app.screen === 'home') refreshServerRooms();
  });
} else {
  reportMissingPeer();
}

// The service worker is a progressive enhancement: a failure to register means
// no offline shell, which is not a reason to refuse to play.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
