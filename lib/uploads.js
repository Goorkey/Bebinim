'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Transform, pipeline } = require('stream');
const express = require('express');

const { EXTENSIONS, FILE_URL_RE } = require('./protocol');
const { createRateLimiter } = require('./rate-limit');

const PART_MAX_AGE_MS = 3600_000; // abandoned partial uploads
const SWEEP_EVERY_MS = 15 * 60_000;

// First box type of an ISO/QuickTime file sits at bytes 4-8.
const BOX_TYPES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']);

/** Cheap signature check so renamed non-video files are rejected. */
function looksLikeVideo(ext, head) {
  if (head.length < 8) return false;
  switch (ext) {
    case 'mp4':
    case 'm4v':
    case 'mov':
      return BOX_TYPES.has(head.toString('latin1', 4, 8));
    case 'webm':
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case 'ogv':
      return head.toString('latin1', 0, 4) === 'OggS';
    default:
      return false;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function fail(res, status, error) {
  if (res.destroyed || res.headersSent) return;
  res.set('Connection', 'close');
  res.status(status).json({ error });
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.log
 * @param {(url: string) => boolean} deps.isInUse  true while a room still plays this file
 */
function createUploads({ config, log, isInUse }) {
  const dir = config.uploadDir;
  fs.mkdirSync(dir, { recursive: true });

  const limiter = createRateLimiter({
    windowMs: 3600_000,
    max: config.uploadsPerHour,
    message: 'Too many uploads from this address. Try again later.',
  });

  /** Total bytes currently stored (files are few, so a directory scan is fine). */
  function storageUsed() {
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
      try {
        total += fs.statSync(path.join(dir, name)).size;
      } catch {
        /* file vanished mid-scan */
      }
    }
    return total;
  }

  function handleUpload(req, res) {
    const ext = String(req.query.ext || '').toLowerCase();
    if (!EXTENSIONS.includes(ext)) {
      return fail(res, 415, `Unsupported format. Use ${EXTENSIONS.join(', ')}.`);
    }

    const declared = Number(req.headers['content-length']);
    const hasLength = Number.isFinite(declared) && declared > 0;
    if (hasLength && declared > config.maxUploadBytes) {
      return fail(res, 413, `File is too large. The limit is ${formatBytes(config.maxUploadBytes)}.`);
    }
    if (storageUsed() + (hasLength ? declared : 0) > config.maxStorageBytes) {
      return fail(res, 507, 'The server is out of space for uploads. Try again later.');
    }

    const name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const finalPath = path.join(dir, name);
    const partPath = path.join(dir, `.${name}.part`);

    let received = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > config.maxUploadBytes) {
          return done(new HttpError(413, `File is too large. The limit is ${formatBytes(config.maxUploadBytes)}.`));
        }
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        done(null, chunk);
      },
    });

    pipeline(req, meter, fs.createWriteStream(partPath, { flags: 'wx' }), async (err) => {
      const discard = () => fsp.unlink(partPath).catch(() => {});

      if (err) {
        await discard();
        if (err instanceof HttpError) return fail(res, err.status, err.message);
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return; // client cancelled
        log.error('upload failed', { message: err.message });
        return fail(res, 500, 'Upload failed on the server.');
      }
      if (!looksLikeVideo(ext, head)) {
        await discard();
        return fail(res, 415, `That file does not look like a valid .${ext} video.`);
      }
      try {
        await fsp.rename(partPath, finalPath);
      } catch (renameError) {
        await discard();
        log.error('upload rename failed', { message: renameError.message });
        return fail(res, 500, 'Upload failed on the server.');
      }
      log.info('upload stored', { name, bytes: received });
      res.json({ url: `/uploads/${name}` });
    });
  }

  /** Does this /uploads/... URL point at a stored file? */
  function exists(url) {
    if (!FILE_URL_RE.test(url)) return false;
    return fs.existsSync(path.join(dir, path.basename(url)));
  }

  /** Delete the file behind a /uploads/... URL (no-op for anything else). */
  function remove(url) {
    if (!FILE_URL_RE.test(url)) return;
    fsp
      .unlink(path.join(dir, path.basename(url)))
      .then(() => log.info('upload removed', { url }))
      .catch(() => {});
  }

  /** Delete uploads nobody is watching any more, plus abandoned partials. */
  async function sweep() {
    const now = Date.now();
    let removed = 0;
    for (const name of await fsp.readdir(dir)) {
      const file = path.join(dir, name);
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) continue;
        const partial = name.endsWith('.part');
        if (now - stat.mtimeMs < (partial ? PART_MAX_AGE_MS : config.uploadTtlMs)) continue;
        if (!partial && isInUse(`/uploads/${name}`)) continue;
        await fsp.unlink(file);
        removed++;
      } catch {
        /* ignore files that disappear or cannot be removed */
      }
    }
    if (removed) log.info('swept old uploads', { removed });
  }

  let sweeper = null;
  function startSweeper() {
    sweep().catch((e) => log.warn('sweep failed', { message: e.message }));
    sweeper = setInterval(() => sweep().catch(() => {}), SWEEP_EVERY_MS);
    sweeper.unref();
  }
  function stop() {
    clearInterval(sweeper);
    limiter.stop();
  }

  const serve = express.static(dir, {
    index: false,
    dotfiles: 'ignore', // hides in-progress .part files
    setHeaders(res) {
      res.setHeader('Cache-Control', 'private, max-age=3600');
    },
  });

  return {
    EXTENSIONS,
    post: [limiter, handleUpload],
    serve,
    exists,
    remove,
    sweep,
    startSweeper,
    stop,
  };
}

module.exports = { createUploads, looksLikeVideo };
