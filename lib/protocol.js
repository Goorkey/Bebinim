'use strict';

/**
 * Wire protocol shared by every WebSocket message.
 * Everything a client sends is validated and rebuilt here, so peers only ever
 * receive well-formed data (never raw, client-controlled objects).
 */

const EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];

const ROOM_RE = /^[a-z0-9-]{3,32}$/;
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const YOUTUBE_ID_RE = /^[\w-]{11}$/;
const FILE_URL_RE = new RegExp(`^/uploads/[a-f0-9]{16}\\.(?:${EXTENSIONS.join('|')})$`);

const MAX_PAYLOAD = 16 * 1024;
const MAX_CHAT_LENGTH = 500;
const MIN_RATE = 0.25;
const MAX_RATE = 4;
const MAX_TIME = 7 * 24 * 3600;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** { k: 'yt', id } or { k: 'file', u } -> clean copy, or null. */
function parseSource(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.k === 'yt' && typeof s.id === 'string' && YOUTUBE_ID_RE.test(s.id)) {
    return { k: 'yt', id: s.id };
  }
  if (s.k === 'file' && typeof s.u === 'string' && FILE_URL_RE.test(s.u)) {
    return { k: 'file', u: s.u };
  }
  return null;
}

/** Playback state -> clean copy with clamped numbers, or null. */
function parseState(msg) {
  if (typeof msg.playing !== 'boolean') return null;
  if (typeof msg.time !== 'number' || typeof msg.rate !== 'number') return null;
  if (!Number.isFinite(msg.time) || !Number.isFinite(msg.rate)) return null;
  return {
    playing: msg.playing,
    time: clamp(msg.time, 0, MAX_TIME),
    rate: clamp(msg.rate, MIN_RATE, MAX_RATE),
    seek: msg.seek === true,
  };
}

/** Chat text -> single-line trimmed string (max length), or null. */
function parseChat(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!clean) return null;
  return Array.from(clean).slice(0, MAX_CHAT_LENGTH).join('');
}

const sameSource = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = {
  EXTENSIONS,
  ROOM_RE,
  CID_RE,
  FILE_URL_RE,
  MAX_PAYLOAD,
  MAX_CHAT_LENGTH,
  parseSource,
  parseState,
  parseChat,
  sameSource,
};
