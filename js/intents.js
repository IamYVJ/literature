// ============================================================================
// intents.js — The single door into the engine.
//
// Every game-affecting wire message goes through applyGameIntent(). The host's
// own UI calls it too, on itself, rather than reaching into the engine directly.
// That is the point: there is exactly one mapping from "a message arrived" to "a
// method ran", so a local tap and a remote peer cannot possibly be treated
// differently. Adding a move means adding one case here and one method there.
//
// This file holds no state. It bounds the arguments (guards.js) and dispatches;
// WHO may do a thing is the engine's business — every host-only method already
// checks actorId against hostId, so re-checking here would be a second copy of
// the rule waiting to drift out of step.
// ============================================================================

import {
  validCardCode, validClaimAssignment, validConfigPatch, validPlayerId, validSetId,
} from './guards.js';

const BAD = (error) => ({ ok: false, error });

/** Intents that change nothing anyone else can see. Everything else triggers a
 *  broadcast, so the caller uses this to avoid pointless chatter. */
const QUIET = new Set([]);

export function isQuietIntent(type) { return QUIET.has(type); }

/**
 * Apply one intent. Returns the engine's own { ok, error, ... } plus `changed`,
 * which tells the caller whether to broadcast and re-render.
 *
 * `now` is threaded through rather than read from the clock inside, so tests and
 * a replaying host get the same answers.
 */
export function applyGameIntent(engine, actorId, msg, now = Date.now()) {
  if (!engine) return BAD('No game.');
  if (!actorId) return BAD('Who are you?');

  switch (msg.type) {
    // ---- Lobby -------------------------------------------------------------
    case 'setConfig': {
      const patch = validConfigPatch(msg.patch);
      if (!patch) return BAD('Bad settings.');
      return withChange(engine.setConfig(actorId, patch));
    }

    case 'addBot':
      return withChange(engine.addBot(actorId));

    case 'fillBots':
      return withChange(engine.fillWithBots(actorId));

    case 'removePlayer': {
      const playerId = validPlayerId(msg.playerId);
      if (!playerId) return BAD('Bad player.');
      return withChange(engine.removePlayer(actorId, playerId));
    }

    case 'shuffleSeats':
      return withChange(engine.shuffleSeats(actorId));

    case 'moveSeat': {
      const playerId = validPlayerId(msg.playerId);
      if (!playerId) return BAD('Bad player.');
      const delta = Number(msg.delta) < 0 ? -1 : 1;
      return withChange(engine.moveSeat(actorId, playerId, delta));
    }

    case 'startGame':
      return withChange(engine.startGame(actorId, now));

    case 'newGame':
      return withChange(engine.newGame(actorId, now));

    // ---- Play --------------------------------------------------------------
    case 'ask': {
      const targetId = validPlayerId(msg.targetId);
      if (!targetId) return BAD('Bad player.');
      const code = validCardCode(msg.code);
      if (!code) return BAD('That is not a card.');
      return withChange(engine.ask(actorId, targetId, code, now));
    }

    case 'claim': {
      const setId = validSetId(msg.setId);
      if (!setId) return BAD('Bad set.');
      const assignment = validClaimAssignment(msg.assignment);
      if (!assignment) return BAD('Name who holds each card.');
      return withChange(engine.claim(actorId, setId, assignment, now));
    }

    default:
      return BAD(`Unknown intent: ${msg.type}`);
  }
}

/** A successful intent changed something worth telling the table about. */
function withChange(res) {
  return { ...res, changed: !!res.ok };
}
