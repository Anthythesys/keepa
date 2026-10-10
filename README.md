# Keepa

4–6 player shedding card game for the browser — a hybrid of **Big Two** (3 of diamonds starts, 3→K→A→2, singles/pairs/trios/quads) and **President** (the round-end card tax), plus a house **close** rule.

> **Status: alpha.** The full round loop works end to end and is playable with people or bots, but it is pre-release: expect bugs, balance that will still move, and features listed under [Roadmap](#roadmap) that may change or be dropped. Rules below are the intended design, not a stability guarantee.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # rules + server integration (kick, disconnect grace)
```

Open the link, one player hits **Create a table**, the others join with the 4-letter code. Host starts with 4–6 players. Everything happens live over WebSockets; refreshing rejoins you (same name + code).

**Bots** — the host can press *Add bot* in the lobby (and × to remove one) to fill seats up to 6. Added bots cycle through four personalities: 😌 **Chill** (lowest single, ducks pairs+, never stacks), 😤 **Bully** (highest card, answers multis, always stacks), 🃏 **Shedder** (dumps the biggest combo first), 🦉 **Saver** (like Chill but holds back aces and 2s until forced).

**Menu, kick, reconnects** — *Menu* (top bar, asks first) abandons the game back to the home screen. In game, the host can kick a player with the × on their seat (asks first); a bot takes their seat immediately and the kicked player can't rejoin that room. If anyone's connection drops mid-round they have 60 seconds to come back (same name + code); after that a bot takes over, and returning later puts them straight back in the bot's seat.

## Rules as implemented

- **Deck** — all 52 cards, dealt one at a time counterclockwise starting with the player after the dealer, so hands differ by one card. The dealer is the last place from the previous round (random for round 1).
- **Values** — `3 4 5 6 7 8 9 10 J Q K A 2`, with `2` highest and ace second.
- **Start** — the holder of the **3 of diamonds** leads the round with any legal play.
- **Turns** — counterclockwise. You must play the **same number of cards** as the previous play (single beats single, pair beats pair) and a rank that is **equal or higher**. Otherwise pass.
- **Passing** — once you pass you are out of that trick until everyone else has passed. The last player to play then leads a fresh trick. You cannot pass while leading.
- **Combos** — 1 to 4 cards, all of the same rank.
- **Closing** — if all four cards of a rank hit the table one after another (four singles, two pairs, or a quad), the trick ends immediately and the player who closed it leads.
- **Stacking** — when everyone else passes, the last player to play may stack exactly N more cards on the pile (N = size of the last play: 1 for a single, 2 for a pair, 3 for a trio), as long as they form one combo of the same rank or higher. Then the play ends and the stacker leads a fresh trick. Stacking into all four of a rank counts as closing. No valid stack in hand (or an empty hand) skips the offer. Bots always decline.
- **Places** — first player with an empty hand wins the round; the last player still holding cards is last. Rounds keep going and a running score (sum of placements, lower is better) is kept.
- **Card trade** (before the next round, after dealing): 1st place takes the **two best** cards from last place and hands back two cards of his choosing; 2nd place takes the **best** card from 2nd-to-last and hands back one card. Everyone in the middle is safe.

## Files

- `game.js` — all rules, no I/O (including `botMove`, the bot policy).
- `server.js` — static file serving + WebSocket rooms (create/join with a 4-letter code) + the bot driver. `GRACE_MS` env sets the disconnect grace (60 s default).
- `public/index.html` — the whole client: polygon table (square/pentagon/hexagon for 4/5/6 seats, you always at the bottom), seat chips at the vertices, played cards in the middle, CSS animations (card select lift, deal-in on fresh plays and gained cards, bouncing trophy + pulsing winner seat), and WebAudio synth sounds (turn ping, suit-pitched play pops — ♦ high, ♥ higher, ♣ mid, ♠ low — stack rise, close fanfare, win jingle, trade swoosh, soft background pad with a new progression each round) with a 🔊/🔇 header toggle persisted in localStorage. Honors `prefers-reduced-motion`.
- `test.js` — rule checks, bot policy, trick/closing/stacking behaviour, 40 random full rounds, card accounting, trade math.
- `integration.js` — live-server tests: host-only kick, kicked rejoin refused, disconnect grace, bot replacement, seat recovery.

## Roadmap

Not built yet: turn timers, mid-game score export, spectating, smarter bots.

Alpha scope — these are open questions rather than commitments. The rules are playable and the game is fun enough to sit at a table with, which is as far as it goes for now.
