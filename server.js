'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PUB = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const GRACE_MS = Math.max(100, parseInt(process.env.GRACE_MS || '60000', 10) || 60000);
const rooms = new Map();
let seq = 0;

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.normalize(path.join(PUB, rel === '/' ? 'index.html' : rel.slice(1)));
  if (!file.startsWith(PUB)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Keep-alive: drop dead connections and keep idle ones alive.
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
const keepAlive = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function cleanName(n) {
  return String(n || '').trim().slice(0, 20);
}

// an avatar is a single emoji (with optional variation selectors); keep it tiny
function cleanAvatar(a) {
  const s = String(a || '').trim();
  if (!s || s.length > 8) return null;
  return /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/u.test(s) ? s : null;
}

function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcast(room) {
  for (const p of room.players) {
    send(p.ws, { t: 'state', s: room.game ? G.view(room.game, p.id) : lobbyView(room, p.id) });
  }
  for (const sp of (room.spectators || [])) {
    send(sp.ws, { t: 'state', s: room.game ? spectateView(room.game) : lobbyView(room, sp.id) });
  }
  scheduleBot(room);
  enforceTurnTimer(room);
  cleanupIfAbandoned(room);
}

// If every seat is a bot and no human is connected (or waiting to return),
// the room is abandoned — tear it down so the code can be reused.
function cleanupIfAbandoned(room) {
  const anyHumanConnected = room.players.some(p => p.ws !== null && !p.bot);
  const anyHumanGrace = room.grace && Object.keys(room.grace).length > 0;
  const anySpectator = (room.spectators || []).length > 0;
  if (!anyHumanConnected && !anyHumanGrace && !anySpectator && room.game) {
    clearGrace(room);
    rooms.delete(room.code);
  }
}

// Spectator view: full table state but no hand, no actions.
function spectateView(g) {
  const v = G.view(g, null);
  v.hand = [];
  v.legal = null;
  v.canPass = false;
  v.trade = null;
  v.stack = v.stack ? { by: v.stack.by, max: v.stack.max } : null;
  v.spectating = true;
  // reveal the hand of the player whose turn it is, so viewers can follow the play
  if (g.phase === 'play' && g.order[g.turnIdx]) {
    const full = G.view(g, g.order[g.turnIdx]);
    v.hand = full.hand;
    v.watch = full.turn;
  }
  return v;
}

// Auto-act when a human player's turn timer expires.
function enforceTurnTimer(room) {
  if (room.turnTimer || !room.game) return;
  const g = room.game;
  if (g.phase !== 'play' || !g.turnStarted) return;
  const pid = g.order[g.turnIdx];
  const p = room.players.find(x => x.id === pid);
  if (!p || p.bot) return; // bots have their own driver
  const remaining = G.TURN_TIME - (Date.now() - g.turnStarted);
  if (remaining <= 0) {
    // Time's up: auto-pass (or auto-play lowest if leading)
    room.turnTimer = setTimeout(() => {
      room.turnTimer = null;
      const gg = room.game;
      if (!gg) return;
      let r = null;
      if (gg.stack && gg.stack.player === pid) {
        const cards = G.botStack(G.player(gg, pid).hand, gg.stack, 'chill');
        r = cards ? G.stack(gg, pid, cards) : G.done(gg, pid);
      } else if (!gg.topPlay) {
        const legal = G.legalPlays(G.player(gg, pid).hand, null);
        r = legal.length ? G.play(gg, pid, legal[0]) : null;
      } else {
        r = G.pass(gg, pid);
      }
      if (r && r.err) console.log('turn timer auto-act error', pid, r.err);
      broadcast(room);
    }, 0);
    return;
  }
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    enforceTurnTimer(room);
  }, remaining + 50);
}

// Bots act server-side a beat after every state change, so the table keeps moving.
function scheduleBot(room) {
  if (room.botTimer || !room.game) return;
  const g = room.game;
  let pid = null;
  if (g.phase === 'play') {
    const id = g.order[g.turnIdx];
    const p = room.players.find(x => x.id === id);
    if (p && p.bot) pid = id;
  } else if (g.phase === 'trade') {
    const id = Object.keys(g.trade.need).find(k => {
      const p = room.players.find(x => x.id === k);
      return p && p.bot;
    });
    pid = id || null;
  }
  if (!pid) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    try {
      const gg = room.game;
      if (!gg) return;
      const rp = room.players.find(x => x.id === pid);
      const person = (rp && rp.person) || 'chill';
      let r = null;
      if (gg.phase === 'trade' && gg.trade && gg.trade.need[pid] != null) {
        const gp = G.player(gg, pid);
        r = G.give(gg, pid, gp.hand.slice(0, gg.trade.need[pid]).map(c => c.id));
      } else if (gg.phase === 'play' && gg.order[gg.turnIdx] === pid) {
        const gp = G.player(gg, pid);
        if (gg.stack && gg.stack.player === pid) {
          const cards = G.botStack(gp.hand, gg.stack, person);
          r = cards ? G.stack(gg, pid, cards) : G.done(gg, pid);
        } else {
          const cards = G.botMove(gp.hand, gg.topPlay, person, gg);
          r = cards ? G.play(gg, pid, cards) : G.pass(gg, pid);
        }
      }
      if (r && r.err) console.log('bot error', pid, r.err);
      broadcast(room);
    } catch (e) {
      // a bot must never take the table down with it
      console.log('bot crashed:', e.message);
      try {
        broadcast(room);
      } catch (e2) {}
    }
  }, 450);
}

function lobbyView(room, pid) {
  return {
    phase: 'lobby',
    host: room.players[0] && room.players[0].id,
    code: room.code,
    you: pid,
    isPrivate: !!room.isPrivate,
    players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar || null, bot: !!p.bot, person: p.person || null, connected: p.ws !== null, you: p.id === pid })),
  };
}

function seat(room, ws, name, avatar) {
  if (!name) return send(ws, { t: 'err', msg: 'Name required' });
  avatar = cleanAvatar(avatar);
  // leaving another room on this socket: vacate the old seat entirely
  if (ws.code && ws.code !== room.code) {
    const prev = rooms.get(ws.code);
    const oi = prev ? prev.players.findIndex(x => x.id === ws.pid) : -1;
    if (oi >= 0) prev.players.splice(oi, 1);
    if (prev && !prev.players.length) { clearGrace(prev); rooms.delete(prev.code); }
    else if (prev) broadcast(prev);
  }
  let p = room.players.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (p) {
    if (p.kicked) return send(ws, { t: 'err', msg: 'You were removed from this room' });
    if (room.grace && room.grace[p.id]) {
      clearTimeout(room.grace[p.id]);
      delete room.grace[p.id];
    }
    if (p.replaced) {
      // back within the grace period (or after): take the seat back from the bot
      p.bot = false;
      p.replaced = false;
      const gp = room.game && G.player(room.game, p.id);
      if (gp) gp.bot = false;
      note(room, `${p.name} is back!`);
    }
    p.ws = ws; // rejoin / refresh
    p.avatar = avatar;
    const gp = room.game && G.player(room.game, p.id);
    if (gp) gp.avatar = avatar;
  } else if (room.game) {
    return send(ws, { t: 'err', msg: 'Game already in progress' });
  } else if (room.players.length >= 6) {
    return send(ws, { t: 'err', msg: 'Room is full (max 6)' });
  } else {
    p = { id: 'p' + ++seq, name, ws, avatar };
    room.players.push(p);
  }
  ws.pid = p.id;
  ws.code = room.code;
  send(ws, { t: 'joined', code: room.code, pid: p.id });
  broadcast(room);
}

function roomOf(ws) {
  return rooms.get(ws.code);
}

// visible announcement (lands in the trick log too)
function note(room, msg) {
  if (!room.game) return;
  G.say(room.game, msg);
  room.game.trickLog.push(msg);
  if (room.game.trickLog.length > 60) room.game.trickLog.shift();
}

function clearGrace(room) {
  if (!room.grace) return;
  for (const id of Object.keys(room.grace)) clearTimeout(room.grace[id]);
  room.grace = {};
}

// a disconnected human gets 60s to return before a bot takes the seat
function startGrace(room, p) {
  room.grace = room.grace || {};
  if (room.grace[p.id]) return;
  note(room, `${p.name} disconnected — 60 seconds to reconnect.`);
  broadcast(room);
  room.grace[p.id] = setTimeout(() => {
    delete room.grace[p.id];
    if (!rooms.get(room.code) || p.ws !== null) return;
    p.bot = true;
    p.replaced = true;
    const gp = room.game && G.player(room.game, p.id);
    if (gp) gp.bot = true;
    note(room, `${p.name} didn't return — a bot takes their seat.`);
    broadcast(room);
    cleanupIfAbandoned(room);
  }, GRACE_MS);
}

function handle(ws, m) {
  const fail = msg => send(ws, { t: 'err', msg });
  switch (m.t) {
    case 'create': {
      if (rooms.size >= 200) return fail('Too many rooms right now, try again later');
      const code = makeCode();
      const room = { code, players: [], game: null, grace: {}, spectators: [], isPrivate: !!m.private };
      rooms.set(code, room);
      return seat(room, ws, cleanName(m.name), m.avatar);
    }
    case 'list': {
      const list = [];
      for (const [code, room] of rooms) {
        if (room.isPrivate) continue;
        if (room.game) continue; // don't list in-progress games
        list.push({
          code,
          players: room.players.length,
          max: 6,
          bots: room.players.filter(p => p.bot).length,
        });
      }
      return send(ws, { t: 'rooms', rooms: list });
    }
    case 'togglePrivate': {
      const room = roomOf(ws);
      if (!room) return fail('No room');
      if (room.players[0].id !== ws.pid) return fail('Only the host can do that');
      if (room.game) return fail('Game already in progress');
      room.isPrivate = !room.isPrivate;
      return broadcast(room);
    }
    case 'join': {
      const room = rooms.get(String(m.code || '').trim().toUpperCase());
      if (!room) return fail('No room with that code');
      return seat(room, ws, cleanName(m.name), m.avatar);
    }
    case 'avatar': {
      const room = roomOf(ws);
      if (!room) return fail('No room');
      const p = room.players.find(x => x.id === ws.pid);
      if (!p) return fail('No seat');
      p.avatar = cleanAvatar(m.avatar);
      const gp = room.game && G.player(room.game, p.id);
      if (gp) gp.avatar = p.avatar;
      return broadcast(room);
    }
    case 'spectate': {
      const room = rooms.get(String(m.code || '').trim().toUpperCase());
      if (!room) return fail('No room with that code');
      const sp = { id: 's' + ++seq, name: 'Spectator', ws };
      room.spectators = room.spectators || [];
      room.spectators.push(sp);
      ws.pid = sp.id;
      ws.code = room.code;
      ws.spectating = true;
      send(ws, { t: 'joined', code: room.code, pid: sp.id });
      return broadcast(room);
    }
    case 'bot': {
      const room = roomOf(ws);
      if (!room) return fail('No room');
      if (room.players[0].id !== ws.pid) return fail('Only the host can do that');
      if (room.game) return fail('Round already started');
      if (m.action === 'add') {
        if (room.players.length >= 6) return fail('Room is full (max 6)');
        room.botSeq = (room.botSeq || 0) + 1;
        // cycle personalities so a full bot table always has variety
        const person = G.PERSONALITIES[(room.botSeq - 1) % G.PERSONALITIES.length];
        room.players.push({ id: 'p' + ++seq, name: 'Bot ' + room.botSeq, ws: null, bot: true, person });
      } else {
        const i = room.players.findIndex(p => p.bot && p.id === m.id);
        if (i < 1) return fail('No such bot');
        room.players.splice(i, 1);
      }
      return broadcast(room);
    }
    case 'kick': {
      const room = roomOf(ws);
      if (!room || !room.game) return fail('No game');
      if (room.players[0].id !== ws.pid) return fail('Only the host can do that');
      const t = room.players.find(p => p.id === m.id);
      if (!t || t.id === ws.pid) return fail('No such player');
      if (t.bot) return fail('Already a bot');
      t.bot = true;
      t.kicked = true;
      const gp = G.player(room.game, t.id);
      if (gp) gp.bot = true;
      if (room.grace && room.grace[t.id]) {
        clearTimeout(room.grace[t.id]);
        delete room.grace[t.id];
      }
      note(room, `${t.name} was kicked — a bot takes their seat.`);
      send(t.ws, { t: 'kicked' });
      try {
        if (t.ws) t.ws.close();
      } catch (e) {}
      t.ws = null;
      return broadcast(room);
    }
    case 'start': {
      const room = roomOf(ws);
      if (!room) return fail('No room');
      if (room.game) return fail('Round already started');
      if (room.players[0].id !== ws.pid) return fail('Only the host can start');
      if (room.players.length < 4) return fail('Need at least 4 players');
      room.game = G.createGame(room.players, room.players[0].id);
      G.startRound(room.game, room.players[Math.floor(Math.random() * room.players.length)].id);
      return broadcast(room);
    }
    case 'play':
    case 'pass':
    case 'stack':
    case 'done':
    case 'give': {
      const room = roomOf(ws);
      if (!room || !room.game) return fail('No game');
      const r =
        m.t === 'play' ? G.play(room.game, ws.pid, Array.isArray(m.cards) ? m.cards : [])
        : m.t === 'pass' ? G.pass(room.game, ws.pid)
        : m.t === 'stack' ? G.stack(room.game, ws.pid, Array.isArray(m.cards) ? m.cards : [])
        : m.t === 'done' ? G.done(room.game, ws.pid)
        : G.give(room.game, ws.pid, Array.isArray(m.cards) ? m.cards : []);
      if (r.err) return fail(r.err);
      return broadcast(room);
    }
    case 'export': {
      const room = roomOf(ws);
      if (!room || !room.game) return fail('No game');
      const g = room.game;
      const rows = [['Rank', 'Name', 'Places', 'Total']];
      const sorted = g.order.map(id => {
        const s = g.scores[id];
        return { name: nameOf(g, id), places: s ? s.places.join(' ') : '', total: s ? s.total : 0 };
      }).sort((a, b) => a.total - b.total);
      sorted.forEach((s, i) => rows.push([i + 1, s.name, s.places, s.total]));
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      return send(ws, { t: 'export', csv, round: g.round });
    }
    case 'next': {
      const room = roomOf(ws);
      if (!room || !room.game) return fail('No game');
      if (room.game.host !== ws.pid) return fail('Only the host can start the next round');
      if (room.game.phase !== 'roundend') return fail('Round is not over');
      G.startRound(room.game, room.game.lastStandings[room.game.lastStandings.length - 1]);
      return broadcast(room);
    }
    default:
      return fail('Unknown message');
  }
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handle(ws, m);
    } catch (e) {
      console.error(e);
      send(ws, { t: 'err', msg: 'Server error' });
    }
  });
  ws.on('close', () => {
    const room = rooms.get(ws.code);
    if (!room) return;
    if (ws.spectating) {
      const i = (room.spectators || []).findIndex(x => x.id === ws.pid);
      if (i >= 0) room.spectators.splice(i, 1);
      if (!room.players.length && (!room.spectators || !room.spectators.length)) {
        clearGrace(room);
        rooms.delete(room.code);
      }
      return;
    }
    const p = room.players.find(x => x.id === ws.pid);
    if (p) {
      p.ws = null;
      if (!p.kicked && !p.bot && !p.replaced && room.game &&
          (room.game.phase === 'play' || room.game.phase === 'trade')) {
        startGrace(room, p);
      } else if (!room.game) {
        // Lobby: give a brief grace period so a dropped host can reconnect
        // before the room is deleted.
        room.grace = room.grace || {};
        if (!room.grace[p.id]) {
          room.grace[p.id] = setTimeout(() => {
            delete room.grace[p.id];
            const r = rooms.get(room.code);
            if (r && r.players.every(x => x.ws === null) && Object.keys(r.grace).length === 0) {
              clearGrace(r);
              rooms.delete(room.code);
            }
          }, 120000); // 2 minutes
        }
      }
    }
    // ponytail: rooms vanish when nobody (and no pending return) is left
    const waiting = room.grace && Object.keys(room.grace).length > 0;
    if (room.players.every(x => x.ws === null) && !waiting) {
      clearGrace(room);
      rooms.delete(room.code);
    } else broadcast(room);
  });
});

server.listen(PORT, () => console.log(`Keepa on http://localhost:${PORT}`));
