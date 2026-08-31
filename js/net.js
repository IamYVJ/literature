// ============================================================================
// net.js — WebRTC peer-to-peer networking (PeerJS), host-authoritative star.
//
// Architecture: HOST-AUTHORITATIVE STAR.
//   - The host creates a Peer whose ID is derived from the room code, so a
//     joiner can reconstruct the host's Peer ID from the code alone — no
//     discovery service required.
//   - Every joiner opens a single DataConnection to the host. Joiners never talk
//     to each other. The host validates every intent and sends each player the
//     public state plus only their own hand.
//
// ----------------------------------------------------------------------------
// WHY THE LAST CLAUSE ABOVE IS THE WHOLE GAME
//   Literature is played on hidden hands. A game of Sequence can be broadcast in
//   full to everybody, because the board IS the state and there is nothing to
//   hide; here, the same convenience would end the game. So this file offers two
//   different verbs on purpose:
//
//       broadcast(msg)     — for things the whole table may see.
//       sendTo(id, msg)    — for one player's cards.
//
//   engine.publicState() is safe to broadcast and engine.privateStateFor(id) is
//   not, and nothing in this file can tell them apart. main.js is where that
//   distinction is enforced; the naming here exists so that a mistake reads
//   wrongly ("broadcast the private state") rather than harmlessly.
//
// ----------------------------------------------------------------------------
// SIGNALING / OFFLINE NOTE (read this):
//   PeerJS needs a "broker" (signaling server) ONCE to perform the WebRTC
//   handshake. After that, game traffic goes device to device (see NAT TRAVERSAL
//   below for the case where it can't). The default broker is PeerJS's free
//   public cloud, which needs the internet to be reachable for that initial
//   handshake — even though the cached PWA shell loads offline. A room code is
//   therefore an address on a PUBLIC broker, not a LAN-local one:
//   peerIdForCode() is derivable by anybody.
//
//   FOR FULLY-OFFLINE LAN PLAY: run your own PeerServer on the LAN, e.g.
//       npx peer --port 9000 --key peerjs --path /myapp
//   then point BROKER_CONFIG at it:
//       export const BROKER_CONFIG = {
//         host: '192.168.1.50', port: 9000, path: '/myapp', key: 'peerjs',
//         secure: false,
//       };
//   Every device must use the SAME broker config to find each other.
//
// ----------------------------------------------------------------------------
// NAT TRAVERSAL — WHAT ACTUALLY HAPPENS:
//   `opts` below carries no `config`, so PeerJS's DEFAULT iceServers apply. In
//   the pinned 1.5.4 bundle those are Google's STUN plus TWO PUBLIC TURN RELAYS
//   (turn:eu-0 / us-0.turn.peerjs.com, with the credentials 'peerjs'/'peerjsp'
//   baked into the library and shared with every PeerJS app on the internet).
//
//   So this is NOT LAN-only, and it never was. STUN hole punching connects two
//   ordinary home routers on different ISPs, and when it fails WebRTC falls back
//   to relaying through peerjs.com. Keeping the default is a deliberate choice —
//   connectivity for people not in the same building — with three consequences
//   that the rest of the code has to be honest about:
//     1. A room is reachable from anywhere by anyone holding the code. That is
//        why a seat mid-game belongs to a clientId and not a display name
//        (state.js), and why the host applies the same guards to a peer as it
//        would to a stranger (js/guards.js) rather than trusting whoever
//        connects. In a hidden-hand game the prize for impersonating a seat is
//        somebody's cards, so this is not a theoretical tidiness.
//     2. Cross-network ICE shows each player's public IP to the others.
//     3. A relayed game depends on somebody else's infrastructure staying up.
//        The DataChannel is DTLS-encrypted end to end, so the relay forwards
//        ciphertext it cannot read — availability is the exposure here, not
//        confidentiality.
//
//   To make this LAN-only, pass `config: { iceServers: [] }` in newPeer(): with
//   no STUN and no relay only host candidates are gathered, and mDNS candidates
//   resolve on the local link alone.
//
//   Connections still fail: symmetric NAT plus a relay that is blocked or
//   unreachable, "client isolation" guest Wi-Fi, and some corporate networks
//   give up with no error from either side — the broker says the host exists,
//   and then the data channel never comes up. That silence is why joinHost
//   callers need their own timeout.
// ============================================================================

import { TokenBucket, decodePeerFrame } from './guards.js';

// Set to null to use PeerJS's default public cloud broker. Replace with an
// object (see note above) to self-host signaling for offline LAN play.
export const BROKER_CONFIG = null;

// ---------------------------------------------------------------------------
// Ceilings for the browser host, which is somebody's phone.
//
// A game needs at most 8 connections. The rest of this budget is for the churn
// that is normal and not abuse: a reconnecting player's new connection overlaps
// their dead one until PeerJS notices, and a player who switches from Wi-Fi to
// mobile data does that twice.
// ---------------------------------------------------------------------------
const MAX_HOST_CONNS = 40;

// A refused frame is dropped in silence — replying "too fast" to a flood answers
// every packet of it, which is the amplification the bucket exists to prevent.
// Persistent refusal is not a slow client though, it is a script, so the
// connection goes.
const MAX_REFUSED_FRAMES = 120;

// Peer IDs are namespaced so room codes don't collide with other PeerJS apps
// sharing the public broker.
export const PEER_PREFIX = 'literature-v1-';

export function peerIdForCode(code) {
  return PEER_PREFIX + code.toUpperCase();
}

export function codeFromPeerId(id) {
  return id.startsWith(PEER_PREFIX) ? id.slice(PEER_PREFIX.length) : null;
}

function newPeer(id) {
  // window.Peer comes from the PeerJS CDN <script> tag in index.html.
  const opts = BROKER_CONFIG ? { ...BROKER_CONFIG } : {};
  return id ? new window.Peer(id, opts) : new window.Peer(opts);
}

// ---------------------------------------------------------------------------
// Which peer errors are worth giving up over.
//
// The useful distinction is not PeerJS's own notion of fatality, it is whether
// we still have a game. Signaling failures leave existing DataConnections
// untouched, because those run directly between devices — so a host whose broker
// falls over keeps playing and only loses the ability to admit NEW players. Only
// a problem with the peer identity itself, or a browser that cannot do WebRTC,
// is genuinely unrecoverable.
// ---------------------------------------------------------------------------
const UNRECOVERABLE = new Set([
  'browser-incompatible',
  'invalid-id',
  'invalid-key',
  'unavailable-id',
  'ssl-unavailable',
]);

export function isFatalPeerError(err) {
  return UNRECOVERABLE.has(err && err.type);
}

// ---------------------------------------------------------------------------
// Broker socket recovery.
//
// When the socket to the signaling broker drops, PeerJS emits 'disconnected' and
// then does nothing: the event is a notification, not a recovery. reconnect()
// has to be called by hand, and until it is, the peer can neither accept nor
// make new connections — permanently. So one Wi-Fi blip would otherwise lock new
// players out of a game that is still running perfectly well.
//
// reconnect() reuses the SAME peer id, which is what keeps the room code valid
// across the blip.
// ---------------------------------------------------------------------------
const BROKER_RETRIES = 5;

function attachBrokerRecovery(peer, handlers = {}) {
  let tries = 0;
  let timer = null;

  const retry = () => {
    if (timer || peer.destroyed) return;
    if (tries >= BROKER_RETRIES) {
      handlers.onBrokerLost && handlers.onBrokerLost();
      return;
    }
    const delay = Math.min(1000 * 2 ** tries, 8000);
    tries += 1;
    timer = setTimeout(() => {
      timer = null;
      if (peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch (_) { retry(); }
    }, delay);
  };

  // Fires on the first connect AND on every successful reconnect.
  peer.on('open', () => {
    tries = 0;
    handlers.onBrokerUp && handlers.onBrokerUp();
  });

  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    handlers.onBrokerDown && handlers.onBrokerDown();
    retry();
  });

  return { cancel() { if (timer) { clearTimeout(timer); timer = null; } } };
}

// ---------------------------------------------------------------------------
// HOST side
// ---------------------------------------------------------------------------
export function createHost(code, handlers = {}) {
  const peer = newPeer(peerIdForCode(code));
  const connections = new Map(); // connId -> DataConnection (open, seated or not)
  const attached = new Set();    // every conn we've accepted, open or still opening
  const recovery = attachBrokerRecovery(peer, handlers);

  peer.on('open', () => handlers.onOpen && handlers.onOpen(code));

  peer.on('connection', (conn) => {
    // The ceiling is counted over connections we have ACCEPTED, not ones that
    // finished opening, or a flood of half-open connections would never be
    // counted at all.
    if (attached.size >= MAX_HOST_CONNS) {
      try { conn.close(); } catch (_) {}
      return;
    }
    attached.add(conn);

    // One bucket per connection, so a flood costs the flooder its own budget and
    // nobody else's. See js/guards.js for why this is in front of the dispatch.
    const bucket = new TokenBucket();
    let refused = 0;

    conn.on('open', () => {
      connections.set(conn.peer, conn);
      handlers.onConnect && handlers.onConnect(conn.peer, conn);
    });
    conn.on('data', (raw) => {
      const msg = decodePeerFrame(raw);
      // Junk is dropped silently — answering it would tell a prober that someone
      // is listening, and cost us a send per frame they can generate.
      if (!msg) return;
      if (!bucket.take()) {
        // A burst is normal: a hit keeps your turn, so a good run is a rapid
        // string of asks. A client that keeps going after the bucket is empty is
        // not playing, so it eventually loses the connection rather than being
        // throttled forever.
        if (++refused > MAX_REFUSED_FRAMES) { try { conn.close(); } catch (_) {} }
        return;
      }
      handlers.onData && handlers.onData(conn.peer, msg);
    });
    const drop = () => {
      attached.delete(conn);
      // Checked by identity, not by key: a client that redials keeps its peer id,
      // so its new connection replaces this one in the map and then this one's
      // close arrives. Matching on the key alone would let the dead socket evict
      // the live one and mark a player who is right here as gone.
      if (connections.get(conn.peer) === conn) {
        connections.delete(conn.peer);
        handlers.onDisconnect && handlers.onDisconnect(conn.peer);
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (err) => handlers.onError && handlers.onError(err));

  return {
    peer,
    connections,
    /** One player's own view. The only route by which cards may leave the host. */
    sendTo(connId, msg) {
      const conn = connections.get(connId);
      if (conn && conn.open) trySend(conn, msg);
    },
    /** Everybody's view. Whatever goes in here is public by definition. */
    broadcast(msg) {
      for (const conn of connections.values()) {
        if (conn.open) trySend(conn, msg);
      }
    },
    // Forget and close a connection without firing onDisconnect (we remove it
    // from the map first, so the conn's own close handler short-circuits). Used
    // when a reconnecting player takes over a seat held by a stale connection.
    dropConnection(connId) {
      const conn = connections.get(connId);
      connections.delete(connId);
      if (conn) { try { conn.close(); } catch (_) {} }
    },
    destroy() { recovery.cancel(); try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// CLIENT side
//
// Redialling the host.
//
// Losing the DataConnection is routine, not exceptional: a phone that sleeps, a
// Wi-Fi handover, a host who reloaded. PeerJS reports the close and then does
// nothing, so somebody has to dial again — and for a client the connection is
// the only thing carrying its view of the game.
//
// Redialling is safe because the seat does not live here. The host keeps it bound
// to our clientId (see addPlayer in js/state.js), so a fresh connection plus the
// `join` the caller sends on open puts us back in the same chair with the same
// cards. Which is also why this can keep trying rather than surfacing an error.
// ---------------------------------------------------------------------------
const DIAL_RETRIES = 8;
const DIAL_MAX_MS = 10000;

export function joinHost(code, handlers = {}) {
  const peer = newPeer(null);
  const recovery = attachBrokerRecovery(peer, handlers);
  const hostPeerId = peerIdForCode(code);
  let conn = null;
  let timer = null;
  let tries = 0;
  let stopped = false;

  const retry = () => {
    if (stopped || peer.destroyed || timer || conn) return;
    if (tries >= DIAL_RETRIES) { handlers.onGaveUp && handlers.onGaveUp(); return; }
    const delay = Math.min(1000 * 2 ** tries, DIAL_MAX_MS);
    tries += 1;
    timer = setTimeout(() => { timer = null; dial(); }, delay);
  };

  function dial() {
    if (stopped || peer.destroyed || conn) return;
    // Opening a connection needs the broker. If it is down, attachBrokerRecovery
    // is already working on it and its 'open' brings us back here — so this is a
    // pause, not a failure, and it must not burn a retry.
    if (peer.disconnected || !peer.open) return;

    const active = peer.connect(hostPeerId, { reliable: true });
    conn = active;
    let opened = false;

    active.on('open', () => {
      opened = true;
      tries = 0;
      handlers.onOpen && handlers.onOpen(active);
    });
    active.on('data', (raw) => {
      // Bounded on the way in even though this is "our" host: the code was typed
      // by a human and reaches whoever holds that peer id on a public broker, so
      // the thing on the other end is not necessarily the game we meant to join.
      const msg = decodePeerFrame(raw);
      if (msg) handlers.onData && handlers.onData(msg);
    });

    // A dead connection's events can arrive after it has been replaced, so only
    // the current one is allowed to report a loss or schedule a redial.
    const gone = () => {
      if (conn !== active) return;
      conn = null;
      // A dial that never opened is a failed attempt, not a lost game: saying
      // "getting back in" about a connection nobody ever had would be a lie, and
      // the caller's own join timeout already owns that case.
      if (opened) handlers.onClose && handlers.onClose();
      retry();
    };
    active.on('close', gone);
    // Not forwarded to onError: at this level an error only ever means the socket
    // died, and the honest report for that is "reconnecting", not a red banner.
    // A wrong room code or an unreachable broker surfaces as a peer error below.
    active.on('error', gone);
  }

  // Fires on the first connect and again after every broker reconnect. Both mean
  // the same thing here — the broker is usable, so dial if we are not connected.
  peer.on('open', () => dial());

  // A peer-level error firing before the connection opens almost always means
  // the room code is wrong or the broker is unreachable.
  peer.on('error', (err) => handlers.onError && handlers.onError(err));

  return {
    peer,
    send(msg) { if (conn && conn.open) trySend(conn, msg); },
    isOpen() { return !!(conn && conn.open); },
    destroy() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      recovery.cancel();
      try { peer.destroy(); } catch (_) {}
    },
  };
}

// ===========================================================================
// SERVER TRANSPORT — the second way this app can play.
//
// Everything above is peer-to-peer and stays exactly as it was. What follows is a
// plain WebSocket to an authoritative server, and it is deliberately shaped to
// present the SAME interface as joinHost() above — send / isOpen / destroy, and
// onOpen / onData / onClose / onError — so main.js can hold either one in `net`
// and the intent path does not have to know which is which.
//
// The asymmetry that remains is real and cannot be papered over: on this transport
// nobody's browser owns a GameEngine, so even the room's owner is a client sending
// messages. That is handled in main.js (app.mode), not here.
// ===========================================================================

/**
 * Open a socket to the server.
 *
 * No reconnect logic in here, on purpose. A dropped socket means something
 * different depending on whether we had a game yet, and only main.js knows that —
 * the same division of labour joinHost() already has with its join timeout.
 */
export function serverTransport(url, handlers = {}) {
  let ws;
  let opened = false;
  let dead = false;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    // A malformed URL throws synchronously. Report it asynchronously anyway, so
    // the caller's error path is the same one it uses for every other failure.
    setTimeout(() => handlers.onError && handlers.onError(err), 0);
    return { send() {}, isOpen() { return false; }, destroy() {} };
  }

  ws.onopen = () => { opened = true; handlers.onOpen && handlers.onOpen(); };

  ws.onmessage = (event) => {
    // Text frames only. The server never sends binary, so anything else is either
    // a proxy misbehaving or not our server at all.
    if (typeof event.data !== 'string') return;
    const msg = safeParse(event.data);
    if (msg && typeof msg.type === 'string') handlers.onData && handlers.onData(msg);
  };

  // A browser will not tell a page WHY a WebSocket failed — there is no status
  // code for a 403 from the origin check, and no distinguishing a refused
  // handshake from an unplugged router. All the page gets is close. So the useful
  // signal is `opened`: a socket that never opened at all is a connection problem
  // to report, and one that opened and then closed is a game to reconnect to.
  ws.onclose = (event) => {
    if (dead) return;
    dead = true;
    handlers.onClose && handlers.onClose({
      everOpened: opened,
      code: event ? event.code : 0,
      // 1000 is a deliberate close from the server (a redeploy, or a seat taken
      // over by another device); anything else is a failure.
      clean: !!(event && event.wasClean),
    });
  };

  ws.onerror = () => {
    // Always followed by close, which is where the decision is made. Swallowing it
    // here keeps an uninformative event from being reported twice.
  };

  return {
    ws,
    send(msg) {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify(msg)); } catch (_) { /* closing */ }
    },
    isOpen() { return ws.readyState === WebSocket.OPEN; },
    destroy() {
      dead = true;           // stop our own onclose from firing a handler
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(1000, 'Left'); } catch (_) {}
    },
  };
}

/**
 * Is the server there? Resolves to the /health body, or null.
 *
 * Deliberately cheap and deliberately timed out: this runs at boot, on the home
 * screen, before the player has asked for anything — so a Pi that is off must cost
 * a couple of seconds of a hidden probe and nothing else. Never throws; the caller
 * only has to distinguish an object from null.
 */
export async function probeServer(url, timeoutMs = 4000) {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body : null;
  } catch (_) {
    return null;            // offline, aborted, CORS, DNS, a captive portal…
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open lobbies on the server, or null if there is no list to be had.
 *
 * null covers three cases that the UI treats identically: the server is down, the
 * server has the list switched off (ROOMS_LIST=0, answered as a 404), or the
 * response was not what we expected. "No list" is not an error worth showing —
 * typing a code always works.
 */
export async function fetchServerRooms(url, timeoutMs = 4000) {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body && Array.isArray(body.rooms) ? body.rooms : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What a server refusal means, in words a player can act on.
 *
 *  The reasons are the ones server/session.js sends, and it sends a message of its
 *  own with each. These override that message only where the CLIENT knows better,
 *  because it knows what the player was trying to do and what the app can offer
 *  instead — 'in-progress' can suggest a rematch, 'server-full' can point at the
 *  peer-to-peer path that is still sitting right there on the home screen.
 *
 *  'no-room' is missing on purpose even though the server sends it: main.js
 *  intercepts that one before it ever reaches here and retries the same code over
 *  peer-to-peer, because a code that is not on the server may well be a phone
 *  hosting in the next room. */
export function describeServerRejection(reason, message) {
  switch (reason) {
    case 'no-room':
      return 'No game with that code is running on the server.';
    case 'in-progress':
      return 'That game has already started, so there is no seat to take. Ask the host to start a rematch.';
    case 'name-taken':
      return 'Someone in that game is already using that name — pick another.';
    case 'server-full':
      return 'The server has as many games as it can hold. Try again in a few minutes, or host on Wi-Fi instead.';
    case 'too-many':
      return 'Too many devices have joined that game already.';
    case 'replaced':
      return 'You opened this game on another device, so this one was disconnected.';
    default:
      return message || 'The server refused the connection.';
  }
}

// ---------------------------------------------------------------------------
// Wire helpers — JSON on the way out, guarded JSON on the way in.
// ---------------------------------------------------------------------------
function trySend(conn, msg) {
  try { conn.send(JSON.stringify(msg)); } catch (_) { /* connection torn down */ }
}

function safeParse(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Human-readable mapping for the common PeerJS error types, surfaced in the UI.
// ---------------------------------------------------------------------------
export function describePeerError(err) {
  const type = err && err.type;
  switch (type) {
    case 'peer-unavailable':
      return 'No game found with that code. Check the code and that the host is still hosting.';
    case 'unavailable-id':
      return 'That room code is already in use. Try hosting again for a new code.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return "Couldn't reach the connection server — check your internet / Wi-Fi.";
    case 'browser-incompatible':
      return 'This browser does not support the WebRTC features required.';
    default:
      return 'Connection problem: ' + (err && err.message ? err.message : 'unknown error') + '.';
  }
}
