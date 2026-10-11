'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const protocol = require('./protocol');

const HEARTBEAT_MS = 30_000;

// Close codes the browser client understands (4000-4999 are application-defined).
const CLOSE = { FULL: 4001, REPLACED: 4002, BAD_ROOM: 4003 };

const send = (ws, message) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

/** Allows ~20 messages/second sustained, with bursts up to 40. */
function createBucket(capacity = 40, refillPerSecond = 20) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

class Room {
  constructor(id) {
    this.id = id;
    this.clients = new Map(); // clientId -> ws
    this.src = null;
    this.state = { playing: false, time: 0, rate: 1, at: Date.now() };
    this.expiry = null;
  }

  /** Current playback state, advanced to "now" if it is playing. */
  snapshot(now = Date.now()) {
    const { playing, time, rate, at } = this.state;
    return { playing, rate, time: playing ? time + ((now - at) / 1000) * rate : time };
  }

  setState({ playing, time, rate }) {
    this.state = { playing, time, rate, at: Date.now() };
  }

  broadcast(message, except) {
    const data = JSON.stringify(message);
    for (const ws of this.clients.values()) {
      if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
}

/**
 * Attach the realtime layer to an HTTP server.
 *
 * The server keeps each room's source and playback state, so a partner who joins
 * late or reconnects is brought up to date without relying on the other person.
 */
function attachRealtime({ server, config, log, uploads }) {
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: protocol.MAX_PAYLOAD });

  /* ---------- upgrade: path + origin checks ---------- */

  const reject = (socket, status) => {
    socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (tests, curl)
    if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return reject(socket, 400);
    }
    if (url.pathname !== '/ws') return reject(socket, 404);
    if (!originAllowed(req)) return reject(socket, 403);

    const params = {
      roomId: (url.searchParams.get('room') || '').toLowerCase(),
      cid: url.searchParams.get('cid') || '',
    };
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, params));
  });

  /* ---------- room lifecycle ---------- */

  function isFileInUse(url) {
    for (const room of rooms.values()) if (room.src?.u === url) return true;
    return false;
  }

  function releaseFile(src) {
    if (src?.k === 'file' && !isFileInUse(src.u)) uploads.remove(src.u);
  }

  function scheduleExpiry(room) {
    clearTimeout(room.expiry);
    room.expiry = setTimeout(() => {
      if (room.clients.size) return;
      rooms.delete(room.id);
      releaseFile(room.src);
      log.info('room expired', { room: room.id });
    }, config.roomGraceMs);
    room.expiry.unref();
  }

  /* ---------- connections ---------- */

  wss.on('connection', (ws, _req, { roomId, cid }) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', (err) => log.warn('socket error', { message: err.message }));

    if (!protocol.ROOM_RE.test(roomId) || !protocol.CID_RE.test(cid)) {
      return ws.close(CLOSE.BAD_ROOM, 'invalid room');
    }

    const room = rooms.get(roomId) || new Room(roomId);
    rooms.set(roomId, room);

    // Same browser tab reconnecting: drop its ghost connection first.
    const previous = room.clients.get(cid);
    if (previous) {
      room.clients.delete(cid);
      previous.close(CLOSE.REPLACED, 'replaced');
    }

    if (room.clients.size >= config.maxPeersPerRoom) {
      send(ws, { t: 'error', code: 'room_full' });
      ws.close(CLOSE.FULL, 'room full');
      if (!room.clients.size) scheduleExpiry(room);
      return;
    }

    clearTimeout(room.expiry);
    room.clients.set(cid, ws);
    send(ws, { t: 'hello', n: room.clients.size, src: room.src, state: room.snapshot() });
    room.broadcast({ t: 'presence', n: room.clients.size, event: 'join' }, ws);
    log.info('joined', { room: roomId, people: room.clients.size });

    const allow = createBucket();
    let strikes = 0;

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      if (isBinary) return;
      if (!allow()) {
        if (++strikes > 50) ws.close(1008, 'rate limit');
        return;
      }
      handleMessage(room, ws, data);
    });

    ws.on('close', () => {
      if (room.clients.get(cid) !== ws) return; // already replaced
      room.clients.delete(cid);
      if (room.clients.size) {
        room.broadcast({ t: 'presence', n: room.clients.size, event: 'leave' });
      } else {
        scheduleExpiry(room);
      }
      log.info('left', { room: roomId, people: room.clients.size });
    });
  });

  function handleMessage(room, ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'ping':
        return send(ws, { t: 'pong' });

      case 'state': {
        const state = protocol.parseState(msg);
        if (!state) return;
        room.setState(state);
        return room.broadcast({ t: 'state', ...state }, ws);
      }

      case 'src': {
        const src = protocol.parseSource(msg.s);
        if (!src) return;
        if (src.k === 'file' && !uploads.exists(src.u)) {
          return send(ws, { t: 'error', code: 'missing_file' });
        }
        const previous = room.src;
        room.src = src;
        room.setState({ playing: false, time: 0, rate: 1 });
        room.broadcast({ t: 'src', s: src }, ws);
        if (previous && !protocol.sameSource(previous, src)) releaseFile(previous);
        return;
      }

      case 'chat': {
        const text = protocol.parseChat(msg.m);
        if (!text) return;
        return room.broadcast({ t: 'chat', m: text, ts: Date.now() }, ws);
      }

      default:
        return; // unknown types are ignored, never relayed
    }
  }

  /* ---------- heartbeat: drop connections that went silent ---------- */

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    for (const room of rooms.values()) clearTimeout(room.expiry);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    wss.close();
  }

  return { close, isFileInUse, stats: () => ({ rooms: rooms.size, clients: wss.clients.size }) };
}

module.exports = { attachRealtime, CLOSE };
