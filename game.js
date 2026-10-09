'use strict';

// Keepa — Big Two + President hybrid.
// Value order: 3 4 5 6 7 8 9 10 J Q K A 2 (2 highest, ace second).

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const RANK_NAMES = { J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
const SUITS = ['D', 'C', 'H', 'S'];
const SUIT_SYM = { D: '♦', C: '♣', H: '♥', S: '♠' };
const RED = new Set(['D', 'H']);
const THREE_D = '3D';

const rankOf = id => RANKS.indexOf(id.slice(0, -1));
const suitOf = id => id.slice(-1);
const cardLabel = id => id.slice(0, -1) + SUIT_SYM[suitOf(id)];
const isRed = id => RED.has(suitOf(id));
const rankText = r => RANK_NAMES[RANKS[r]] || RANKS[r];
const plural = r => rankText(r) + 's';

function newDeck() {
  const d = [];
  for (let r = 0; r < RANKS.length; r++)
    for (const s of SUITS) d.push({ id: RANKS[r] + s, r, s });
  return d;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortHand(h) {
  h.sort((a, b) => a.r - b.r || SUITS.indexOf(a.s) - SUITS.indexOf(b.s));
}

// cards must all share one rank, 1-4 of them
function comboOf(ids) {
  if (!ids.length || ids.length > 4) return null;
  const r = rankOf(ids[0]);
  if (ids.some(id => rankOf(id) !== r)) return null;
  return { rank: r, size: ids.length };
}

function describe(ids) {
  const c = comboOf(ids);
  if (!c) return ids.map(cardLabel).join(' ');
  if (c.size === 1) return cardLabel(ids[0]);
  const head = ['', '', 'pair of ', 'trio of ', 'four '][c.size];
  return head + plural(c.rank);
}

// top = {rank, size} or null
function legalPlays(hand, top) {
  const groups = new Map();
  for (const c of hand) {
    if (!groups.has(c.r)) groups.set(c.r, []);
    groups.get(c.r).push(c.id);
  }
  const out = [];
  for (const [r, ids] of groups) {
    const max = Math.min(4, ids.length);
    if (top) {
      if (r < top.rank || max < top.size) continue;
      out.push(ids.slice(0, top.size));
    } else {
      for (let n = 1; n <= max; n++) out.push(ids.slice(0, n));
    }
  }
  return out;
}

// exactly max cards, all one rank, rank >= base — the stack choices
function stackOptions(hand, baseRank, max) {
  const groups = new Map();
  for (const c of hand) {
    if (c.r < baseRank) continue;
    if (!groups.has(c.r)) groups.set(c.r, []);
    groups.get(c.r).push(c.id);
  }
  const out = [];
  for (const ids of groups.values())
    if (ids.length >= max) out.push(ids.slice(0, max));
  return out;
}

// Bot personalities:
// chill   — lowest single, ducks pairs+, never stacks (the original bot)
// bully   — highest legal card, answers multis, always stacks highest
// shedder — sheds the most cards first (quads > trios > pairs), stacks lowest
// saver   — like chill but holds back aces and 2s until forced
const PERSONALITIES = ['chill', 'bully', 'shedder', 'saver'];
const byRankAsc = (a, b) => rankOf(a[0]) - rankOf(b[0]);

function botMove(hand, top, person) {
  const opts = legalPlays(hand, top);
  if (!opts.length) return null;
  if (person === 'bully') {
    return opts.slice().sort((a, b) => rankOf(b[0]) - rankOf(a[0]) || b.length - a.length)[0];
  }
  if (person === 'shedder') {
    return opts.slice().sort((a, b) => b.length - a.length || byRankAsc(a, b))[0];
  }
  const singles = opts.filter(p => p.length === 1);
  if (person === 'saver') {
    const modest = singles.filter(p => rankOf(p[0]) < RANKS.indexOf('A'));
    if (modest.length) return modest.slice().sort(byRankAsc)[0];
  }
  if (!singles.length) return null;
  return singles.slice().sort(byRankAsc)[0];
}

// Returns the stack to play, or null to end the play.
function botStack(hand, offer, person) {
  if (person !== 'bully' && person !== 'shedder') return null;
  const opts = stackOptions(hand, offer.rank, offer.max);
  if (!opts.length) return null;
  const sorted = opts.slice().sort(byRankAsc);
  return person === 'bully' ? sorted[sorted.length - 1] : sorted[0];
}

function createGame(members, hostId) {
  return {
    phase: 'lobby',
    host: hostId,
    order: members.map(m => m.id),
    players: members.map(m => ({ id: m.id, name: m.name, hand: [], place: null, bot: !!m.bot, person: m.person || null })),
    round: 0,
    dealer: null,
    log: [],
    trickLog: [],
    scores: {},
    lastStandings: [],
    standings: [],
    trade: null,
    turnIdx: 0,
    topPlay: null,
    stack: null,
    passed: new Set(),
    out: new Set(),
    streak: null,
    discarded: 0,
  };
}

const player = (g, id) => g.players.find(p => p.id === id);
const nameOf = (g, id) => (player(g, id) || { name: '?' }).name;
const hasCards = (g, id) => {
  const p = player(g, id);
  return p && p.hand.length > 0;
};

function say(g, msg) {
  g.log.push(msg);
  if (g.log.length > 60) g.log.shift();
}

// trick-scoped: shown in the log box, wiped when the trick ends
function tSay(g, msg) {
  say(g, msg);
  g.trickLog.push(msg);
  if (g.trickLog.length > 60) g.trickLog.shift();
}

// The loser deals; dealing starts with the player after the dealer (counterclockwise).
function startRound(g, dealerId) {
  g.round++;
  g.dealer = dealerId;
  g.standings = [];
  g.log = [];
  g.trickLog = [];
  g.trade = null;
  g.out = new Set();
  g.passed = new Set();
  g.topPlay = null;
  g.stack = null;
  g.streak = null;
  for (const p of g.players) {
    p.hand = [];
    p.place = null;
  }
  const deck = shuffle(newDeck());
  const n = g.order.length;
  let i = g.order.indexOf(dealerId);
  if (i < 0) i = 0;
  for (const card of deck) {
    i = (i - 1 + n) % n;
    player(g, g.order[i]).hand.push(card);
  }
  for (const p of g.players) sortHand(p.hand);
  say(g, `Round ${g.round} — ${nameOf(g, dealerId)} deals, 52 cards out.`);
  if (g.round > 1 && g.lastStandings.length >= 4) applyTrades(g);
  else beginPlay(g);
}

function bestCards(hand, k) {
  return [...hand].sort((a, b) => b.r - a.r || SUITS.indexOf(b.s) - SUITS.indexOf(a.s)).slice(0, k);
}

function take(g, takerId, giverId, k) {
  const taker = player(g, takerId);
  const giver = player(g, giverId);
  const cards = bestCards(giver.hand, Math.min(k, giver.hand.length));
  const ids = new Set(cards.map(c => c.id));
  giver.hand = giver.hand.filter(c => !ids.has(c.id));
  taker.hand.push(...cards);
  sortHand(taker.hand);
  return cards.map(c => c.id);
}

// 1st <-> last: 2 cards. 2nd <-> 2nd-last: 1 card. Middle players are safe.
function applyTrades(g) {
  const s = g.lastStandings;
  const n = g.order.length;
  const deals = [
    [s[0], s[n - 1], 2],
    [s[1], s[n - 2], 1],
  ];
  const need = {};
  const received = {};
  const other = {};
  for (const [taker, giver, k] of deals) {
    if (taker === giver) continue;
    const ids = take(g, taker, giver, k);
    need[taker] = k;
    received[taker] = ids;
    other[taker] = giver;
    say(g, `${nameOf(g, taker)} takes the ${k === 2 ? 'two best' : 'best'} card${k > 1 ? 's' : ''} from ${nameOf(g, giver)}.`);
  }
  if (!Object.keys(need).length) return beginPlay(g);
  g.trade = { need, received, other };
  g.phase = 'trade';
}

function give(g, pid, ids) {
  if (g.phase !== 'trade') return { err: 'Not trading right now' };
  const t = g.trade;
  if (!t || t.need[pid] == null) return { err: 'Nothing for you to give' };
  if (ids.length !== t.need[pid]) return { err: `You must choose exactly ${t.need[pid]} card${t.need[pid] > 1 ? 's' : ''}` };
  if (ids.some(id => typeof id !== 'string')) return { err: 'Bad cards' };
  if (new Set(ids).size !== ids.length) return { err: 'Duplicate cards' };
  const p = player(g, pid);
  if (ids.some(id => !p.hand.some(c => c.id === id))) return { err: 'Card not in hand' };
  const otherId = t.other[pid];
  const other = player(g, otherId);
  p.hand = p.hand.filter(c => !ids.includes(c.id));
  other.hand.push(...ids.map(id => ({ id, r: rankOf(id), s: suitOf(id) })));
  sortHand(other.hand);
  delete t.need[pid];
  say(g, `${p.name} hands ${ids.length} card${ids.length > 1 ? 's' : ''} back to ${other.name}.`);
  if (!Object.keys(t.need).length) {
    g.trade = null;
    beginPlay(g);
  }
  return { ok: true };
}

function beginPlay(g) {
  const starter = g.order.find(id => player(g, id).hand.some(c => c.id === THREE_D)) || g.order[0];
  g.turnIdx = g.order.indexOf(starter);
  g.topPlay = null;
  g.stack = null;
  g.trickLog = [];
  g.streak = null;
  g.phase = 'play';
  say(g, `${nameOf(g, starter)} holds 3♦ and starts.`);
}

function nextWithCards(g, fromIdx) {
  const n = g.order.length;
  for (let k = 1; k <= n; k++) {
    const idx = ((fromIdx - k) % n + n) % n;
    if (hasCards(g, g.order[idx])) return idx;
  }
  return -1;
}

function endTrick(g) {
  const owner = g.topPlay.player;
  g.topPlay = null;
  g.stack = null;
  g.trickLog = [];
  g.streak = null;
  g.passed = new Set();
  let idx = g.order.indexOf(owner);
  if (!hasCards(g, owner)) idx = nextWithCards(g, idx);
  g.turnIdx = idx;
}

function advance(g) {
  const n = g.order.length;
  if (!g.topPlay) return; // leader's turn, unchanged
  for (let k = 1; k <= n; k++) {
    const idx = ((g.turnIdx - k) % n + n) % n;
    const id = g.order[idx];
    if (g.out.has(id) || g.passed.has(id)) continue;
    if (g.topPlay.player === id) continue; // everyone else passed
    g.turnIdx = idx;
    return;
  }
  // everyone passed: the last player may stack up to N more cards
  // (N = size of the last play) of the same rank or higher, then leads
  const owner = g.topPlay.player;
  const p = player(g, owner);
  if (p.hand.length && stackOptions(p.hand, g.topPlay.rank, g.topPlay.size).length) {
    g.stack = { player: owner, rank: g.topPlay.rank, max: g.topPlay.size };
    g.turnIdx = g.order.indexOf(owner);
    tSay(g, `${p.name} may stack ${g.topPlay.size} more card${g.topPlay.size > 1 ? 's' : ''} (${rankText(g.topPlay.rank)} or higher) or end the play.`);
    return;
  }
  endTrick(g);
}

function currentTurn(g) {
  return g.phase === 'play' || g.phase === 'roundend' ? g.order[g.turnIdx] : null;
}

function stack(g, pid, ids) {
  if (g.phase !== 'play') return { err: 'Round is not running' };
  if (currentTurn(g) !== pid) return { err: 'Not your turn' };
  const offer = g.stack;
  if (!offer || offer.player !== pid) return { err: 'No stack on offer' };
  if (ids.length !== offer.max) return { err: `Stack exactly ${offer.max} card${offer.max > 1 ? 's' : ''}` };
  if (ids.some(id => typeof id !== 'string')) return { err: 'Bad cards' };
  if (new Set(ids).size !== ids.length) return { err: 'Duplicate cards' };
  const p = player(g, pid);
  if (ids.some(id => !p.hand.some(c => c.id === id))) return { err: 'Card not in hand' };
  const combo = comboOf(ids);
  if (!combo) return { err: 'Stacked cards must all be the same rank' };
  if (combo.rank < offer.rank) return { err: `${describe(ids)} is too low to stack on ${plural(offer.rank)}` };

  p.hand = p.hand.filter(c => !ids.includes(c.id));
  g.discarded += ids.length;
  g.topPlay.cards.push(...ids.map(id => ({ id, r: rankOf(id), s: suitOf(id) })));
  g.topPlay.size += ids.length;
  g.streak = {
    rank: combo.rank,
    count: (g.streak && g.streak.rank === combo.rank ? g.streak.count : 0) + combo.size,
  };
  tSay(g, `${p.name} stacks ${describe(ids)}.`);
  const closed = g.streak.count === 4;
  if (closed) tSay(g, `All four ${plural(combo.rank)} are down — ${p.name} closed the hand and leads!`);

  if (p.hand.length === 0) {
    g.out.add(pid);
    g.standings.push(pid);
    p.place = g.standings.length;
    tSay(g, `${p.name} is out — place ${p.place}.`);
  }
  if (g.out.size >= g.order.length - 1) {
    endRound(g);
    return { ok: true };
  }
  endTrick(g);
  return { ok: true };
}

function done(g, pid) {
  if (g.phase !== 'play') return { err: 'Round is not running' };
  if (currentTurn(g) !== pid) return { err: 'Not your turn' };
  if (!g.stack || g.stack.player !== pid) return { err: 'Nothing to end' };
  tSay(g, `${nameOf(g, pid)} ends the play.`);
  endTrick(g);
  return { ok: true };
}

function play(g, pid, ids) {
  if (g.phase !== 'play') return { err: 'Round is not running' };
  if (currentTurn(g) !== pid) return { err: 'Not your turn' };
  if (g.stack) return { err: 'Stack extra cards or end the play' };
  if (!ids.length) return { err: 'Pick some cards' };
  if (ids.some(id => typeof id !== 'string')) return { err: 'Bad cards' };
  if (new Set(ids).size !== ids.length) return { err: 'Duplicate cards' };
  const p = player(g, pid);
  if (ids.some(id => !p.hand.some(c => c.id === id))) return { err: 'Card not in hand' };
  const combo = comboOf(ids);
  if (!combo) return { err: 'Cards must all be the same rank' };
  const top = g.topPlay;
  if (top) {
    if (combo.size !== top.size) return { err: `Play ${top.size} card${top.size > 1 ? 's' : ''} to beat ${describe(top.cards.map(c => c.id))}` };
    if (combo.rank < top.rank) return { err: `${describe(ids)} is too low` };
  }

  p.hand = p.hand.filter(c => !ids.includes(c.id));
  g.discarded += ids.length;
  g.streak = g.streak && g.streak.rank === combo.rank
    ? { rank: combo.rank, count: g.streak.count + combo.size }
    : { rank: combo.rank, count: combo.size };
  g.topPlay = { player: pid, cards: ids.map(id => ({ id, r: rankOf(id), s: suitOf(id) })), rank: combo.rank, size: combo.size };
  g.passed.delete(pid);
  tSay(g, `${p.name} plays ${describe(ids)}.`);

  const closed = g.streak.count === 4;
  if (closed) tSay(g, `All four ${plural(combo.rank)} are down — ${p.name} closed the hand and leads!`);

  if (p.hand.length === 0) {
    g.out.add(pid);
    g.standings.push(pid);
    p.place = g.standings.length;
    tSay(g, `${p.name} is out — place ${p.place}.`);
  }
  if (g.out.size >= g.order.length - 1) {
    endRound(g);
    return { ok: true };
  }
  if (closed) endTrick(g);
  else advance(g);
  return { ok: true };
}

function pass(g, pid) {
  if (g.phase !== 'play') return { err: 'Round is not running' };
  if (currentTurn(g) !== pid) return { err: 'Not your turn' };
  if (g.stack) return { err: 'Stack extra cards or end the play' };
  if (!g.topPlay) return { err: 'You are leading — you must play' };
  g.passed.add(pid);
  tSay(g, `${nameOf(g, pid)} passes.`);
  advance(g);
  return { ok: true };
}

function endRound(g) {
  const n = g.order.length;
  const last = g.order.find(id => !g.out.has(id));
  g.out.add(last);
  g.standings.push(last);
  player(g, last).place = n;
  g.lastStandings = [...g.standings];
  for (const id of g.standings) {
    const place = g.standings.indexOf(id) + 1;
    if (!g.scores[id]) g.scores[id] = { places: [], total: 0 };
    g.scores[id].places.push(place);
    g.scores[id].total += place;
  }
  say(g, `${nameOf(g, last)} takes last place. Round ${g.round} over.`);
  g.phase = 'roundend';
}

function cardView(id) {
  return { id, l: cardLabel(id), red: isRed(id) };
}

function view(g, pid) {
  const me = player(g, pid);
  const turn = currentTurn(g);
  const mine = g.phase === 'trade' && g.trade && g.trade.need[pid] != null;
  const v = {
    phase: g.phase,
    round: g.round,
    dealer: g.dealer ? nameOf(g, g.dealer) : null,
    you: pid,
    host: g.host,
    youTurn: turn === pid,
    turn: turn ? nameOf(g, turn) : null,
    hand: me ? me.hand.map(c => cardView(c.id)) : [],
    players: g.players.map(p => ({
      id: p.id,
      name: p.name,
      bot: !!p.bot,
      person: p.person || null,
      count: p.hand.length,
      place: p.place,
      out: g.out.has(p.id),
      passed: g.passed.has(p.id),
      isTurn: turn === p.id,
      you: p.id === pid,
    })),
    topPlay: g.topPlay
      ? { by: nameOf(g, g.topPlay.player), cards: g.topPlay.cards.map(c => cardView(c.id)) }
      : null,
    leads: g.topPlay ? nameOf(g, g.topPlay.player) : turn ? nameOf(g, turn) : null,
    log: [...g.trickLog],
    standings: g.standings.map(id => nameOf(g, id)),
    scores: g.order.map(id => {
      const s = g.scores[id];
      return { name: nameOf(g, id), places: s ? s.places : [], total: s ? s.total : 0 };
    }),
    legal: g.phase === 'play' && turn === pid && !g.stack ? legalPlays(me.hand, g.topPlay) : null,
    canPass: g.phase === 'play' && turn === pid && !!g.topPlay && !g.stack,
    stack: !g.stack
      ? null
      : g.stack.player === pid
        ? { max: g.stack.max, rank: g.stack.rank, rankName: rankText(g.stack.rank) }
        : { by: nameOf(g, g.stack.player), max: g.stack.max },
    trade: g.phase !== 'trade'
      ? null
      : mine
        ? {
            give: g.trade.need[pid],
            count: g.trade.received[pid].length,
            other: nameOf(g, g.trade.other[pid]),
          }
        : { waiting: Object.keys(g.trade.need).map(id => nameOf(g, id)) },
  };
  return v;
}

module.exports = {
  RANKS,
  THREE_D,
  newDeck,
  shuffle,
  comboOf,
  legalPlays,
  botMove,
  botStack,
  PERSONALITIES,
  describe,
  createGame,
  startRound,
  play,
  pass,
  stack,
  done,
  stackOptions,
  say,
  give,
  view,
  player,
};
