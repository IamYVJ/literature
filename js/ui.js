// ============================================================================
// ui.js — Everything that touches the DOM, and nothing that decides anything.
//
// One entry point: render(root, app, actions). It reads `app` and writes nodes.
// It never mutates `app`, never calls the engine, and never keeps state of its
// own — the selections a player makes while building a move live in `app.ui`,
// which main.js owns, so a re-render caused by somebody else's move cannot
// silently discard a half-built ask.
//
// WHAT THIS FILE IS NOT ALLOWED TO SEE
//   The only card identities in here come from `app.priv` (this player's own
//   hand) and from resolved claims, which are public. `app.pub` carries hand
//   SIZES and nothing more. That is not a convention this file enforces, it is a
//   property of the two views in state.js — but it is the reason there is no
//   "other player's hand" component to reach for by mistake.
//
// `actions` is the whole outward surface: send(msg) posts an intent, and the
// rest are local UI concerns. ui.js does not know whether send() runs the engine
// in this tab or writes to a DataConnection.
// ============================================================================

import {
  cardLabel, cardSpoken, isRedSuit, rankLabel, setCards, setLabel, setLongLabel,
  suitGlyph,
} from './cards.js';
import { CONFIG_SPEC, PRESETS, teamColor, teamName } from './rules.js';
import { CODE_LENGTH, clear, el, normalizeCode } from './util.js';

/** Read out to screen readers. The node lives outside #app because a live region
 *  only fires for content added to a node already in the document, and #app is
 *  rebuilt on every render. */
export function announce(text) {
  const node = document.getElementById('announce');
  if (node) node.textContent = text;
}

/**
 * Rebuild the screen from `app`.
 *
 * The tree is thrown away and built fresh every time, which is what keeps this
 * file stateless — but it also means the focused node stops existing mid-render.
 * For a text field being typed into, that is fatal rather than cosmetic: the
 * field's own handler triggers the render, so without this the room code loses
 * focus after its first character and the rest of the code cannot be typed.
 *
 * Restoring by `id` is enough because ids are exactly the elements a player
 * types into. A button that vanishes on click has genuinely gone.
 */
export function render(root, app, actions) {
  const held = document.activeElement;
  const focus = held && held.id && root.contains(held)
    ? { id: held.id, start: held.selectionStart, end: held.selectionEnd }
    : null;

  clear(root);
  root.appendChild(screenFor(app, actions));

  if (!focus) return;
  const again = document.getElementById(focus.id);
  if (!again) return;
  again.focus();
  if (focus.start !== null && focus.start !== undefined) {
    again.setSelectionRange(focus.start, focus.end);
  }
}

function screenFor(app, actions) {
  switch (app.screen) {
    case 'lobby': return lobbyScreen(app, actions);
    case 'play': return playScreen(app, actions);
    case 'over': return overScreen(app, actions);
    default: return homeScreen(app, actions);
  }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function homeScreen(app, actions) {
  const nameField = el('input', {
    id: 'name',
    class: 'field',
    type: 'text',
    maxlength: 16,
    placeholder: 'Your name',
    value: app.name || '',
    autocomplete: 'nickname',
    oninput: (e) => actions.setName(e.target.value),
  });

  const codeField = el('input', {
    id: 'code',
    class: 'field code-field',
    type: 'text',
    inputmode: 'latin',
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: CODE_LENGTH,
    placeholder: 'CODE',
    value: app.ui.joinCode || '',
    // Normalised as it is typed, so the look-alike characters that are not in
    // the alphabet never make it into the field to be puzzled over.
    oninput: (e) => {
      const clean = normalizeCode(e.target.value);
      e.target.value = clean;
      actions.setUi({ joinCode: clean });
    },
  });

  return el('div', { class: 'screen home' },
    el('header', { class: 'masthead' },
      el('h1', { class: 'title' }, 'Literature'),
      el('p', { class: 'tagline' }, 'Collect half-suits by asking the other team for cards.'),
    ),
    banner(app, actions),
    el('section', { class: 'card' },
      el('label', { class: 'label', for: 'name' }, 'Name'),
      nameField,
      el('div', { class: 'row gap' },
        el('button', {
          class: 'btn primary grow',
          disabled: !app.name.trim() || app.busy,
          onclick: () => actions.host(),
        }, app.busy === 'host' ? 'Starting…' : 'Host a game'),
      ),
      el('div', { class: 'divider' }, el('span', {}, 'or')),
      el('label', { class: 'label', for: 'code' }, 'Join with a code'),
      el('div', { class: 'row gap' },
        codeField,
        el('button', {
          class: 'btn grow',
          disabled: !app.name.trim()
            || (app.ui.joinCode || '').length !== CODE_LENGTH
            || app.busy,
          onclick: () => actions.join(app.ui.joinCode),
        }, app.busy === 'join' ? 'Joining…' : 'Join'),
      ),
    ),
    rulesCard(),
  );
}

function rulesCard() {
  return el('details', { class: 'card rules' },
    el('summary', {}, 'How to play'),
    el('ol', { class: 'rules-list' },
      el('li', {}, 'Two teams sit alternately, so the players either side of you are opponents.'),
      el('li', {}, 'A set is half a suit: 2–7 low, 9–A high. Eight sets of six cards, or nine if the host keeps the 8s in.'),
      el('li', {}, 'On your turn, ask one opponent for one card. You must already hold a card of that set, and you cannot ask for a card you hold.'),
      el('li', {}, 'If they have it they hand it over and you ask again. If they do not, the turn passes to them.'),
      el('li', {}, 'Claim a set by naming who on your team holds each card. Right and it is yours; wrong and it goes to the other team.'),
      el('li', {}, 'The first team to take the majority of the sets wins.'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function lobbyScreen(app, actions) {
  const pub = app.pub;
  const isHost = app.mode === 'host';
  const seated = pub ? pub.players.length : 0;
  const wanted = pub ? pub.config.numPlayers : 0;

  return el('div', { class: 'screen lobby' },
    topBar(app, actions, 'Lobby'),
    banner(app, actions),
    el('section', { class: 'card code-card' },
      el('p', { class: 'label' }, 'Room code'),
      el('div', { class: 'row gap center' },
        el('strong', { class: 'roomcode' }, app.code || '----'),
        el('button', { class: 'btn small', onclick: () => actions.copyCode() },
          app.ui.copied ? 'Copied' : 'Copy'),
      ),
      el('p', { class: 'hint' },
        'Everyone joins on their own phone — your cards are only ever sent to you.'),
    ),
    el('section', { class: 'card' },
      el('div', { class: 'row between' },
        el('h2', { class: 'h2' }, 'Players'),
        el('span', { class: 'count' }, `${seated} of ${wanted}`),
      ),
      el('ul', { class: 'seats' },
        (pub ? pub.players : []).map((p) => seatRow(p, app, actions, isHost)),
        Array.from({ length: Math.max(0, wanted - seated) }, (_, i) => el('li', { class: 'seat empty' },
          el('span', { class: 'pip', style: `--team:${teamColor((seated + i) % 2)}` }),
          el('span', { class: 'seat-name' }, 'Waiting…'),
          el('span', { class: 'seat-team' }, teamName((seated + i) % 2)),
        )),
      ),
      isHost && el('div', { class: 'row gap wrap' },
        el('button', {
          class: 'btn small',
          disabled: seated >= wanted,
          onclick: () => actions.send({ type: 'addBot' }),
        }, 'Add bot'),
        el('button', {
          class: 'btn small',
          disabled: seated >= wanted,
          onclick: () => actions.send({ type: 'fillBots' }),
        }, 'Fill with bots'),
        el('button', {
          class: 'btn small',
          disabled: seated < 2,
          onclick: () => actions.send({ type: 'shuffleSeats' }),
        }, 'Shuffle seats'),
      ),
    ),
    isHost ? settingsCard(pub, actions) : settingsSummary(pub),
    isHost
      ? el('button', {
        class: 'btn primary big',
        disabled: seated !== wanted,
        onclick: () => actions.send({ type: 'startGame' }),
      }, seated === wanted ? 'Start game' : `Need ${wanted - seated} more`)
      : el('p', { class: 'waiting' }, 'Waiting for the host to start…'),
  );
}

function seatRow(p, app, actions, isHost) {
  const isMe = p.id === app.myId;
  return el('li', { class: `seat${isMe ? ' me' : ''}${p.online ? '' : ' offline'}` },
    el('span', { class: 'pip', style: `--team:${teamColor(p.team)}` }),
    el('span', { class: 'seat-name' },
      p.name,
      p.isHost && el('span', { class: 'tag' }, 'host'),
      p.isBot && el('span', { class: 'tag' }, 'bot'),
      isMe && el('span', { class: 'tag you' }, 'you'),
      !p.online && el('span', { class: 'tag warn' }, 'away'),
    ),
    el('span', { class: 'seat-team' }, teamName(p.team)),
    isHost && el('span', { class: 'seat-tools' },
      el('button', {
        class: 'icon', title: 'Move up', 'aria-label': `Move ${p.name} up`,
        onclick: () => actions.send({ type: 'moveSeat', playerId: p.id, delta: -1 }),
      }, '↑'),
      el('button', {
        class: 'icon', title: 'Move down', 'aria-label': `Move ${p.name} down`,
        onclick: () => actions.send({ type: 'moveSeat', playerId: p.id, delta: 1 }),
      }, '↓'),
      !p.isHost && el('button', {
        class: 'icon danger', title: 'Remove', 'aria-label': `Remove ${p.name}`,
        onclick: () => actions.send({ type: 'removePlayer', playerId: p.id }),
      }, '×'),
    ),
  );
}

// The settings UI is generated from CONFIG_SPEC rather than listed by hand, so a
// new house rule in rules.js appears here without this file being edited.
const CONFIG_LABELS = {
  numPlayers: ['Players', 'Seats at the table.'],
  eightsAsSet: ['Eights are a ninth set', 'Keeps the four 8s in. Nine sets means a draw is impossible.'],
  mustHoldSetToAsk: ['Must hold the set to ask', 'The standard rule. Off makes for a looser, faster game.'],
  claimAnyTime: ['Claim at any time', 'Off restricts claiming to your own turn.'],
  wrongClaimAwardsOpponent: ['A miscall gives the set away', 'Off voids the set instead, so nobody scores it.'],
  turnSeconds: ['Turn clock', 'Seconds per turn. 0 for no clock.'],
  showHistory: ['Show the ask record', 'Off means you have to remember what was asked, like at a real table.'],
};

function settingsCard(pub, actions) {
  if (!pub) return null;
  const cfg = pub.config;

  return el('section', { class: 'card' },
    el('h2', { class: 'h2' }, 'House rules'),
    el('div', { class: 'row gap wrap presets' },
      Object.values(PRESETS).map((preset) => el('button', {
        class: 'btn small',
        onclick: () => actions.send({ type: 'setConfig', patch: preset.patch }),
      }, preset.label)),
    ),
    el('div', { class: 'settings' },
      Object.entries(CONFIG_SPEC).map(([key, spec]) => {
        const [label, hint] = CONFIG_LABELS[key] || [key, ''];
        return el('div', { class: 'setting' },
          el('div', { class: 'setting-text' },
            el('span', { class: 'setting-label' }, label),
            hint && el('span', { class: 'setting-hint' }, hint),
          ),
          settingControl(key, spec, cfg, actions, label),
        );
      }),
    ),
  );
}

// `label` is the rule's visible text. It sits in a sibling element, so nothing
// ties it to the control for a screen reader: the switch is a bare knob and the
// stops are bare numbers. Without a name here they are announced as seven
// identical switches and two unlabelled rows of digits.
function settingControl(key, spec, cfg, actions, label) {
  const patchWith = (value) => actions.send({ type: 'setConfig', patch: { [key]: value } });

  if (spec.type === 'bool') {
    return el('button', {
      class: `toggle${cfg[key] ? ' on' : ''}`,
      role: 'switch',
      'aria-checked': cfg[key] ? 'true' : 'false',
      'aria-label': label,
      onclick: () => patchWith(!cfg[key]),
    }, el('span', { class: 'knob' }));
  }

  if (spec.type === 'enum') {
    return el('div', { class: 'row gap', role: 'group', 'aria-label': label }, spec.values.map((v) => el('button', {
      class: `chip${cfg[key] === v ? ' sel' : ''}`,
      onclick: () => patchWith(v),
    }, String(v))));
  }

  // int: the turn clock. A few sensible stops beat a spinner on a phone.
  const stops = [0, 20, 30, 45, 60, 90];
  return el('div', { class: 'row gap wrap', role: 'group', 'aria-label': label }, stops.map((v) => el('button', {
    class: `chip${cfg[key] === v ? ' sel' : ''}`,
    onclick: () => patchWith(v),
  }, v === 0 ? 'Off' : `${v}s`)));
}

function settingsSummary(pub) {
  if (!pub) return null;
  const cfg = pub.config;
  const bits = [
    `${cfg.numPlayers} players`,
    cfg.eightsAsSet ? '9 sets (8s in)' : '8 sets',
    cfg.turnSeconds ? `${cfg.turnSeconds}s turns` : 'no clock',
    cfg.showHistory ? 'ask record shown' : 'from memory',
  ];
  return el('section', { class: 'card' },
    el('h2', { class: 'h2' }, 'House rules'),
    el('p', { class: 'summary' }, bits.join(' · ')),
  );
}

// ---------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------
function playScreen(app, actions) {
  const { pub, priv } = app;
  if (!pub || !priv) return el('div', { class: 'screen play' }, topBar(app, actions, 'Literature'), spinner());

  const claiming = !!app.ui.claimSetId;

  return el('div', { class: 'screen play' },
    topBar(app, actions, 'Literature'),
    banner(app, actions),
    scoreboard(pub, priv),
    tableView(pub, priv, app),
    turnNotice(pub, priv, app),
    claiming ? claimBuilder(app, actions) : (priv.isTurn ? askBuilder(app, actions) : null),
    handView(priv),
    claiming ? null : claimOpener(pub, priv, actions),
    recordPanel(pub, app, actions),
  );
}

function scoreboard(pub, priv) {
  return el('section', { class: 'scoreboard' },
    [0, 1].map((team) => el('div', {
      class: `score${priv.team === team ? ' mine' : ''}`,
      style: `--team:${teamColor(team)}`,
    },
      el('span', { class: 'score-team' }, teamName(team), priv.team === team ? ' (you)' : ''),
      el('span', { class: 'score-value' }, String(pub.scores[team])),
      el('span', { class: 'score-target' }, `of ${pub.target} to win`),
    )),
  );
}

function tableView(pub, priv, app) {
  const claimedBy = new Map();
  for (const c of pub.claims) claimedBy.set(c.setId, c);

  return el('section', { class: 'card table' },
    el('ul', { class: 'players' },
      pub.players.map((p) => el('li', {
        class: [
          'player',
          p.id === pub.turnId ? 'turn' : '',
          p.id === app.myId ? 'me' : '',
          p.team === priv.team ? 'ally' : 'foe',
          p.online ? '' : 'offline',
          p.cards === 0 ? 'spent' : '',
        ].filter(Boolean).join(' '),
        style: `--team:${teamColor(p.team)}`,
      },
        el('span', { class: 'pip' }),
        el('span', { class: 'player-name' }, p.name,
          p.isBot && el('span', { class: 'tag' }, 'bot'),
          p.id === app.myId && el('span', { class: 'tag you' }, 'you'),
          !p.online && el('span', { class: 'tag warn' }, 'away'),
        ),
        el('span', { class: 'player-cards', title: `${p.cards} cards` },
          p.cards === 0 ? 'out' : `${p.cards}🂠`),
      )),
    ),
    el('div', { class: 'sets-strip' },
      pub.setsInPlay.map((setId) => {
        const c = claimedBy.get(setId);
        const cls = c
          ? (c.team === null ? 'set-tile void' : 'set-tile won')
          : 'set-tile open';
        return el('span', {
          class: cls,
          style: c && c.team !== null ? `--team:${teamColor(c.team)}` : '',
          title: c
            ? (c.team === null
              ? `${setLongLabel(setId)} — voided by ${c.byName}`
              : `${setLongLabel(setId)} — ${teamName(c.team)}, called by ${c.byName}`)
            : `${setLongLabel(setId)} — still open`,
        }, setLabel(setId));
      }),
    ),
  );
}

function turnNotice(pub, priv, app) {
  const who = pub.players.find((p) => p.id === pub.turnId);
  const clock = app.clock;

  if (priv.isTurn) {
    return el('div', { class: 'notice mine' },
      el('strong', {}, priv.mustClaim ? 'You must claim.' : 'Your turn.'),
      ' ',
      priv.mustClaim
        ? 'You have no legal question left, so name a set your team holds.'
        : 'Ask one opponent for one card.',
      clock !== null && clock !== undefined && el('span', { class: 'clock' }, `${clock}s`),
    );
  }
  return el('div', { class: 'notice' },
    `Waiting for ${who ? who.name : 'the next player'}…`,
    clock !== null && clock !== undefined && el('span', { class: 'clock' }, `${clock}s`),
  );
}

/**
 * The ask, built in three taps: set, card, opponent.
 *
 * Only legal options are offered — priv.askable already excludes sets this hand
 * cannot ask in and cards it already holds, and priv.targets excludes teammates
 * and anyone out of cards. The engine re-checks all of it; this just means a
 * player is never invited to make a move that will be refused.
 */
function askBuilder(app, actions) {
  const { priv } = app;
  const { setId, code, targetId } = app.ui;

  if (!priv.askable.length) {
    return el('section', { class: 'card builder' },
      el('p', { class: 'empty' }, 'No question is legal from this hand.'),
    );
  }

  const chosenSet = priv.askable.find((a) => a.setId === setId) || null;

  return el('section', { class: 'card builder' },
    el('h2', { class: 'h2' }, 'Ask for a card'),

    el('p', { class: 'step' }, '1. Which set?'),
    el('div', { class: 'row gap wrap' }, priv.askable.map((a) => el('button', {
      class: `chip set-chip${a.setId === setId ? ' sel' : ''}`,
      // Changing set invalidates the card already picked, so clear it rather
      // than leave a selection that belongs to a different set.
      onclick: () => actions.setUi({ setId: a.setId, code: null }),
    }, setLabel(a.setId)))),

    chosenSet && el('p', { class: 'step' }, '2. Which card?'),
    chosenSet && el('div', { class: 'row gap wrap' }, chosenSet.codes.map((c) => el('button', {
      class: `card-btn${c === code ? ' sel' : ''}${isRedSuit(c) ? ' red' : ''}`,
      onclick: () => actions.setUi({ code: c }),
    }, cardFace(c)))),

    code && el('p', { class: 'step' }, '3. Ask whom?'),
    code && el('div', { class: 'row gap wrap' }, priv.targets.map((t) => el('button', {
      class: `chip who${t.id === targetId ? ' sel' : ''}`,
      onclick: () => actions.setUi({ targetId: t.id }),
    }, `${t.name} (${t.cards})`))),

    el('button', {
      class: 'btn primary big',
      disabled: !code || !targetId,
      onclick: () => actions.send({ type: 'ask', targetId, code }),
    }, code && targetId
      ? `Ask ${priv.targets.find((t) => t.id === targetId)?.name} for ${cardLabel(code)}`
      : 'Ask'),
  );
}

function claimOpener(pub, priv, actions) {
  if (!priv.canClaim || !pub.unclaimedSets.length) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'row between' },
      el('h2', { class: 'h2' }, 'Claim a set'),
      el('span', { class: 'hint' }, priv.canClaim && !priv.isTurn ? 'allowed any time' : ''),
    ),
    el('div', { class: 'row gap wrap' }, pub.unclaimedSets.map((setId) => el('button', {
      class: 'chip set-chip',
      onclick: () => actions.openClaim(setId),
    }, setLabel(setId)))),
  );
}

/**
 * Assign every card in a set to somebody on my team.
 *
 * Cards in my own hand are filled in and locked: I know where they are, and
 * letting them be reassigned only creates a way to miscall a set by accident.
 * Everything else is a judgement, which is the actual game.
 */
function claimBuilder(app, actions) {
  const { pub, priv, ui } = app;
  const setId = ui.claimSetId;
  const codes = setCards(setId);
  const mine = new Set(priv.hand.map((c) => c.code));
  const assignment = ui.assignment || {};
  const placed = codes.filter((c) => assignment[c]).length;

  return el('section', { class: 'card builder claim' },
    el('div', { class: 'row between' },
      el('h2', { class: 'h2' }, `Claim ${setLongLabel(setId)}`),
      el('button', { class: 'btn small', onclick: () => actions.closeClaim() }, 'Cancel'),
    ),
    el('p', { class: 'hint' },
      'Name who on your team holds each card. Get it right and the set is yours; ',
      pub.config.wrongClaimAwardsOpponent
        ? 'get it wrong and it goes to the other team.'
        : 'get it wrong and nobody scores it.'),
    el('ul', { class: 'assign' }, codes.map((c) => {
      const isMine = mine.has(c);
      return el('li', { class: `assign-row${isMine ? ' locked' : ''}` },
        el('span', { class: `assign-card${isRedSuit(c) ? ' red' : ''}` }, cardFace(c)),
        el('div', { class: 'row gap wrap' },
          isMine
            ? el('span', { class: 'chip sel locked-chip' }, 'You')
            // Not in my hand, so naming myself here is not a guess, it is a
            // guaranteed miscall. Offering it would only be a way to lose a set
            // by mistapping.
            : priv.teammates.filter((t) => !t.isMe).map((t) => el('button', {
              class: `chip who${assignment[c] === t.id ? ' sel' : ''}`,
              onclick: () => actions.assign(c, t.id),
            }, `${t.name} (${t.cards})`)),
        ),
      );
    })),
    el('button', {
      class: 'btn primary big',
      disabled: placed !== codes.length,
      onclick: () => actions.send({ type: 'claim', setId, assignment }),
    }, placed === codes.length ? `Call ${setLabel(setId)}` : `${placed} of ${codes.length} placed`),
  );
}

function handView(priv) {
  const groups = new Map();
  for (const c of priv.hand) {
    if (!groups.has(c.setId)) groups.set(c.setId, []);
    groups.get(c.setId).push(c.code);
  }

  return el('section', { class: 'card hand' },
    el('div', { class: 'row between' },
      el('h2', { class: 'h2' }, 'Your hand'),
      el('span', { class: 'count' }, `${priv.hand.length} cards`),
    ),
    priv.hand.length === 0
      ? el('p', { class: 'empty' }, 'You are out of cards. Your team plays on without you.')
      : el('div', { class: 'hand-groups' },
        [...groups.entries()].map(([setId, codes]) => el('div', { class: 'hand-group' },
          el('span', { class: 'group-label' }, setLabel(setId)),
          el('div', { class: 'row gap wrap' }, codes.map((c) => el('span', {
            class: `card-face${isRedSuit(c) ? ' red' : ''}`,
          }, cardFace(c)))),
        )),
      ),
  );
}

/** The public record. Two different things live here: the questions asked, which
 *  config.showHistory can hide, and the table talk, which it never hides. */
function recordPanel(pub, app, actions) {
  const tab = app.ui.panel || 'history';
  const asks = pub.history || [];

  return el('section', { class: 'card record' },
    el('div', { class: 'tabs' },
      el('button', {
        class: `tab${tab === 'history' ? ' sel' : ''}`,
        onclick: () => actions.setUi({ panel: 'history' }),
      }, 'Questions'),
      el('button', {
        class: `tab${tab === 'log' ? ' sel' : ''}`,
        onclick: () => actions.setUi({ panel: 'log' }),
      }, 'Table'),
    ),
    tab === 'history'
      ? el('div', {},
        pub.historyHidden && el('p', { class: 'hint' },
          'The record is off this game — only the last question stays on the table.'),
        asks.length === 0
          ? el('p', { class: 'empty' }, 'Nothing asked yet.')
          : el('ul', { class: 'asks' }, [...asks].reverse().map((h) => el('li', {
            class: `ask${h.gotIt ? ' hit' : ' miss'}`,
            style: `--team:${teamColor(h.askerTeam)}`,
          },
            el('span', { class: 'ask-text' },
              el('strong', {}, h.askerName), ' asked ', el('strong', {}, h.targetName),
              ' for ', el('span', { class: isRedSuit(h.code) ? 'red' : '' }, cardLabel(h.code)),
            ),
            el('span', { class: 'ask-out' }, h.gotIt ? 'got it' : 'no'),
          ))),
      )
      : el('div', {},
        (pub.log || []).length === 0
          ? el('p', { class: 'empty' }, 'Nothing yet.')
          : el('ul', { class: 'log' }, [...pub.log].reverse().map((l) => el('li', {
            class: 'log-line',
            style: l.team === undefined || l.team === null ? '' : `--team:${teamColor(l.team)}`,
          }, l.text))),
      ),
  );
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function overScreen(app, actions) {
  const pub = app.pub;
  if (!pub) return el('div', { class: 'screen over' }, spinner());

  const isHost = app.mode === 'host';
  const iWon = !pub.drawn && pub.winner === (app.priv ? app.priv.team : -1);
  const headline = pub.drawn
    ? 'A draw.'
    : (iWon ? 'Your team wins.' : `${teamName(pub.winner)} wins.`);

  return el('div', { class: 'screen over' },
    topBar(app, actions, 'Result'),
    el('section', { class: 'card result' },
      el('h2', { class: 'headline' }, headline),
      el('div', { class: 'row gap center' },
        [0, 1].map((team) => el('div', {
          class: `score${pub.winner === team ? ' win' : ''}`,
          style: `--team:${teamColor(team)}`,
        },
          el('span', { class: 'score-team' }, teamName(team)),
          el('span', { class: 'score-value' }, String(pub.scores[team])),
        )),
      ),
      el('ul', { class: 'claim-list' }, pub.claims.map((c) => el('li', {
        class: c.team === null ? 'void' : '',
        style: c.team === null ? '' : `--team:${teamColor(c.team)}`,
      },
        el('span', { class: 'claim-set' }, setLongLabel(c.setId)),
        el('span', { class: 'claim-by' },
          c.correct
            ? `called by ${c.byName}`
            : `miscalled by ${c.byName} (${c.wrong.map(cardLabel).join(', ')})`),
      ))),
    ),
    isHost
      ? el('button', { class: 'btn primary big', onclick: () => actions.send({ type: 'newGame' }) },
        'Play again')
      : el('p', { class: 'waiting' }, 'Waiting for the host to deal again…'),
    el('button', { class: 'btn big', onclick: () => actions.leave() }, 'Leave'),
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
function topBar(app, actions, title) {
  return el('header', { class: 'topbar' },
    el('span', { class: 'brand' }, title),
    app.code && el('span', { class: 'roomtag' }, app.code),
    el('span', { class: `dot ${app.connected ? 'up' : 'down'}`, title: app.connected ? 'Connected' : 'Offline' }),
    el('button', { class: 'btn small', onclick: () => actions.leave() }, 'Leave'),
  );
}

/** Errors and status share one slot: two stacked banners on a phone push the
 *  game off the screen, and the error is always the more urgent of the two. */
function banner(app, actions) {
  if (app.error) {
    return el('div', { class: 'banner error', role: 'alert' },
      el('span', {}, app.error),
      el('button', { class: 'icon', 'aria-label': 'Dismiss', onclick: () => actions.clearError() }, '×'),
    );
  }
  if (app.status) return el('div', { class: 'banner', role: 'status' }, app.status);
  return null;
}

/** A card as rank + suit glyph, with the glyph in its own element so the suit can
 *  be coloured without colour being the only thing that distinguishes it.
 *
 *  role=img + aria-label names the card in words, which does two jobs: a bare
 *  suit glyph is read inconsistently between screen readers, and this is also
 *  what gives the enclosing button its accessible name — so a card announces as
 *  "queen of diamonds" whether it is tappable or just sitting in a hand. */
function cardFace(code) {
  return el('span', { class: 'face', role: 'img', 'aria-label': cardSpoken(code) },
    el('span', { class: 'face-rank' }, rankLabel(code)),
    el('span', { class: 'face-suit' }, suitGlyph(code)),
  );
}

function spinner() {
  return el('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
}
