# Literature — Collect the Half-Suits

A complete, **static** web implementation of *Literature* — the hidden-hand card
game also played as **Fish**, **Canadian Fish** or **Literature Fish**. One
player hosts from their own browser tab; everyone else joins with a 4-character
code — easiest when everyone is on the same Wi-Fi, though it isn't required. All
game logic and authoritative state live in the host's tab — **no game server, no
accounts** — and every player plays on their own device, so **your hand stays
yours**. Installable as a PWA that works offline (app shell).

Point it at a self-hosted server and the same game runs over the internet
instead, with nobody's tab holding it up. That is **additive**: the server is one
URL in [`js/config.js`](js/config.js), the app probes it before offering
anything, and with no server configured — or with the server switched off — this
is exactly the peer-to-peer game described above. See
[**Playing over the internet**](#playing-over-the-internet-optional-server).

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

## Playing over the internet (optional server)

Hosting from a tab has two limits no amount of client code can fix: a direct
connection between two devices sometimes cannot be made at all, and the game
lives in the host's browser, so closing it stops everything. The optional server
removes both. It is a small Node process — four files, one dependency (`ws`) —
that keeps rooms in memory and **imports the browser's own engine, guards and
bots**, so it is the same rules, the same house-rule switches and the same bot
brain, just applied on a machine nobody has to keep awake.

### How the app decides which one to use

1. At boot the app probes the server once, with a 4-second timeout. Nothing
   server-shaped is drawn until that answers.
2. If it answers, the home screen grows a **Host online** button, and any open
   lobbies appear under **Games online**.
3. If it doesn't — no server configured, server switched off, no internet — the
   app says so in one line and behaves exactly as it always did.
4. **Join** is one button for both kinds of game. A typed code is tried on the
   server first when the server is up, and a code the server has never heard of
   falls through to a peer-to-peer join on the same code. Players never have to
   know which sort of game they were invited to.

### What changes when the server is running the game

- **Nobody is the host.** The player who opened the table still gets the lobby
  controls and **Play again** — they are the one the engine calls `hostId` — but
  no browser holds the engine, so their closing the tab ends nothing. They rejoin
  and their hand is still there.
- **Identity is the device, not the name.** Each browser mints a random
  `clientId` on first run and keeps it in `localStorage`, and that is what
  reclaims a seat mid-game. It never appears in the URL or on screen. The server
  enforces it in its own seat map, outside the shared engine.
- **Bots and empty chairs keep playing with the tab shut.** This is the one place
  the transport changes the *game* rather than just who is holding it. A bot moves
  when the machine running the game ticks, and hosting from a tab that machine is
  somebody's phone — lock it and the table stops. It matters more in Literature
  than in most games, because **a hit keeps the turn**: a player who walks away
  mid-run doesn't cost the table one beat, they stop it dead. So an unattended
  seat is played for after a while, by the same bot code — after 8 seconds when a
  browser is hosting, after 30 on the server (`AWAY_MS`), because a phone in the
  same room gets the benefit of "hang on, my screen locked" and a stranger three
  cities away does not. **If you are seating bots, host online if you can.**
- **The turn clock keeps running too**, for the same reason, if the host has
  switched it on.
- **Rooms expire.** Six hours idle, or 15 minutes with nobody in them. Nothing is
  ever written to disk — a restart is a clean slate.
- **A drop looks like a reconnect.** Losing the socket keeps the table on screen
  behind a *Lost the server — getting back in* banner and retries for ~30s, just
  like losing a peer host. A redeploy therefore looks like a blip, not an ending.

### Turning it off

Blank `HOST` in [`js/config.js`](js/config.js). Every server control is gated on
that file naming an endpoint *and* on the live health probe, so the app goes back
to being a static peer-to-peer site with no backend — which is also what it does
on a plane.

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers the SW)
manifest.webmanifest    PWA manifest (relative paths, for /repo/ subpaths)
sw.js                   service worker — precaches the shell, then stale-while-
                          revalidate (bump CACHE when imports change; never
                          caches /health, so a dead server can't look alive)
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
  botdriver.js          the paced driver around bots.js — whose turn, how long to
                          pause, and the away-seat rule. Shared by the browser
                          host and the server, so a bot plays identically on both
  net.js                PeerJS transport (BROKER_CONFIG at the top), broker
                          recovery, per-connection rate limiting — and the
                          WebSocket transport + the liveness and room probes
  config.js             ← the server-mode switch: blank the host and server mode
                          does not exist
  ui.js                 rendering (pure view layer — never mutates app state)
  util.js               helpers (room code, clipboard, persistence, clientId, DOM)
  main.js               controller wiring net + engine + bots + UI together
server/                 the OPTIONAL authoritative server (nothing else needs it)
  index.js              HTTP endpoints + WebSocket bootstrap — the only file that
                          imports `ws`, which is what keeps npm test install-free
  guards.js             thin re-export of js/guards.js, plus the origin allowlist
  rooms.js              room registry, codes, ceilings, expiry, the operator log
  session.js            seats, clientId identity and mid-game reclaim
  Dockerfile            arm64 image — build from the REPO ROOT, it needs js/
  compose.yaml          deployment stack for the Pi (no ports: on purpose)
  package.json          the server's one dependency
icons/                  app icons (svg source + generated png)
scripts/
  gen-icons.js          regenerates the PNG icons (node, no deps)
  test-engine.mjs       headless tests — the engine end to end: seating, the
                          deal, asking, claiming, the clock, draws, restore,
                          and that hands stay hidden
  test-bots.mjs         headless tests — bot inference and 30 seeded full games,
                          plus the intent dispatcher and the frame guards
  test-server.mjs       headless tests — the wire protocol, the security guards,
                          reclaim, the away-seat rule, and whole games played
                          through Session.handleFrame() over a stub socket
.github/workflows/
  ci.yml                runs npm test on every push
  server.yml            tests, then builds and pushes the arm64 server image
package.json            npm test / npm run icons (no dependencies)
```

## Tests

```
npm test            # test-engine.mjs && test-bots.mjs && test-server.mjs
```

No framework and no install: a couple of assertion helpers and a seeded LCG
standing in for `crypto.getRandomValues`, so a deal is reproducible and a failure
is a fixed sequence of moves rather than a story about one. `test-bots.mjs` plays
30 complete games and checks that no *provable* claim was ever wrong, that no
deduction ever contradicted a real hand, that no game deadlocked, and that
`js/bots.js` still imports nothing but `js/cards.js`. `test-server.mjs` drives the
server through a stub WebSocket — no listening port, no `ws` — and asserts the
things a public endpoint has to get right: the origin allowlist, the rate limit,
that a seat is reclaimed by `clientId` and never by name, and that no frame
addressed to one player ever contains another player's cards.

---

*Literature* / *Fish* is a traditional card game with no single owner. This is a
non-commercial implementation for playing with friends.
