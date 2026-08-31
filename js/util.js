// ============================================================================
// util.js — Small helpers shared across modules. No game logic here.
// ============================================================================

// Unambiguous alphabet: no O/0, I/1, so a code read aloud across a table can't
// be mistyped.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

export function generateRoomCode() {
  let code = '';
  const arr = new Uint32Array(CODE_LENGTH);
  (globalThis.crypto || window.crypto).getRandomValues(arr);
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Normalise a typed code: uppercase, then keep only alphabet characters. The
 *  look-alikes (O/0, I/1) are not in the alphabet, so they are dropped rather
 *  than silently guessed at. */
export function normalizeCode(raw) {
  return (raw || '')
    .toUpperCase()
    .split('')
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, CODE_LENGTH);
}

export { CODE_LENGTH };

// --- Clipboard -------------------------------------------------------------
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

// --- Lightweight persistence (display name + last room code) ---------------
const NAME_KEY = 'literature.name';
const CODE_KEY = 'literature.lastCode';

export function loadName()  { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} }
export function loadCode()  { try { return localStorage.getItem(CODE_KEY) || ''; } catch (_) { return ''; } }
export function saveCode(c) { try { localStorage.setItem(CODE_KEY, c); } catch (_) {} }

// --- Device identity -------------------------------------------------------
//
// A random secret that identifies THIS BROWSER to whichever machine is running
// the game, and the only thing a seat in progress is ever bound to.
//
// Why it has to be a secret and not the display name: anyone on the internet can
// reach a 4-character room code and type any name they like, so a seat that can
// be reclaimed by naming it can be stolen by naming it. In Literature the prize
// for stealing a seat is a hand of cards nobody else is allowed to see, which
// makes this the difference between a game and a spectator sport. PeerJS
// signalling is a public broker and the data channel can fall back to a public
// relay, so "it's only my friends on my Wi-Fi" was never true. See addPlayer()
// in js/state.js for the seat-binding rule this feeds.
//
// It is therefore treated like a credential: never rendered, never logged, never
// put in a URL, and never sent to anything but the game host itself.
//
// The character class matches validClientId() in js/guards.js exactly (8-64 of
// [A-Za-z0-9_-]), so a value that would be refused cannot be generated here, and
// a value that has somehow been tampered with in localStorage is replaced rather
// than sent.
const CLIENT_KEY = 'literature.clientId';
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Used only when localStorage is unavailable (private browsing, storage denied).
// A per-tab identity still lets a connection that blips reclaim its own seat; it
// just doesn't survive a reload, which is the best that can be done without
// storage.
let volatileClientId = null;

function newClientId() {
  const bytes = new Uint8Array(16);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out; // 32 hex characters
}

export function clientId() {
  try {
    const stored = localStorage.getItem(CLIENT_KEY);
    if (stored && CLIENT_ID_RE.test(stored)) return stored;
    const fresh = newClientId();
    localStorage.setItem(CLIENT_KEY, fresh);
    return fresh;
  } catch (_) {
    if (!volatileClientId) volatileClientId = newClientId();
    return volatileClientId;
  }
}

// --- Session resume (reload / rejoin returns to the same game) -------------
// We remember whether this device was hosting or joining, the room code and the
// player name, plus (for a host) a snapshot of the authoritative engine so a host
// reload can rehydrate the game in progress. Stale sessions expire so a reload
// days later doesn't try to rejoin a long-dead game.
const SESSION_KEY = 'literature.session';
const ENGINE_KEY = 'literature.engine';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, ts: Date.now() })); } catch (_) {}
}
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.ts || (Date.now() - s.ts) > SESSION_TTL_MS) { clearSession(); return null; }
    return s;
  } catch (_) { return null; }
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(ENGINE_KEY); } catch (_) {}
}

// The snapshot contains every hand, so it is the one thing in here that must
// never leave the device. It is written only by a host, only to that host's own
// localStorage, and read only to rehydrate its own engine.
export function saveEngineSnapshot(snap) {
  try { localStorage.setItem(ENGINE_KEY, JSON.stringify({ snap, ts: Date.now() })); } catch (_) {}
}
export function loadEngineSnapshot() {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.ts || (Date.now() - o.ts) > SESSION_TTL_MS) return null;
    return o.snap;
  } catch (_) { return null; }
}

// --- DOM helpers -----------------------------------------------------------
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'string') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
