'use strict';

const path = require('path');

const MB = 1024 * 1024;

/** Positive integer from an env string, or the fallback. */
function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Express "trust proxy": "1" -> 1 hop, "loopback" -> preset, unset -> off. */
function trustProxy(value) {
  if (!value) return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

function load(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || undefined, // undefined = all interfaces

    publicDir: path.join(__dirname, '..', 'public'),
    uploadDir: path.resolve(env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')),

    maxUploadBytes: int(env.MAX_UPLOAD_MB, 2048) * MB, // per file
    maxStorageBytes: int(env.MAX_STORAGE_MB, 10240) * MB, // whole uploads folder
    uploadsPerHour: int(env.UPLOADS_PER_HOUR, 10), // per IP
    uploadTtlMs: int(env.UPLOAD_TTL_HOURS, 24) * 3600_000, // orphan clean-up age
    uploadTimeoutMs: int(env.UPLOAD_TIMEOUT_MIN, 120) * 60_000, // slow links need time

    maxPeersPerRoom: 2,
    roomGraceMs: int(env.ROOM_GRACE_MIN, 10) * 60_000, // keep an empty room's state this long

    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: trustProxy(env.TRUST_PROXY),
    csp: env.CSP !== 'off',
    silent: false,
  };
}

module.exports = { load };
