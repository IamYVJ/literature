# Literature — Collect the Half-Suits

A complete, **static** web implementation of *Literature* — the hidden-hand card
game also played as **Fish**, **Canadian Fish** or **Literature Fish**. One
player hosts from their own browser tab; everyone else joins with a 4-character
code — easiest when everyone is on the same Wi-Fi, though it isn't required. All
game logic and authoritative state live in the host's tab — **no game server, no
accounts** — and every player plays on their own device, so **your hand stays
yours**. Installable as a PWA that works offline (app shell).

Short of a table? **Bots** fill the empty seats and play a real game: they track
the public record of asks, deduce what they can prove, and gamble when proof runs
out. A solo game against five bots needs nobody else at all.

## How to play

The deck is the standard 52 minus the four 8s — **48 cards in 8 sets of 6**. A
*set* is a **half-suit**: the low half (2–7) or the high half (9,10,J,Q,K,A) of
one suit. The table splits into **two teams**, seated alternately so your
neighbours are always opponents.

On your turn you **ask one opponent for one specific card**:

- You must already **hold at least one card of that set** — so every question you
  ask tells the table something about your hand, which is the game.
- You may not ask for a card you already hold, and you may not ask a teammate.
- **They have it:** they hand it over and **you ask again**. A good turn can run
  for a long time.
- **They don't:** the turn passes to **them**. A miss is not a penalty so much as
  a transfer — and everyone just learned that they don't hold it.

When your team holds all six cards of a set, **claim** it: name which teammate
holds each card. Right, and the set is yours. Wrong, and it goes to the other
team — so a claim on a hunch is a real gamble. Claimed cards leave the game.

**A majority of the sets wins** — 5 of 8. With an even number of sets a draw is
possible, which is what the *eights* house rule below exists to prevent.

Details the app handles for you:

- **The record is public.** Every ask and its answer are written down for
  everyone, because at a real table everyone hears the question. The host can
  turn the log off for a memory game (see below) — and when they do, it is hidden
  from *everybody*, including the bots.
- **Card counts are public; cards are not.** You always see how many cards each
  player holds, which is what makes counting-based deduction possible.
- **Running out of cards doesn't eliminate you.** Your team plays on without you,
  and you can still be named in a claim — you just hold nothing to be asked for.
  Turn order skips empty hands.
- **You can always do something.** If you have no legal ask at all — nobody left
  to ask, or you hold every set you hold in full — the app says **you must
  claim**, and that is always possible: both situations mean your team
  demonstrably holds a complete set.
- **Claiming is an interrupt.** By default you may claim the moment you can prove
  it, even on someone else's turn — because at a real table you would.

## Game modes

The host sets the rules in the lobby, before the deal. Every player sees the
choices as they are made, so nobody has to remember which switches were flipped.

Five **presets** set several rules at once:

| Preset | What it is |
| ------ | ---------- |
| **Standard 6** | Six players, 8 sets, the game as usually played. |
| **No draws (9 sets)** | Six players with the 8s in as a ninth set — 5 of 9 wins, so a draw is impossible. |
| **Four players** | Four players, 8s included (52 divides evenly by 4). |
| **Eight players** | Eight players, 6 cards each. |
| **From memory** | Hides the ask log and puts every turn on a 45-second clock. |

The individual rules underneath:

| Rule | Default | What it changes |
| ---- | ------- | --------------- |
| **Players** | 6 | 4, 6 or 8 — the counts that divide 48 evenly. |
| **8s as a ninth set** | Off | On keeps the four 8s in, making a 52-card deck and 9 sets, so **a draw becomes impossible**. At 6 or 8 players 52 doesn't divide evenly, so four seats get one extra card — dealt so that the *teams* stay level even though the hands don't. |
| **Must hold the set to ask** | On | Off lets you ask for anything, which deletes almost all of the deduction. There for a silly game. |
| **Claim at any time** | On | Off restricts claiming to your own turn. |
| **Wrong claim awards opponent** | On | Off voids the set instead — nobody scores it, which can force a draw. |
| **Turn timer** | Off | Seconds per ask, up to 300. Let it run out and the turn passes to your left. |
| **Show the ask log** | On | Off is the in-person game: remember it yourself. Brutal, and the bots are held to it too. |

## The play screen

A phone can't show eight hands' worth of context at once, so the two things you
need *continuously* are pinned and never scroll away: a bar across the top with
whose turn it is, the countdown if the game is timed, and the score; your own
hand and the turn action docked at the bottom. Your hand is **grouped by set**,
because that is the unit you reason in — six cards of one half-suit is a claim,
and three is a question worth asking.

Asking is three taps — **which set, which card, ask whom** — so an illegal
question is unreachable rather than rejected. Claiming opens a panel with the six
cards listed; the ones **in your own hand are filled in and locked**, since those
are not in doubt, and you assign the rest to teammates.

Below that sits the public record, on two tabs: **Questions** (every ask and its
answer, newest first) and **Table** (the running log — deals, claims, timeouts).
When the host has hidden the log, the Questions tab says so instead of quietly
being empty.

Suit colour is never the only signal: a card always shows its **rank and its suit
glyph**, and every card names itself in words to a screen reader ("queen of
diamonds"), so red/black is decoration rather than information.

## Bots

Add a bot to any empty seat in the lobby. Bots run in the host's tab and play
through exactly the same intent dispatcher as a human — they have no privileged
access to anything, and [`js/bots.js`](js/bots.js) imports **only**
[`js/cards.js`](js/cards.js), so a bot structurally *cannot* reach the engine and
peek. The test suite greps the module's own source to keep it that way.

What a bot actually knows is what it heard. From the public record it maintains,
per card, the set of players who could still be holding it:

- An ask **proves the asker holds** something in that set, and **proves the
  target does not hold that card** (on a miss) or **did** (on a hit).
- Then it runs a fixpoint over two rules — *only one player can still hold this
  card*, and *this player's remaining unknowns exactly fill their hand size* —
  which is enough to turn "someone on my team has it" into a provable claim
  surprisingly often.

It claims immediately when it can prove a set, asks the question most likely to
land otherwise, and when **no** question can teach it anything, it gambles on its
best set rather than stalling. That last case matters: bot moves are a pure
function of what they know, so two bots with nothing left to ask will re-ask the
same dead question forever. `scripts/test-bots.mjs` asserts that the gamble path
is still being exercised, precisely so that deadlock can't come back unnoticed.

## Hosting & joining

1. The **host** opens the site, enters a name, and taps **Host a game**. A
   4-character room code appears — share it with the table.
2. **Players** open the same site, enter a name, type the code, and tap **Join**.
3. Fill any empty seats with **Add bot**, then the host taps **Start game**.

> Everyone must be reaching the same URL — share the link, not a screenshot of
> the code.

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers the SW)
manifest.webmanifest    PWA manifest (relative paths, for /repo/ subpaths)
sw.js                   service worker — precaches the shell, then stale-while-
                          revalidate (bump CACHE when imports change)
css/styles.css          dark reading-room theme (brass on ink, card-stock cards)
js/
  cards.js              ← the deck: half-suit sets, card codes, labels, grouping.
                          Imports nothing.
  rules.js              ← ALL rule constants and house-rule defaults, limits and
                          presets + pure logic (legal asks, claim checking)
  state.js              host-authoritative game engine / state machine, and the
                          public/private split that keeps hands hidden
  intents.js            ← the one intent dispatcher, so a move from a peer and a
                          move from a bot take the same path
  guards.js             ← the bounds on anything from another device (rate limit,
                          frame shape, id and config-patch validation).
                          Imports nothing, so plain `node` can test it.
  bots.js               ← bot inference and move choice. Imports ONLY cards.js,
                          so a bot cannot reach the engine
  net.js                PeerJS transport (BROKER_CONFIG at the top), broker
                          recovery, per-connection rate limiting
  ui.js                 rendering (pure view layer — never mutates app state)
  util.js               helpers (room code, clipboard, persistence, clientId, DOM)
  main.js               controller wiring net + engine + bots + UI together
icons/                  app icons (svg source + generated png)
scripts/
  gen-icons.js          regenerates the PNG icons (node, no deps)
  test-engine.mjs       headless tests — the engine end to end: seating, the
                          deal, asking, claiming, the clock, draws, restore,
                          and that hands stay hidden
  test-bots.mjs         headless tests — bot inference and 30 seeded full games,
                          plus the intent dispatcher and the frame guards
.github/workflows/
  ci.yml                runs npm test on every push
package.json            npm test / npm run icons (no dependencies)
```

## Tests

```
npm test            # scripts/test-engine.mjs && scripts/test-bots.mjs
```

No framework and no install: a couple of assertion helpers and a seeded LCG
standing in for `crypto.getRandomValues`, so a deal is reproducible and a failure
is a fixed sequence of moves rather than a story about one. `test-bots.mjs` plays
30 complete games and checks that no *provable* claim was ever wrong, that no
deduction ever contradicted a real hand, that no game deadlocked, and that
`js/bots.js` still imports nothing but `js/cards.js`.

---

*Literature* / *Fish* is a traditional card game with no single owner. This is a
non-commercial implementation for playing with friends.
