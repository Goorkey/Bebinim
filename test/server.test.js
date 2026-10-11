'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const { createApp } = require('../server');

let app;
let base;
let wsBase;
let uploadDir;

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-uploads-'));
  app = createApp({ port: 0, silent: true, uploadDir, maxUploadBytes: 64 * 1024, roomGraceMs: 60_000 });
  const port = await app.start();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(async () => {
  await app.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

/** Open a socket and give it a promise-based inbox. */
function connect(room, cid, headers) {
  const ws = new WebSocket(`${wsBase}/ws?room=${room}&cid=${cid}`, { headers });
  const inbox = [];
  const waiters = [];
  let closed = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.on('close', (code) => (closed = code));
  const client = {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next(type) {
      const match = (m) => m.t === type;
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), 2000);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    closed: () =>
      new Promise((resolve) => {
        if (closed !== null) return resolve(closed);
        ws.on('close', resolve);
      }),
    pending: () => inbox.slice(),
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('health check responds', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('serves the app and sets security headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Watch Together/);
  assert.match(res.headers.get('content-security-policy'), /frame-src https:\/\/www\.youtube\.com/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('two people: presence, state sync and chat are relayed', async () => {
  const a = await connect('sync-room', 'client-aaaa-1');
  const helloA = await a.next('hello');
  assert.equal(helloA.n, 1);
  assert.equal(helloA.src, null);

  const b = await connect('sync-room', 'client-bbbb-1');
  assert.equal((await b.next('hello')).n, 2);
  const joined = await a.next('presence');
  assert.deepEqual([joined.n, joined.event], [2, 'join']);

  a.send({ t: 'state', playing: true, time: 12.5, rate: 1.5, seek: true });
  const state = await b.next('state');
  assert.deepEqual(state, { t: 'state', playing: true, time: 12.5, rate: 1.5, seek: true });

  b.send({ t: 'chat', m: '  hello   there  ' });
  const chat = await a.next('chat');
  assert.equal(chat.m, 'hello there');
  assert.ok(Number.isFinite(chat.ts));

  b.ws.close();
  const left = await a.next('presence');
  assert.deepEqual([left.n, left.event], [1, 'leave']);
  a.ws.close();
});

test('a third person is turned away with code 4001', async () => {
  const a = await connect('full-room', 'client-aaaa-2');
  const b = await connect('full-room', 'client-bbbb-2');
  await a.next('hello');
  await b.next('hello');

  const c = await connect('full-room', 'client-cccc-2');
  assert.equal(await c.closed(), 4001);
  a.ws.close();
  b.ws.close();
});

test('a late joiner receives the current source and an advanced playback position', async () => {
  const a = await connect('late-room', 'client-aaaa-3');
  await a.next('hello');
  a.send({ t: 'src', s: { k: 'yt', id: 'dQw4w9WgXcQ' } });
  a.send({ t: 'state', playing: true, time: 100, rate: 1 });
  await sleep(1200);

  const b = await connect('late-room', 'client-bbbb-3');
  const hello = await b.next('hello');
  assert.deepEqual(hello.src, { k: 'yt', id: 'dQw4w9WgXcQ' });
  assert.equal(hello.state.playing, true);
  assert.ok(hello.state.time >= 100.9 && hello.state.time < 103, `time was ${hello.state.time}`);
  a.ws.close();
  b.ws.close();
});

test('a reconnecting client replaces its own stale connection (4002)', async () => {
  const first = await connect('replace-room', 'client-aaaa-4');
  await first.next('hello');
  const second = await connect('replace-room', 'client-aaaa-4');
  assert.equal((await second.next('hello')).n, 1);
  assert.equal(await first.closed(), 4002);
  second.ws.close();
});

test('invalid messages are dropped and never relayed', async () => {
  const a = await connect('valid-room', 'client-aaaa-5');
  const b = await connect('valid-room', 'client-bbbb-5');
  await a.next('hello');
  await b.next('hello');
  await a.next('presence');

  a.send({ t: 'src', s: { k: 'yt', id: 'short' } });
  a.send({ t: 'src', s: { k: 'file', u: '/uploads/../../etc/passwd' } });
  a.send({ t: 'state', playing: 'yes', time: 1, rate: 1 });
  a.send({ t: 'state', playing: true, time: 'NaN', rate: 1 });
  a.send({ t: 'chat', m: '   ' });
  a.send({ t: 'evil', payload: '<script>' });
  a.ws.send('not json');
  // Sentinel: a valid message sent last proves the earlier ones were processed first.
  a.send({ t: 'chat', m: 'x'.repeat(2000) });

  const chat = await b.next('chat');
  assert.equal(chat.m.length, 500);
  assert.deepEqual(b.pending(), []);

  a.send({ t: 'state', playing: true, time: -50, rate: 99 });
  const clamped = await b.next('state');
  assert.equal(clamped.time, 0);
  assert.equal(clamped.rate, 4);
  a.ws.close();
  b.ws.close();
});

test('an invalid room code is rejected with 4003', async () => {
  const c = await connect('x', 'client-aaaa-6');
  assert.equal(await c.closed(), 4003);
});

test('cross-site WebSocket connections are refused', async () => {
  await assert.rejects(connect('origin-room', 'client-aaaa-7', { Origin: 'https://evil.example' }));
});

/* ---------- uploads ---------- */

const mp4Bytes = (size) => {
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(24, 0);
  buf.write('ftypisom', 4, 'latin1');
  return buf;
};

const upload = (ext, body) =>
  fetch(`${base}/upload?ext=${ext}`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });

test('uploads a valid video, serves it with Range support, and lets it be shared', async () => {
  const res = await upload('mp4', mp4Bytes(4096));
  assert.equal(res.status, 200);
  const { url } = await res.json();
  assert.match(url, /^\/uploads\/[a-f0-9]{16}\.mp4$/);

  const range = await fetch(base + url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);

  const a = await connect('upload-room', 'client-aaaa-8');
  const b = await connect('upload-room', 'client-bbbb-8');
  await a.next('hello');
  await b.next('hello');
  a.send({ t: 'src', s: { k: 'file', u: url } });
  assert.deepEqual((await b.next('src')).s, { k: 'file', u: url });
  a.ws.close();
  b.ws.close();
});

test('rejects unsupported extensions, fake videos and oversized files', async () => {
  assert.equal((await upload('exe', mp4Bytes(100))).status, 415);
  assert.equal((await upload('mp4', Buffer.from('definitely not a video file'))).status, 415);
  assert.equal((await upload('webm', mp4Bytes(2048))).status, 415); // wrong signature for webm

  const tooBig = await upload('mp4', mp4Bytes(65 * 1024));
  assert.equal(tooBig.status, 413);
  assert.match((await tooBig.json()).error, /too large/i);
});

test('a source pointing at a missing upload is refused', async () => {
  const a = await connect('missing-room', 'client-aaaa-9');
  await a.next('hello');
  a.send({ t: 'src', s: { k: 'file', u: '/uploads/0123456789abcdef.mp4' } });
  assert.equal((await a.next('error')).code, 'missing_file');
  a.ws.close();
});

test('replacing the source deletes the previous upload', async () => {
  const { url } = await (await upload('mp4', mp4Bytes(2048))).json();
  const file = path.join(uploadDir, path.basename(url));
  assert.ok(fs.existsSync(file));

  const a = await connect('cleanup-room', 'client-aaaa-10');
  await a.next('hello');
  a.send({ t: 'src', s: { k: 'file', u: url } });
  a.send({ t: 'src', s: { k: 'yt', id: 'dQw4w9WgXcQ' } });
  await sleep(200);
  assert.equal(fs.existsSync(file), false);
  a.ws.close();
});

test('unknown routes return 404 JSON', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});
