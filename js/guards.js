// ============================================================================
// guards.js — Bounds on anything that arrived from another device.
//
// WHAT THESE ARE FOR, AND WHAT THEY ARE NOT
//   Not rule enforcement. The engine is already defensive on its own account: an
//   unknown card code matches nothing in a hand, askProblem() rejects anything
//   that is not a real card, and sanitizeConfigPatch() rebuilds the config from a
//   fixed key list so a hostile KEY is dropped rather than stored. These bound
//   *work and memory* instead — a 60 KiB "card code" would be compared against
//   every card in every hand, and a claim assignment with ten thousand keys would
//   be walked before being rejected.
//
//   Neither are they authentication. Nothing here decides who you are; that is
//   the clientId rule in state.js.
//
// WHY A PEER-TO-PEER HOST NEEDS THIS AT ALL
//   PeerJS signalling goes through a broker on the public internet and the data
//   channel can fall back to a relay, so a browser host is reachable by anyone
//   who has (or guesses) the room code. "It's only my friends on my Wi-Fi" was
//   never true. The host here is somebody's phone, which is the weaker machine
//   and the one with a battery.
//
// Imports nothing, from anywhere, so `node` alone can exercise every rule and the
// browser can load it without a build step.
// ============================================================================

// A type is a short verb like 'ask'. Anything longer is not a type, whatever
// else it might be.
export const MAX_TYPE_LEN = 40;

/**
 * The shape every wire message must have, checked after parsing and before any
 * dispatch.
 *
 * An ARRAY parses fine as JSON and would sail past a `typeof === 'object'` check
 * while having no `.type`, so it is excluded by name.
 */
export function validEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.type !== 'string' || msg.type.length > MAX_TYPE_LEN) return null;
  return msg;
}

// ---------------------------------------------------------------------------
// Per-connection message rate limit.
//
// The point is not to stop one client being annoying to itself — it is that
// every accepted message fans out into a broadcast to the whole table. Without a
// limit, one peer sending in a loop multiplies its own flood by the number of
// players before it leaves the device.
//
// A refill rate rather than a fixed window, because real play is bursty: a hit
// keeps your turn, so a good run is a rapid string of asks.
// ---------------------------------------------------------------------------
export class TokenBucket {
  constructor({ capacity = 40, refillPerSec = 15, now = Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.stamp = now;
  }

  /** True if this message may proceed. Costs one token. */
  take(now = Date.now()) {
    const elapsed = Math.max(0, now - this.stamp) / 1000;
    this.stamp = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Input validation. Every one of these returns a value or null — never throws,
// and never hands back something half-cleaned.
// ---------------------------------------------------------------------------

// Long enough that collisions across a friend group are impossible, short enough
// to be obviously not a payload.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CARD_RE = /^[2-9TJQKA][SHDC]$/;
const SET_RE = /^([SHDC][LH]|E8)$/;

export function validClientId(raw) {
  return typeof raw === 'string' && CLIENT_ID_RE.test(raw) ? raw : null;
}

/** Card codes are exactly two characters, so this can be exact rather than a
 *  length cap. cards.js is still the authority on what is in play. */
export function validCardCode(raw) {
  return typeof raw === 'string' && CARD_RE.test(raw) ? raw : null;
}

export function validSetId(raw) {
  return typeof raw === 'string' && SET_RE.test(raw) ? raw : null;
}

export function validPlayerId(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

// A config patch as the lobby UI sends it: one or two keys per tap, or a whole
// preset.
const MAX_PATCH_KEYS = 16;

export function validConfigPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) return null;
  return raw;
}

// The biggest set is six cards, so a well-formed claim names six holders. The
// cap is a little looser than that and the engine checks the exact membership;
// this only stops a huge object being walked.
const MAX_CLAIM_KEYS = 8;

/**
 * A claim assignment: card code -> the player said to hold it. Rejected whole
 * rather than filtered, because a partly-cleaned claim would be scored against
 * the player as a miscall for reasons they never sent.
 */
export function validClaimAssignment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MAX_CLAIM_KEYS) return null;
  for (const [code, holder] of entries) {
    if (!validCardCode(code)) return null;
    if (!validPlayerId(holder)) return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Frame decoding for the PeerJS transport.
//
// A DataConnection hands back whatever the sender's serializer produced: this
// app sends JSON.stringify()'d text, so a string is the normal case, but
// PeerJS's own BinaryPack serializer would deliver an already-decoded object and
// a custom client could send binary.
//
// The size cap can only be applied to the text case, and that is not a gap worth
// pretending away: by the time an object arrives, PeerJS has already allocated
// it. The cap that matters for the object path is the connection ceiling in
// net.js, which stops the flood rather than each frame in it.
// ---------------------------------------------------------------------------
export const MAX_FRAME_BYTES = 65536;

export function decodePeerFrame(raw, { maxBytes = MAX_FRAME_BYTES } = {}) {
  if (typeof raw === 'string') {
    // Compared against the character count rather than the encoded byte length:
    // multi-byte characters make this stricter than the stated cap, never
    // looser, and it avoids allocating a TextEncoder for every frame.
    if (raw.length > maxBytes) return null;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return null; }
    return validEnvelope(msg);
  }
  // ArrayBuffer, Blob, TypedArray: something no version of this client sends.
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return null;
  return validEnvelope(raw);
}
