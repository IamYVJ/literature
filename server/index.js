// ============================================================================
// index.js — The only file that knows this is a network service.
//
// Everything above it is testable without a socket: guards.js is pure policy,
// rooms.js talks to anything with .send(), session.js takes a frame and a clock.
// So this file is deliberately thin, and it is the ONLY file in server/ that
// imports `ws` — which is what keeps `npm test` install-free.
//
// WHERE THIS RUNS
//   In a container on a Raspberry Pi, behind Caddy on 127.0.0.1:8080, behind a
//   Tailscale Funnel on 443. Two consequences shape the code:
//
//   1. PREFIX-AGNOSTIC. Caddy's `handle_path /literature/*` strips the prefix, so
//      requests arrive here as `/`, `/health`, `/rooms`. Paths are matched on the
//      last segment anyway, because a mismatch between the proxy's idea of the
//      prefix and this server's would otherwise show up as a baffling 404 rather
//      than as a misconfiguration.
//
//   2. THERE IS NO CLIENT IP. Every connection arrives from the proxy, and
//      X-Forwarded-For is whatever the client wrote in it. Per-IP limits would
//      therefore be a comforting fiction, so the caps here are GLOBAL — total
//      connections, total rooms — plus a per-connection token bucket. Those are
//      numbers that are actually true.
// ============================================================================

import http from 'node:http';
import { WebSocketServer } from 'ws';

import { RoomManager, SERVER_AWAY_MS } from './rooms.js';
import { Session } from './session.js';
import { originAllowed, parseOrigins } from './guards.js';

// ---------------------------------------------------------------------------
// Configuration. Every one of these has a working default, because a container
// started with no environment at all should come up and be playable rather than
// crash — but the two that matter for safety (origins, production) default to the
// STRICT setting, so a forgotten variable fails closed.
// ---------------------------------------------------------------------------
const PORT = int(process.env.PORT, 9000);
const PRODUCTION = process.env.NODE_ENV === 'production';
const VERSION = process.env.APP_VERSION || 'dev';

// The client is served from GitHub Pages. This is anti-CSRF, not authentication:
// a browser cannot lie about Origin, so it stops a random web page driving a
// player's session; a script can write anything, so it stops nothing else. See
// guards.js.
const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGINS || 'https://iamyvj.github.io');

// A 2GB Pi. These are the ceilings that keep a bad day from becoming a reboot.
const MAX_CONNS = int(process.env.MAX_CONNS, 200);
const MAX_ROOMS = int(process.env.MAX_ROOMS, 50);
const ROOM_TTL_MS = int(process.env.ROOM_TTL_MS, 6 * 60 * 60 * 1000);
const EMPTY_TTL_MS = int(process.env.EMPTY_TTL_MS, 15 * 60 * 1000);

// How long an empty chair is left alone before the table plays it. Tunable
// because it is the one number here that is a matter of taste rather than of
// safety: a patient table might want a minute, a table of strangers ten seconds.
// See the note on SERVER_AWAY_MS in rooms.js for why the server's default is much
// longer than the browser host's.
const AWAY_MS = int(process.env.AWAY_MS, SERVER_AWAY_MS);

// 64 KiB. The largest thing a client legitimately sends is a claim naming six
// cards or a config patch of a dozen small keys, so this is three orders of
// magnitude of headroom and still small enough that a frame cannot be a memory
// attack. `ws` closes the socket itself when it is exceeded, before the payload is
// buffered.
const MAX_PAYLOAD = int(process.env.MAX_PAYLOAD, 64 * 1024);

// Whether /rooms lists open lobbies. Default on, because the public PeerJS broker
// has peer discovery disabled and this list is the only thing that lets somebody
// find a game without being told the code — but see the comment on
// RoomManager#joinable(): it makes every open lobby on the box enumerable by
// anyone who can reach the URL. ROOMS_LIST=0 turns it off for a
// share-the-code-yourself deployment.
const ROOMS_LIST = process.env.ROOMS_LIST !== '0';

// A phone that goes into a tunnel leaves a socket that looks perfectly open from
// this end. Without a heartbeat those accumulate against MAX_CONNS and hold seats
// that the room believes are occupied.
const PING_MS = int(process.env.PING_MS, 30_000);
const SWEEP_MS = int(process.env.SWEEP_MS, 60_000);

const rooms = new RoomManager({
  maxRooms: MAX_ROOMS,
  idleTtlMs: ROOM_TTL_MS,
  emptyTtlMs: EMPTY_TTL_MS,
  awayMs: AWAY_MS,
});

// ---------------------------------------------------------------------------
// HTTP. Two read-only endpoints and nothing else — no static files, because the
// client is on GitHub Pages and a static file server here would be surface with
// no purpose.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const path = lastSegment(req.url);

  if (req.method === 'OPTIONS') return finish(res, 204, null);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return finish(res, 405, { error: 'Method not allowed' });
  }

  // /health is what the client probes at boot to decide whether server mode is
  // even on offer, and what Docker's HEALTHCHECK asks. It must stay cheap and
  // uncached — sw.js already refuses to cache any path ending in /health.
  if (path === 'health') {
    return finish(res, 200, {
      ok: true,
      version: VERSION,
      rooms: rooms.size,
      conns: wss.clients.size,
      uptime: Math.round(process.uptime()),
    });
  }

  if (path === 'rooms') {
    if (!ROOMS_LIST) return finish(res, 404, { error: 'Not found' });
    return finish(res, 200, { rooms: rooms.joinable() });
  }

  return finish(res, 404, { error: 'Not found' });
});

/**
 * One writer for every response, so the headers cannot be right on one path and
 * missing on another.
 *
 * Access-Control-Allow-Origin is `*` and that is not a weakening of anything: CORS
 * governs what a BROWSER will hand to a page, not what this server will answer, so
 * curl reads these endpoints either way. The reason it is safe is that both
 * endpoints are public reads of public facts — a version string, two counts, and
 * room codes that were never secrets.
 */
function finish(res, status, body) {
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': 'no-store',
  };
  if (body === null) { res.writeHead(status, headers); res.end(); return; }
  const text = JSON.stringify(body);
  headers['content-type'] = 'application/json; charset=utf-8';
  headers['content-length'] = Buffer.byteLength(text);
  res.writeHead(status, headers);
  res.end(text);
}

// ---------------------------------------------------------------------------
// WebSocket. `noServer` rather than handing `ws` the http server, so the origin
// check and the connection cap happen BEFORE the handshake completes and can
// answer with a real HTTP status instead of a socket that opens and then closes
// for no stated reason.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin, { allowed: ALLOWED_ORIGINS, production: PRODUCTION })) {
    return refuseUpgrade(socket, 403, 'Forbidden');
  }
  if (wss.clients.size >= MAX_CONNS) {
    return refuseUpgrade(socket, 503, 'Server busy');
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function refuseUpgrade(socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch (_) { /* the socket went first; nothing to do */ }
}

wss.on('connection', (ws) => {
  const session = new Session(ws, rooms);
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => session.handleFrame(data, isBinary));
  ws.on('close', () => session.detach());
  // A socket-level error is already fatal to the socket; `ws` emits 'close' after
  // it. Swallowing it here only stops it reaching process level and taking the
  // whole server — and with it everyone else's game — down with it.
  ws.on('error', () => {});
});

// Three intervals, all unref'd so they can never be the reason the process stays
// alive during a shutdown.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, PING_MS);
heartbeat.unref();

const gc = setInterval(() => {
  const dropped = rooms.sweep();
  if (dropped) console.log(`[gc] dropped ${dropped} idle room(s), ${rooms.size} left`);
}, SWEEP_MS);
gc.unref();

// The turn clock. Not an env knob like the two above, because it isn't a policy
// choice: the shortest turn a host can pick is 15 seconds, every option is a whole
// number of them, and a second is simply the resolution at which "your time is up"
// stops being a lie. Tuning it up would make the skip visibly late; tuning it down
// would buy nothing a player could perceive.
// Bots ride the same interval rather than getting one of their own — same
// argument as above, and they need the same resolution. Clocks first, so a human
// who has just run out of time loses the turn before a bot is offered it.
const clock = setInterval(() => {
  rooms.tickClocks();
  rooms.tickBots();
}, 1000);
clock.unref();

// ---------------------------------------------------------------------------
// Lifecycle. `docker stop` sends SIGTERM and waits ten seconds; answering it
// means a redeploy closes sockets cleanly and every client sees a close event it
// can reconnect from, instead of a hang that has to time out.
// ---------------------------------------------------------------------------
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[server] ${signal} — closing`);
    clearInterval(heartbeat);
    clearInterval(gc);
    clearInterval(clock);
    for (const ws of wss.clients) {
      try { ws.close(1001, 'Server restarting'); } catch (_) {}
    }
    server.close(() => process.exit(0));
    // If a socket refuses to go, don't hold the container hostage past Docker's
    // grace period — it would be killed anyway, and less tidily.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(PORT, () => {
  console.log(`[server] literature ${VERSION} on :${PORT}`);
  console.log(`[server] production=${PRODUCTION} origins=${ALLOWED_ORIGINS.join(',') || '(any)'}`);
  console.log(`[server] caps: conns=${MAX_CONNS} rooms=${MAX_ROOMS} payload=${MAX_PAYLOAD}B roomsList=${ROOMS_LIST} away=${AWAY_MS}ms`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An env var that isn't a positive number is a mistake, not an instruction, so it
 *  falls back to the default rather than turning a cap into NaN — which compares
 *  false against everything and would silently remove the limit. */
function int(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The last path segment, so the same build works whether the proxy strips the
 *  /literature prefix or not. Query string and trailing slash removed. */
function lastSegment(url) {
  const path = String(url || '/').split('?')[0].replace(/\/+$/, '');
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
