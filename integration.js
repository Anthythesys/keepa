'use strict';
// Server integration: kick -> bot, disconnect -> grace -> bot, rejoin restores.
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('/home/bruno/keepa/node_modules/ws');

const PORT = 3221;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn('node', ['server.js'], {
  cwd: '/home/bruno/keepa',
  env: { ...process.env, PORT: String(PORT), GRACE_MS: '400' },
  stdio: 'ignore',
});

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const seen = { states: [], kicked: 0, errs: [] };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'state') seen.states.push(m.s);
    if (m.t === 'kicked') seen.kicked++;
    if (m.t === 'err') seen.errs.push(m.msg);
  });
  const send = o => ws.send(JSON.stringify(o));
  const last = () => seen.states[seen.states.length - 1];
  return { ws, send, seen, last };
}
const open = c => new Promise(res => c.ws.on('open', res));

(async () => {
  await sleep(600);
  const host = client(), a = client(), b = client(), c = client();
  await Promise.all([open(host), open(a), open(b), open(c)]);
  host.send({ t: 'create', name: 'Host' });
  await sleep(200);
  const code = host.last().code;
  for (const [cl, nm] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
    cl.send({ t: 'join', code, name: nm });
    await sleep(150);
  }
  assert.strictEqual(host.last().players.length, 4);
  host.send({ t: 'start' });
  await sleep(300);
  assert.strictEqual(host.last().phase, 'play', 'game running');

  // --- non-host cannot kick -------------------------------------------------
  const hostId = host.last().host;
  const bId = host.last().players.find(p => p.name === 'B').id;
  a.send({ t: 'kick', id: bId });
  await sleep(200);
  assert.ok(a.seen.errs.some(e => e.includes('Only the host')), 'kick is host-only, got: ' + a.seen.errs);

  // --- host kicks B: kicked message, socket closed, bot seat -----------------
  host.send({ t: 'kick', id: bId });
  await sleep(400);
  assert.strictEqual(b.seen.kicked, 1, 'B is told they were kicked');
  assert.strictEqual(b.ws.readyState, 3, 'B socket closed');
  const seatB = host.last().players.find(p => p.name === 'B');
  assert.ok(seatB.bot, 'B is now a bot');
  assert.ok(host.last().log.some(l => l.includes('was kicked')), 'kick announced');

  // --- kicked player cannot rejoin -------------------------------------------
  const b2 = client();
  await open(b2);
  b2.send({ t: 'join', code, name: 'B' });
  await sleep(200);
  assert.ok(b2.seen.errs.some(e => e.includes('removed')), 'kicked rejoin refused, got: ' + b2.seen.errs);
  b2.ws.close();

  // --- disconnect + fast rejoin restores the human ---------------------------
  a.ws.close();
  await sleep(150); // within the 400ms grace
  const a2 = client();
  await open(a2);
  a2.send({ t: 'join', code, name: 'A' });
  await sleep(300);
  const seatA = host.last().players.find(p => p.name === 'A');
  assert.ok(!seatA.bot, 'A is human again after rejoining in time');
  assert.ok(host.last().log.some(l => l.includes('disconnected')), 'disconnect was announced');

  // --- disconnect past the grace: bot takes over ------------------------------
  a2.ws.close();
  await sleep(900); // grace (400ms) well over
  const seatA2 = host.last().players.find(p => p.name === 'A');
  assert.ok(seatA2.bot, 'A became a bot after the grace period');
  assert.ok(host.last().log.some(l => l.includes("didn't return")), 'replacement announced');

  // --- the returner takes the seat back from the bot ---------------------------
  const a3 = client();
  await open(a3);
  a3.send({ t: 'join', code, name: 'A' });
  await sleep(300);
  const seatA3 = host.last().players.find(p => p.name === 'A');
  assert.ok(!seatA3.bot, 'A is human again after the bot era');

  // --- the game is still alive and moving (bots + humans) -----------------------
  assert.strictEqual(host.last().phase, 'play');
  for (const cl of [host, a3, c]) cl.ws.close();
  await sleep(200);
  server.kill();
  console.log('server integration tests passed');
  process.exit(0);
})().catch(e => {
  console.error('INTEGRATION FAILED:', e.message);
  server.kill();
  process.exit(1);
});
