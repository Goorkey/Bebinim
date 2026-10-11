/**
 * WebSocket connection with automatic reconnect.
 *  - exponential backoff with jitter, reset after a successful join
 *  - reconnects immediately when the tab becomes visible or the network returns
 *  - application-level ping so half-open connections are noticed
 */

const FATAL = {
  4001: 'This room already has two people.',
  4002: 'This room was opened in another tab.',
  4003: 'That room code is not valid.',
};

const PING_MS = 15_000;
const SILENT_LIMIT_MS = 40_000;

export class Connection {
  #ws = null;
  #room = '';
  #cid = '';
  #attempt = 0;
  #retry = 0;
  #watchdog = 0;
  #lastSeen = 0;
  #stopped = true;

  /**
   * @param {object} handlers
   * @param {(msg: object) => void} handlers.onMessage
   * @param {(status: 'connecting'|'online'|'offline') => void} handlers.onStatus
   * @param {(reason: string) => void} handlers.onFatal
   */
  constructor({ onMessage, onStatus, onFatal }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onFatal = onFatal;
    this.reconnectNow = this.reconnectNow.bind(this);
  }

  open(room, cid) {
    this.#room = room;
    this.#cid = cid;
    this.#stopped = false;
    document.addEventListener('visibilitychange', this.reconnectNow);
    window.addEventListener('online', this.reconnectNow);
    this.#connect();
  }

  close() {
    this.#stopped = true;
    document.removeEventListener('visibilitychange', this.reconnectNow);
    window.removeEventListener('online', this.reconnectNow);
    clearTimeout(this.#retry);
    clearInterval(this.#watchdog);
    const ws = this.#ws;
    this.#ws = null;
    if (ws) { ws.onclose = ws.onmessage = null; ws.close(); }
  }

  /** @returns {boolean} true if the message was handed to an open socket */
  send(message) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  /** Skip the backoff wait when the user comes back to the tab or the network returns. */
  reconnectNow() {
    if (this.#stopped || document.visibilityState === 'hidden') return;
    if (this.#ws && this.#ws.readyState <= WebSocket.OPEN) return; // still connecting or open
    clearTimeout(this.#retry);
    this.#attempt = 0;
    this.#connect();
  }

  #connect() {
    clearTimeout(this.#retry);
    this.onStatus('connecting');

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = `room=${encodeURIComponent(this.#room)}&cid=${encodeURIComponent(this.#cid)}`;
    const ws = new WebSocket(`${scheme}//${location.host}/ws?${query}`);
    this.#ws = ws;

    ws.onopen = () => {
      this.#lastSeen = Date.now();
      clearInterval(this.#watchdog);
      this.#watchdog = setInterval(() => this.#check(), PING_MS);
    };

    ws.onmessage = (event) => {
      this.#lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'pong') return;
      if (msg.t === 'hello') {
        this.#attempt = 0;
        this.onStatus('online');
      }
      this.onMessage(msg);
    };

    ws.onclose = (event) => {
      if (ws !== this.#ws) return;
      clearInterval(this.#watchdog);
      if (FATAL[event.code]) {
        this.#stopped = true;
        this.onFatal(FATAL[event.code]);
        return;
      }
      if (!this.#stopped) this.#scheduleRetry();
    };
  }

  #check() {
    if (Date.now() - this.#lastSeen > SILENT_LIMIT_MS) {
      // The socket looks open but nothing has arrived: treat it as dead.
      const dead = this.#ws;
      if (dead) { dead.onclose = dead.onmessage = null; dead.close(); }
      clearInterval(this.#watchdog);
      this.#scheduleRetry();
      return;
    }
    this.send({ t: 'ping' });
  }

  #scheduleRetry() {
    this.onStatus('offline');
    const base = Math.min(15_000, 1000 * 2 ** this.#attempt++);
    this.#retry = setTimeout(() => this.#connect(), base * (0.8 + Math.random() * 0.4));
  }
}
