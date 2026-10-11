import { $, fmtTime, fmtBytes, setIcon, toast, local, session, copyText } from './ui.js';
import { Connection } from './net.js';
import { createPlayer } from './players.js';
import { createChat } from './chat.js';

/* =====================================================================
 * Constants
 * ===================================================================== */

const SEEK_STEP = 10; // seconds for double-tap / arrow keys
const DRIFT = { playing: 1.2, paused: 0.3 }; // seconds of drift tolerated before we re-seek
const SYNC_MS = 1500; // how often we compare against the shared clock
const COOLDOWN_MS = 4000; // wait after a correction so buffering can't cause a seek loop
const DOUBLE_TAP_MS = 300;
const IDLE_MS = 3500; // hide controls this long after the last interaction while playing

const ROOM_RE = /^[a-z0-9-]{3,32}$/;
const YT_LINK_RE = /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/;
const YT_ID_RE = /^[\w-]{11}$/;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters

const QUALITY_LABELS = {
  hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p',
  large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto',
};

const coarse = matchMedia('(pointer: coarse)').matches; // phones and tablets

/* =====================================================================
 * Elements and state
 * ===================================================================== */

const ui = {
  lobby: $('lobby'), stage: $('stage'), mw: $('mw'), video: $('v'),
  room: $('room'), invited: $('invited'), lobbyMsg: $('lobbyMsg'),
  status: $('status'), statusText: $('statusText'),
  bar: $('bar'), tm: $('tm'), pp: $('pp'), sp: $('sp'), ql: $('ql'),
  mute: $('mute'), vol: $('vol'), fs: $('fs'),
  sd: $('sd'), yu: $('yu'), pick: $('pick'), fi: $('fi'),
  upRow: $('upRow'), upBar: $('upBar'), upText: $('upText'), sMsg: $('sMsg'), hint: $('hint'),
};

const clampVolume = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
const now = () => performance.now();

const app = {
  room: null,
  conn: null,
  status: 'offline', // connection: connecting | online | offline
  everOnline: false,
  peers: 1,
  src: null, // what this tab is playing: { k:'yt', id } | { k:'file', u }
  player: null, // adapter from players.js, set once the media is ready
  loadAbort: null,
  // Shared playback clock. `time` was true at `at` (performance.now); while playing it advances.
  base: { playing: false, time: 0, rate: 1, at: 0 },
  buffering: false,
  scrubbing: false,
  lastCorrection: 0,
  stuck: 0,
  upload: null,
  wakeLock: null,
  volume: clampVolume(Number(local.get('wt.volume') ?? 1)),
  muted: local.get('wt.muted') === '1',
};

let limits = { maxUploadBytes: 2 * 1024 ** 3, extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] };

const chat = createChat({
  stage: ui.stage,
  onSend(text) {
    if (app.conn?.send({ t: 'chat', m: text })) return true;
    toast('Not connected. Your message was not sent.', { kind: 'error' });
    return false;
  },
});

/* =====================================================================
 * Lobby
 * ===================================================================== */

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const normalizeRoom = (value) =>
  value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 32);

/** One id per browser tab, so a reconnect can replace its own stale connection. */
function clientId() {
  let id = session.get('wt.cid');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : randomCode() + randomCode() + randomCode();
    session.set('wt.cid', id);
  }
  return id;
}

function showLobbyMessage(text) {
  ui.lobbyMsg.textContent = text || '';
  ui.lobbyMsg.hidden = !text;
}

const invitedRoom = normalizeRoom(new URLSearchParams(location.search).get('room') || '');
ui.room.value = invitedRoom || randomCode();
if (invitedRoom) {
  ui.invited.textContent = `You were invited to room "${invitedRoom}". Press Join room to start watching.`;
  ui.invited.hidden = false;
}

$('reroll').addEventListener('click', () => { ui.room.value = randomCode(); ui.room.focus(); });

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const room = normalizeRoom(ui.room.value);
  if (!ROOM_RE.test(room)) {
    showLobbyMessage('Use 3 to 32 letters, numbers or dashes.');
    return;
  }
  showLobbyMessage('');
  ui.room.value = room;
  enterStage(room);
  if (coarse) enterFullscreen(); // must run inside this tap; desktop users get the button instead
});

/* =====================================================================
 * Entering and leaving the stage
 * ===================================================================== */

function enterStage(room) {
  app.room = room;
  ui.lobby.hidden = true;
  ui.stage.hidden = false;
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
  renderStatus();
  renderVolume();
  renderPlayState();
  poke();
  keepAwake();

  app.conn = new Connection({
    onMessage: onMessage,
    onStatus(status) {
      app.status = status;
      if (status === 'online') app.everOnline = true;
      renderStatus();
    },
    onFatal: (reason) => leave(reason),
  });
  app.conn.open(room, clientId());
}

function leave(message) {
  app.conn?.close();
  app.conn = null;
  app.loadAbort?.abort();
  app.player?.destroy();
  app.player = null;
  app.src = null;
  app.room = null;
  app.everOnline = false;
  app.peers = 1;
  app.upload?.abort();
  chat.reset();
  closeSource();
  releaseWakeLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  ui.stage.hidden = true;
  ui.lobby.hidden = false;
  history.replaceState(null, '', location.pathname);
  showLobbyMessage(message);
}

async function enterFullscreen() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return; // not supported (iPhone Safari) or refused
  }
  try { await screen.orientation.lock('landscape'); } catch { /* only works on some devices */ }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else enterFullscreen();
}

ui.fs.hidden = !document.documentElement.requestFullscreen;
ui.fs.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  setIcon(ui.fs, on ? 'collapse' : 'expand');
  ui.fs.setAttribute('aria-label', on ? 'Exit full screen' : 'Enter full screen');
});

/** Keep the phone awake while watching (needs HTTPS or localhost; silently skipped otherwise). */
async function keepAwake() {
  if (!('wakeLock' in navigator) || app.wakeLock) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
  } catch { /* denied or unsupported */ }
}
function releaseWakeLock() {
  app.wakeLock?.release().catch(() => {});
  app.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.room) keepAwake();
});

/* =====================================================================
 * Messages from the server
 * ===================================================================== */

const sameSource = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      return onHello(m);

    case 'src':
      if (sameSource(m.s, app.src)) return;
      closeSource();
      toast('Your partner picked a new video');
      return load(m.s, { autoplay: false });

    case 'state': {
      const before = app.base;
      setBase(m);
      if (app.player) enforce(m.seek === true);
      renderPlayState();
      poke();
      if (m.playing !== before.playing) toast(m.playing ? 'Your partner pressed play' : 'Your partner paused', { ms: 1800 });
      else if (m.seek) toast(`Your partner jumped to ${fmtTime(m.time)}`, { ms: 1800 });
      return;
    }

    case 'presence':
      app.peers = m.n;
      renderStatus();
      toast(m.event === 'join' ? 'Your partner joined' : 'Your partner left', { ms: 2500 });
      return;

    case 'chat':
      chat.add(m.m, false, m.ts);
      return;

    case 'error':
      if (m.code === 'missing_file') toast('That upload is no longer on the server. Upload it again.', { kind: 'error' });
      return;
  }
}

function onHello(m) {
  app.peers = m.n;
  renderStatus();

  if (m.src) {
    closeSource();
    if (!sameSource(m.src, app.src)) load(m.src, { autoplay: false });
    setBase(m.state); // after load(), which resets the clock
    if (app.player) enforce(true);
  } else if (app.src) {
    // The server lost this room (restart or expiry): rebuild it from what we are playing.
    app.conn.send({ t: 'src', s: app.src });
    if (app.player) {
      app.conn.send({ t: 'state', playing: app.base.playing, time: app.player.time(), rate: app.base.rate, seek: true });
    }
  } else {
    openSource();
  }
}

/* =====================================================================
 * Sync engine
 *
 * The server holds the room's playback state. Every client keeps the same
 * "shared clock" (`app.base`) and compares its own player to it, so a late
 * joiner, a reconnect or a slow-loading player all converge on one position.
 * ===================================================================== */

/** Where the shared clock says playback should be right now. */
function expected() {
  const b = app.base;
  let t = b.time;
  if (b.playing) t += ((now() - b.at) / 1000) * b.rate;
  const d = app.player?.duration() || 0;
  return d ? Math.min(t, d) : t;
}

function setBase({ playing, time, rate }) {
  app.base = { playing, time, rate, at: now() };
}

/** Make the local player match the shared clock. `force` always re-seeks. */
function enforce(force) {
  const p = app.player;
  if (!p) return;
  const b = app.base;
  const target = expected();

  p.setRate(b.rate);
  if (force || Math.abs(p.time() - target) > (b.playing ? DRIFT.playing : DRIFT.paused)) {
    p.seek(target);
    app.lastCorrection = now();
  }
  if (b.playing) {
    if (!p.isPlaying()) startPlayback();
  } else if (p.isPlaying()) {
    p.pause();
  }
  renderPlayState();
}

function startPlayback() {
  // Browsers may refuse to start without a tap; the watchdog below tells the user.
  Promise.resolve(app.player.play()).catch(() => {});
}

/** A local action: apply it here and tell the partner. */
function control(patch) {
  const p = app.player;
  if (!p) return;
  const state = { playing: app.base.playing, time: p.time(), rate: app.base.rate, ...patch };
  setBase(state);
  enforce(patch.seek === true);
  if (!app.conn?.send({ t: 'state', ...state })) {
    toast('Not connected. Your partner will not see this until you reconnect.', { kind: 'error' });
  }
}

function togglePlay() {
  const p = app.player;
  if (!p) return;
  if (p.ended()) control({ playing: true, time: 0, seek: true }); // replay
  else control({ playing: !p.isPlaying() });
}

function skip(delta) {
  const p = app.player;
  if (!p) return;
  const d = p.duration();
  const t = Math.max(0, p.time() + delta);
  control({ time: d ? Math.min(t, d) : t, seek: true });
}

// Periodic drift correction + "autoplay was blocked" detection.
setInterval(() => {
  const p = app.player;
  if (!p || document.hidden || p.ended()) return;

  if (app.base.playing && !p.isPlaying() && !app.buffering) {
    if (++app.stuck === 2) toast('Playback is paused on this device. Press play to join in.', { ms: 5000 });
  } else {
    app.stuck = 0;
  }
  if (!app.buffering && now() - app.lastCorrection > COOLDOWN_MS) enforce(false);
}, SYNC_MS);

/* =====================================================================
 * Loading a source
 * ===================================================================== */

async function load(src, { autoplay }) {
  app.loadAbort?.abort(); // cancels a load that is still in flight
  const abort = (app.loadAbort = new AbortController());
  app.player?.destroy();
  app.player = null;
  app.src = src;
  app.buffering = false;
  app.stuck = 0;
  app.base = { playing: false, time: 0, rate: 1, at: now() };

  ui.ql.hidden = true;
  ui.ql.replaceChildren();
  ui.bar.value = 0;
  ui.tm.textContent = '0:00 / 0:00';
  setBusy(true);
  renderPlayState();

  // Ignore events from a player that has since been replaced.
  const live = (fn) => (...args) => { if (abort === app.loadAbort) fn(...args); };
  const handlers = {
    onBuffering: live((on) => { app.buffering = on; setBusy(on); }),
    onEnded: live(renderPlayState),
    onError: live((err) => toast(err.message, { kind: 'error' })),
    onQualities: live(fillQualities),
  };

  try {
    const player = await createPlayer(src, { ytHost: ui.mw, video: ui.video, handlers }, abort.signal);
    app.player = player;
    setBusy(false);
    applyAudio();
    if (autoplay) control({ playing: true, time: 0, seek: true });
    else enforce(true);
    poke();
  } catch (err) {
    if (err.name === 'AbortError' || abort !== app.loadAbort) return;
    setBusy(false);
    app.src = null;
    toast(err.message || 'Could not load that video.', { kind: 'error', ms: 6000 });
    openSource();
  }
}

function setBusy(on) {
  ui.stage.classList.toggle('busy', on);
}

function fillQualities(levels) {
  if (!levels?.length) return;
  ui.ql.replaceChildren(...levels.map((q) => new Option(QUALITY_LABELS[q] || q, q)));
  ui.ql.hidden = false;
}
ui.ql.addEventListener('change', () => app.player?.setQuality?.(ui.ql.value)); // personal, never shared

/* =====================================================================
 * Rendering
 * ===================================================================== */

function renderStatus() {
  let state;
  let text;
  if (app.status !== 'online') {
    state = app.everOnline ? 'bad' : 'wait';
    text = app.everOnline ? 'Reconnecting…' : 'Connecting…';
  } else if (app.peers < 2) {
    state = 'wait';
    text = 'Waiting for your partner';
  } else {
    state = 'ok';
    text = 'Partner connected';
  }
  ui.status.dataset.state = state;
  ui.statusText.textContent = text;
}

function renderPlayState() {
  const playing = !!app.player && app.player.isPlaying();
  setIcon(ui.pp, playing ? 'pause' : 'play');
  ui.pp.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  ui.sp.value = String(app.base.rate);
}

function renderVolume() {
  const silent = app.muted || app.volume === 0;
  setIcon(ui.mute, silent ? 'mute' : 'volume');
  ui.mute.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  ui.vol.value = String(app.muted ? 0 : app.volume);
}

function applyAudio() {
  app.player?.setVolume(app.volume);
  app.player?.setMuted(app.muted);
  renderVolume();
}

// Seek bar and clock
setInterval(() => {
  const p = app.player;
  if (!p || document.hidden) return;
  renderPlayState();
  if (app.scrubbing) return;
  const d = p.duration();
  const t = p.time();
  ui.bar.value = d ? String(Math.round((t / d) * 1000)) : '0';
  ui.tm.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
}, 250);

/* =====================================================================
 * Controls
 * ===================================================================== */

let idleTimer = 0;
/** Show the controls and schedule them to fade while a video is playing. */
function poke() {
  ui.stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const busy = $('ctl').matches(':hover') || !ui.sd.hidden || chat.isComposing();
    if (app.base.playing && !busy) ui.stage.classList.add('idle');
  }, IDLE_MS);
}
function toggleChrome() {
  if (ui.stage.classList.contains('idle')) poke();
  else ui.stage.classList.add('idle');
}
$('ctl').addEventListener('pointerdown', poke);
ui.stage.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') poke(); });

ui.pp.addEventListener('click', togglePlay);
ui.sp.addEventListener('change', () => control({ rate: Number(ui.sp.value) })); // speed is shared

ui.bar.addEventListener('input', () => {
  app.scrubbing = true;
  const d = app.player?.duration() || 0;
  ui.tm.textContent = `${fmtTime((ui.bar.value / 1000) * d)} / ${fmtTime(d)}`;
});
ui.bar.addEventListener('change', () => {
  const p = app.player;
  if (p) control({ time: (ui.bar.value / 1000) * p.duration(), seek: true });
  app.scrubbing = false;
});

// Volume is personal: it is never sent to your partner.
function persistAudio() {
  local.set('wt.volume', String(app.volume));
  local.set('wt.muted', app.muted ? '1' : '0');
}
function setVolume(v) {
  app.volume = clampVolume(v);
  app.muted = app.volume === 0;
  persistAudio();
  applyAudio();
}
function toggleMute() {
  app.muted = !app.muted;
  if (!app.muted && app.volume === 0) app.volume = 0.5;
  persistAudio();
  applyAudio();
}
ui.mute.addEventListener('click', toggleMute);
ui.vol.addEventListener('input', () => setVolume(Number(ui.vol.value)));

// Touch: double-tap left/right to skip, single tap shows/hides controls.
// Mouse: single click toggles play/pause, double click on a side skips.
const isMouse = (e) => (e.pointerType ? e.pointerType === 'mouse' : !coarse);
let lastTap = { at: 0, side: 0, timer: 0 };

function onZoneTap(side, zone, e) {
  clearTimeout(lastTap.timer);
  const t = Date.now();
  if (t - lastTap.at < DOUBLE_TAP_MS && lastTap.side === side) {
    lastTap.at = 0;
    skip(side * SEEK_STEP);
    const fx = document.createElement('div');
    fx.className = 'fx';
    fx.textContent = side < 0 ? '« 10s' : '10s »';
    zone.append(fx);
    setTimeout(() => fx.remove(), 600);
    return;
  }
  const mouse = isMouse(e);
  lastTap = { at: t, side, timer: setTimeout(() => (mouse ? togglePlay() : toggleChrome()), DOUBLE_TAP_MS) };
}
$('zl').addEventListener('click', (e) => onZoneTap(-1, $('zl'), e));
$('zr').addEventListener('click', (e) => onZoneTap(1, $('zr'), e));
$('zt').addEventListener('click', (e) => { if (!isMouse(e)) chat.openCompose(); }); // bottom quarter opens the keyboard
$('wr').addEventListener('click', () => chat.openCompose());

/* =====================================================================
 * Invite
 * ===================================================================== */

$('invite').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(app.room)}`;
  if (navigator.share && coarse) {
    try {
      await navigator.share({ title: 'Watch Together', text: 'Join me in this room', url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  if (await copyText(url)) toast('Invite link copied');
  else toast(url, { ms: 8000 });
});

/* =====================================================================
 * Choose a video
 * ===================================================================== */

let returnFocus = null;

function openSource() {
  returnFocus = document.activeElement;
  ui.sd.hidden = false;
  setSourceMessage('');
  renderHint();
  poke();
  if (!coarse) ui.yu.focus(); // on phones this would pop the keyboard open uninvited
}
function closeSource() {
  if (ui.sd.hidden) return;
  ui.sd.hidden = true;
  if (returnFocus?.isConnected) returnFocus.focus?.();
}

function setSourceMessage(text, isError = false) {
  ui.sMsg.textContent = text;
  ui.sMsg.className = isError ? 'msg error' : 'msg';
  ui.sMsg.hidden = !text;
}

function renderHint() {
  ui.hint.textContent =
    `Uploads: ${limits.extensions.join(', ')}, up to ${fmtBytes(limits.maxUploadBytes)}. ` +
    'MP4 (H.264) plays on almost every device.';
}

function parseYouTube(text) {
  const value = text.trim();
  return value.match(YT_LINK_RE)?.[1] || (YT_ID_RE.test(value) ? value : null);
}

/** Tell the room about a new source, then start it here. */
function startSource(src) {
  if (!app.conn?.send({ t: 'src', s: src })) {
    setSourceMessage('Not connected. Try again in a moment.', true);
    return;
  }
  closeSource();
  load(src, { autoplay: true });
}

$('src').addEventListener('click', openSource);
$('sdClose').addEventListener('click', closeSource);
ui.sd.addEventListener('click', (e) => { if (e.target === ui.sd) closeSource(); });

$('ytForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = parseYouTube(ui.yu.value);
  if (!id) return setSourceMessage('That is not a YouTube link. Paste the full address of a video.', true);
  ui.yu.value = '';
  startSource({ k: 'yt', id });
});

// The upload button is a <label>; make it reachable and usable from the keyboard too.
ui.pick.tabIndex = 0;
ui.pick.setAttribute('role', 'button');
ui.pick.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.fi.click(); }
});
ui.fi.addEventListener('change', () => {
  const file = ui.fi.files[0];
  ui.fi.value = ''; // lets the same file be chosen again
  if (file) upload(file);
});
$('upCancel').addEventListener('click', () => app.upload?.abort());

function setUploading(on, loaded = 0, total = 0) {
  ui.upRow.hidden = !on;
  ui.pick.setAttribute('aria-disabled', String(on));
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  ui.upBar.value = pct;
  ui.upText.textContent = total ? `Uploading ${pct}% (${fmtBytes(loaded)} of ${fmtBytes(total)})` : 'Uploading…';
}

function upload(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!limits.extensions.includes(ext)) return setSourceMessage(`Choose a ${limits.extensions.join(', ')} file.`, true);
  if (file.size > limits.maxUploadBytes) {
    return setSourceMessage(`That file is ${fmtBytes(file.size)}. The limit is ${fmtBytes(limits.maxUploadBytes)}.`, true);
  }
  if (app.status !== 'online') return setSourceMessage('Not connected. Try again in a moment.', true);

  setSourceMessage('');
  setUploading(true);
  const xhr = new XMLHttpRequest();
  app.upload = xhr;
  xhr.open('POST', `/upload?ext=${encodeURIComponent(ext)}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploading(true, e.loaded, e.total); };
  xhr.onload = () => {
    app.upload = null;
    setUploading(false);
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
    if (xhr.status === 200 && body.url) startSource({ k: 'file', u: body.url });
    else setSourceMessage(body.error || `Upload failed (error ${xhr.status}).`, true);
  };
  xhr.onerror = () => {
    app.upload = null;
    setUploading(false);
    setSourceMessage('Upload failed. Check your connection and try again.', true);
  };
  xhr.onabort = () => {
    app.upload = null;
    setUploading(false);
    setSourceMessage('Upload cancelled.');
  };
  xhr.send(file);
}

fetch('/api/config')
  .then((r) => (r.ok ? r.json() : null))
  .then((config) => { if (config) { limits = config; renderHint(); } })
  .catch(() => { /* defaults are fine */ });

/* =====================================================================
 * Keyboard shortcuts (desktop)
 * ===================================================================== */

document.addEventListener('keydown', (e) => {
  if (!app.room || e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Escape') {
    if (!ui.sd.hidden) closeSource();
    else if (ui.stage.classList.contains('chat')) chat.togglePanel();
    return;
  }

  const target = e.target;
  if (target.closest('input, select, textarea') || !ui.sd.hidden) return;
  const onButton = !!target.closest('button, [role="button"]');

  switch (e.key) {
    case ' ':
    case 'k':
      if (onButton) return; // let the focused button handle its own activation
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
    case 'j':
      e.preventDefault();
      skip(-SEEK_STEP);
      break;
    case 'ArrowRight':
    case 'l':
      e.preventDefault();
      skip(SEEK_STEP);
      break;
    case 'ArrowUp':
      e.preventDefault();
      setVolume((app.muted ? 0 : app.volume) + 0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setVolume((app.muted ? 0 : app.volume) - 0.05);
      break;
    case 'm': toggleMute(); break;
    case 'f': toggleFullscreen(); break;
    case 'c': chat.togglePanel(); break;
    case 't':
      e.preventDefault(); // keeps the letter out of the message box
      chat.openCompose();
      break;
    default: return;
  }
  poke();
});
