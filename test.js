'use strict';

const assert = require('assert');
const G = require('./game');

const ids = (rank, suits) => suits.map(s => rank + s);

// --- combo + value rules -------------------------------------------------
assert.deepStrictEqual(G.comboOf(ids('7', ['D', 'C'])), { rank: 4, size: 2 });
assert.strictEqual(G.comboOf(['7D', '8C']), null, 'mixed ranks are not a combo');
assert.strictEqual(G.comboOf(ids('7', ['D', 'C', 'H', 'S', 'D']).slice(0, 5)), null, 'max 4');
assert.ok(G.comboOf(['2D']).rank > G.comboOf(['AD']).rank, '2 beats ace');
assert.ok(G.comboOf(['AD']).rank > G.comboOf(['KD']).rank, 'ace beats king');

// responding must match count and be >= in value
assert.deepStrictEqual(G.legalPlays([{ id: '9D', r: 6, s: 'D' }], { rank: 4, size: 2 }), []);
assert.deepStrictEqual(
  G.legalPlays([{ id: '9D', r: 6, s: 'D' }, { id: '9C', r: 6, s: 'C' }, { id: '7D', r: 4, s: 'D' }], { rank: 4, size: 2 }),
  [['9D', '9C']],
  'pair of 9s beats pair of 7s'
);
assert.deepStrictEqual(
  G.legalPlays([{ id: '6D', r: 3, s: 'D' }, { id: '6C', r: 3, s: 'C' }], { rank: 4, size: 2 }),
  [],
  'lower pair is not legal'
);
assert.deepStrictEqual(
  G.legalPlays([{ id: '7D', r: 4, s: 'D' }, { id: '7C', r: 4, s: 'C' }], { rank: 4, size: 2 }),
  [['7D', '7C']],
  'equal rank pair is allowed (leads to a close)'
);
assert.strictEqual(G.legalPlays([{ id: '7D', r: 4, s: 'D' }], null).length, 1, 'leading: any single');
assert.strictEqual(G.legalPlays([{ id: '7D', r: 4, s: 'D' }, { id: '7C', r: 4, s: 'C' }], null).length, 2, 'leading: single or pair');

// --- table setup ---------------------------------------------------------
const members = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, name: id.toUpperCase() }));
const g = G.createGame(members, 'a');
G.startRound(g, 'f');
assert.strictEqual(g.phase, 'play');
const total = g.players.reduce((n, p) => n + p.hand.length, 0);
assert.strictEqual(total, 52, 'all 52 cards dealt');
const counts = g.players.map(p => p.hand.length).sort((x, y) => x - y);
assert.deepStrictEqual(counts, [8, 8, 9, 9, 9, 9], 'dealer deals to the next player first, round-robin');
assert.strictEqual(g.discarded, 0);

const starter = g.order.find(id => G.player(g, id).hand.some(c => c.id === '3D'));
assert.strictEqual(g.order[g.turnIdx], starter, 'holder of 3D starts');

// --- scripted trick: pass-out clears to the last player ------------------
const actor = () => g.order[g.turnIdx];
function tryPlay(cardIds) {
  const r = G.play(g, actor(), cardIds);
  assert.ok(!r.err, r.err);
}
function tryPass() {
  const r = G.pass(g, actor());
  assert.ok(!r.err, r.err);
}
// leader plays something, everyone else passes
const leaderId = actor();
const lead = G.legalPlays(G.player(g, leaderId).hand, null)[0];
tryPlay(lead);
const lastPlayer = g.topPlay.player;
for (let i = 0; i < g.order.length - 1; i++) tryPass();
if (g.stack) {
  assert.strictEqual(g.stack.player, lastPlayer, 'last player gets the stack offer');
  assert.ok(!G.done(g, lastPlayer).err, 'declines');
}
assert.strictEqual(g.topPlay, null, 'trick cleared after all others passed');
assert.strictEqual(actor(), lastPlayer, 'the last player to play leads the new trick');

// --- closing: four singles of one rank end the trick ----------------------
const g2 = G.createGame(members.slice(0, 4), 'a');
g2.phase = 'play';
g2.order = ['a', 'b', 'c', 'd'];
g2.players.forEach((p, i) => { p.hand = []; p.place = null; });
g2.players[0].hand = ['7D', '2D'].map(id => ({ id, r: G.RANKS.indexOf(id.slice(0, -1)), s: id.slice(-1) }));
g2.players[1].hand = ['7C', '3D'].map(id => ({ id, r: G.RANKS.indexOf(id.slice(0, -1)), s: id.slice(-1) }));
g2.players[2].hand = ['7H'].map(id => ({ id, r: 4, s: 'H' }));
g2.players[3].hand = ['7S'].map(id => ({ id, r: 4, s: 'S' }));
g2.discarded = 0;
g2.standings = [];
g2.out = new Set();
g2.passed = new Set();
g2.streak = null;
g2.stack = null;
g2.trickLog = [];
g2.topPlay = null;
g2.turnIdx = 0;
const step = idsToPlay => {
  const r = G.play(g2, g2.order[g2.turnIdx], idsToPlay);
  assert.ok(!r.err, r.err);
};
step(['7D']);
step(['7S']); // play runs counterclockwise: a, d, c, b
step(['7H']);
step(['7C']);
assert.strictEqual(g2.topPlay, null, 'four 7s in a row closes the hand');
assert.strictEqual(g2.turnIdx, 1, 'the closer leads the next trick');

// --- bot personalities ------------------------------------------------------
const mkHand = ids => ids.map(id => ({ id, r: G.RANKS.indexOf(id.slice(0, -1)), s: id.slice(-1) }));
// chill (default): lowest single, ducks multis, never stacks
assert.deepStrictEqual(G.botMove(mkHand(['5D', '9C', '2H']), null), ['5D'], 'chill leads lowest');
assert.deepStrictEqual(G.botMove(mkHand(['5D', '9C', '2H']), { rank: 4, size: 1 }), ['9C'], 'chill answers lowest');
assert.strictEqual(G.botMove(mkHand(['5D', '9C']), { rank: 12, size: 1 }), null, 'chill passes when beaten');
assert.strictEqual(G.botMove(mkHand(['5D', '9C', '2H']), { rank: 0, size: 2 }), null, 'chill ducks pairs');
assert.strictEqual(G.botStack(mkHand(['9D', '9C']), { rank: 4, max: 2 }, 'chill'), null, 'chill declines');
// bully: highest everything, answers multis, stacks highest
assert.deepStrictEqual(G.botMove(mkHand(['5D', '9C', '2H']), null, 'bully'), ['2H'], 'bully leads highest');
assert.deepStrictEqual(G.botMove(mkHand(['5D', '9C', '9H']), { rank: 4, size: 2 }, 'bully'), ['9C', '9H'], 'bully answers pairs');
assert.deepStrictEqual(G.botStack(mkHand(['9D', 'KD', 'KC']), { rank: 4, max: 2 }, 'bully'), ['KD', 'KC'], 'bully stacks highest');
// shedder: most cards first
assert.deepStrictEqual(G.botMove(mkHand(['5D', '9C', '9H']), null, 'shedder'), ['9C', '9H'], 'shedder sheds the pair');
assert.deepStrictEqual(G.botMove(mkHand(['5D', '9C', '9H', '9S']), null, 'shedder'), ['9C', '9H', '9S'], 'shedder sheds the trio');
assert.deepStrictEqual(G.botStack(mkHand(['5D', '5C', '9D', '9C']), { rank: 0, max: 2 }, 'shedder'), ['5D', '5C'], 'shedder stacks lowest');
// saver: holds back aces and 2s
assert.deepStrictEqual(G.botMove(mkHand(['9C', 'AD', '2H']), null, 'saver'), ['9C'], 'saver spares powers');
assert.deepStrictEqual(G.botMove(mkHand(['AD', '2H']), null, 'saver'), ['AD'], 'saver plays ace when forced');
assert.strictEqual(G.botStack(mkHand(['9D', '9C']), { rank: 4, max: 2 }, 'saver'), null, 'saver declines');

// --- full random rounds: cards conserved, places complete -----------------
function randomRound(nPlayers) {
  const mem = Array.from({ length: nPlayers }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  const gg = G.createGame(mem, mem[0].id);
  G.startRound(gg, mem[nPlayers - 1].id);
  let actions = 0;
  while (gg.phase === 'play') {
    assert.ok(actions++ < 5000, 'round never ends');
    const me = G.player(gg, gg.order[gg.turnIdx]);
    const legal = G.legalPlays(me.hand, gg.topPlay);
    if (gg.stack && gg.stack.player === me.id) {
      const opts = G.stackOptions(me.hand, gg.stack.rank, gg.stack.max);
      assert.ok(opts.length, 'offer implies an option');
      if (Math.random() < 0.7) {
        const pick = opts[Math.floor(Math.random() * opts.length)];
        assert.ok(!G.stack(gg, me.id, pick).err, 'stack should be legal');
      } else {
        assert.ok(!G.done(gg, me.id).err, 'done should be legal');
      }
    } else if (gg.topPlay && (!legal.length || Math.random() < 0.5)) {
      assert.ok(!G.pass(gg, me.id).err, 'pass should be legal');
    } else if (legal.length) {
      const pick = legal[Math.floor(Math.random() * legal.length)];
      assert.ok(!G.play(gg, me.id, pick).err, 'play should be legal');
    } else {
      assert.ok(!G.pass(gg, me.id).err, 'pass fallback');
    }
    const gone = gg.players.reduce((s, p) => s + p.hand.length, 0) + gg.discarded;
    assert.strictEqual(gone, 52, 'cards never vanish');
  }
  assert.strictEqual(gg.standings.length, nPlayers, 'every player gets a place');
  assert.strictEqual(new Set(gg.standings).size, nPlayers, 'places are unique');
  return gg;
}

for (let i = 0; i < 40; i++) randomRound(4 + (i % 3));

// --- trades ---------------------------------------------------------------
const gt = randomRound(5);
const standings = [...gt.lastStandings];
const dealer = standings[standings.length - 1];
gt.lastStandings = [];
G.startRound(gt, dealer); // deal without trades, to measure the fresh hands
const before = Object.fromEntries(gt.players.map(p => [p.id, p.hand.length]));
gt.lastStandings = standings;
gt.round = 1; // same deal again, this time with the card trade
G.startRound(gt, dealer);

const first = standings[0];
const second = standings[1];
const mid = standings[2];
const secondLast = standings[3];
const last = standings[4];
assert.strictEqual(gt.phase, 'trade');
assert.strictEqual(G.player(gt, first).hand.length, before[first] + 2, '1st got 2 best cards');
assert.strictEqual(G.player(gt, last).hand.length, before[last] - 2, 'last gave 2 best cards');
assert.strictEqual(G.player(gt, second).hand.length, before[second] + 1, '2nd got 1 best card');
assert.strictEqual(G.player(gt, secondLast).hand.length, before[secondLast] - 1, '2nd-last gave 1 best card');
assert.strictEqual(G.player(gt, mid).hand.length, before[mid], 'middle player is safe');
const recv = gt.trade.received[first].map(id => G.RANKS.indexOf(id.slice(0, -1)));
const stillLast = G.player(gt, last).hand.map(c => c.r);
assert.ok(Math.max(...stillLast) <= Math.min(...recv), '1st received the two best cards from last');

// give the required cards back, round should start
for (const [pid, k] of Object.entries(gt.trade.need)) {
  const hand = G.player(gt, pid).hand;
  assert.ok(!G.give(gt, pid, hand.slice(0, k).map(c => c.id)).err, 'give should be legal');
}
assert.strictEqual(gt.phase, 'play', 'round starts after trades');
assert.strictEqual(G.player(gt, first).hand.length, before[first], '1st hand size restored');
assert.strictEqual(G.player(gt, last).hand.length, before[last], 'last hand size restored');

// --- stacking: last player tops up after everyone passes -------------------
const mk = ids => ids.map(id => ({ id, r: G.RANKS.indexOf(id.slice(0, -1)), s: id.slice(-1) }));
assert.deepStrictEqual(
  G.stackOptions(mk(['7D', '7C', '9H', '5S']), 4, 2).map(a => a.sort()),
  [['7C', '7D']].map(a => a.sort()),
  'stack options: exactly N cards, same rank or higher'
);
assert.deepStrictEqual(G.stackOptions(mk(['7D', '9H']), 4, 2), [], 'no exact pair, no offer');
assert.deepStrictEqual(G.stackOptions(mk(['5S']), 4, 2), [], 'nothing high enough, no offer');

function riggedStack(hands) {
  const gg = G.createGame(members.slice(0, 4), 'a');
  gg.phase = 'play';
  gg.order = ['a', 'b', 'c', 'd'];
  gg.players.forEach(p => { p.hand = []; p.place = null; });
  gg.players.forEach((p, i) => { p.hand = mk(hands[i]); });
  gg.discarded = 0;
  gg.standings = [];
  gg.out = new Set();
  gg.passed = new Set();
  gg.streak = null;
  gg.stack = null;
  gg.trickLog = [];
  gg.topPlay = null;
  gg.turnIdx = 0;
  return gg;
}

// a plays a pair, everyone passes (singles can't beat a pair), a stacks exactly 2 more
const g3 = riggedStack([['7D', '7C', '9D', '9C', '3C'], ['9H'], ['10D'], ['10C']]);
assert.ok(!G.play(g3, 'a', ['7D', '7C']).err);
assert.ok(!G.pass(g3, 'd').err); // counterclockwise: a, d, c, b
assert.ok(!G.pass(g3, 'c').err);
assert.ok(!G.pass(g3, 'b').err);
assert.ok(g3.stack && g3.stack.player === 'a', 'stack offered to the last player');
assert.strictEqual(g3.stack.max, 2, 'pair allows up to 2 more');
assert.strictEqual(g3.order[g3.turnIdx], 'a', 'turn returns to the stacker');
assert.strictEqual(G.view(g3, 'a').stack.max, 2, 'stack shown in view');
assert.strictEqual(G.view(g3, 'b').stack.by, 'A', 'others see who may stack');
assert.strictEqual(G.play(g3, 'a', ['3C']).err, 'Stack extra cards or end the play', 'plain play blocked during offer');
assert.strictEqual(G.pass(g3, 'a').err, 'Stack extra cards or end the play', 'plain pass blocked during offer');
assert.ok(G.stack(g3, 'a', ['3C']).err, 'too low to stack');
assert.ok(G.stack(g3, 'a', ['9D', '3C']).err, 'mixed ranks rejected');
assert.strictEqual(G.stack(g3, 'a', ['9D']).err, 'Stack exactly 2 cards', 'one card on a pair rejected');
assert.ok(!G.stack(g3, 'a', ['9D', '9C']).err, 'stack the pair of 9s');
assert.strictEqual(g3.topPlay, null, 'play ends after stacking');
assert.strictEqual(g3.order[g3.turnIdx], 'a', 'stacker leads the new trick');
assert.ok(g3.log.some(l => l.includes('stacks')), 'stack logged');
assert.deepStrictEqual(G.view(g3, 'a').log, [], 'trick log wiped when the trick ends');

// declining ends the play just the same
const g4 = riggedStack([['7D', '7C', '9D', '9C'], ['9H'], ['10D'], ['10C']]);
G.play(g4, 'a', ['7D', '7C']);
G.pass(g4, 'd'); G.pass(g4, 'c'); G.pass(g4, 'b');
assert.ok(g4.stack, 'offer up');
assert.ok(!G.done(g4, 'a').err, 'decline');
assert.strictEqual(g4.topPlay, null, 'trick cleared');
assert.strictEqual(g4.order[g4.turnIdx], 'a', 'last player leads');

// stacking into four of a kind closes the hand
const g5 = riggedStack([['7D', '7C', '7H', '7S', '3C'], ['9D'], ['9C'], ['9H']]);
G.play(g5, 'a', ['7D', '7C']);
G.pass(g5, 'd'); G.pass(g5, 'c'); G.pass(g5, 'b');
assert.ok(!G.stack(g5, 'a', ['7H', '7S']).err, 'stack two more 7s');
assert.ok(g5.log.some(l => l.includes('closed the hand')), 'completing the set closes');
assert.strictEqual(g5.order[g5.turnIdx], 'a', 'closer leads');

// stacking out ends the round when only one player is left holding cards
const g6 = riggedStack([['7D', '7C', '9D', '9C'], ['10D'], ['10C'], ['10H']]);
g6.out = new Set(['b', 'c']);
g6.standings = ['b', 'c'];
assert.ok(!G.play(g6, 'a', ['7D', '7C']).err);
assert.ok(!G.pass(g6, 'd').err);
assert.ok(g6.stack, 'offer up');
assert.ok(!G.stack(g6, 'a', ['9D', '9C']).err, 'stacks out');
assert.strictEqual(g6.phase, 'roundend', 'round ends');
assert.deepStrictEqual(g6.standings, ['b', 'c', 'a', 'd'], 'places in order');

// no offer when the last player went out with the play
const g7 = riggedStack([['7D', '7C'], ['9D', '9C'], ['9H', '10H'], ['10D', '10C']]);
assert.ok(!G.play(g7, 'a', ['7D', '7C']).err, 'a goes out');
assert.ok(!G.pass(g7, 'd').err);
assert.ok(!G.pass(g7, 'c').err);
assert.ok(!G.pass(g7, 'b').err);
assert.strictEqual(g7.stack, null, 'no offer with an empty hand');
assert.strictEqual(g7.topPlay, null, 'trick cleared to the next player with cards');

console.log('all tests passed');
