// ============================================================================
// config.js — Where the optional authoritative server lives.
//
// THIS FILE IS THE ONLY THING THAT MAKES SERVER MODE EXIST. Blank the host below
// and the app is exactly what it always was: a static peer-to-peer game with no
// backend. That is not a fallback path bolted on afterwards — it is the default,
// it is what runs on a plane, and every piece of server UI is gated behind a live
// health probe so a server that is missing, off or unreachable simply isn't
// offered. See app.server in js/main.js.
//
// ----------------------------------------------------------------------------
// THE TRAILING SLASH ON SERVER_URL IS LOAD-BEARING.
//
// Caddy routes with `handle_path /literature/*`, which matches `/literature/` and
// everything under it — but NOT a bare `/literature`. A WebSocket upgrade to
// `wss://host/literature` therefore reaches the reverse proxy's fallback rather
// than the game server, and the symptom is a socket that opens and closes with no
// error worth reading. Don't tidy the slash away.
// ----------------------------------------------------------------------------
//
// The host below is a Tailscale Funnel address: it terminates TLS with a real
// certificate and is reachable from the public internet, which is why wss:// and
// https:// are correct here and why the server keeps an origin allowlist. The
// client is served from GitHub Pages, so that origin must appear in the server's
// ALLOWED_ORIGINS or every handshake is refused with a 403.
// ============================================================================

const HOST = 'pi.tail360216.ts.net';
const PREFIX = '/literature';

/** WebSocket endpoint. TRAILING SLASH REQUIRED — see above. */
export const SERVER_URL = `wss://${HOST}${PREFIX}/`;

/** Cheap liveness probe. sw.js deliberately never caches a path ending /health,
 *  so this always asks the network and a cached "yes" can never strand the app in
 *  server mode while the Pi is off. */
export const SERVER_HEALTH = `https://${HOST}${PREFIX}/health`;

/** Open lobbies on the server, so a player can find a game without being told the
 *  code. The server can turn this off (ROOMS_LIST=0); a 404 here is treated as
 *  "no list available" rather than as an error. */
export const SERVER_ROOMS = `https://${HOST}${PREFIX}/rooms`;

/** True when a server endpoint is configured at all. Everything server-shaped in
 *  the UI checks this first, then the health probe. */
export function serverConfigured() {
  return !!(SERVER_URL && SERVER_HEALTH);
}
