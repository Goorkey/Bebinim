/* Floating bubbles (7s), a history panel, and the message box. */

import { $ } from './ui.js';

const BUBBLE_MS = 7000;
const MAX_BUBBLES = 4;
const clock = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

/**
 * @param {object} opts
 * @param {HTMLElement} opts.stage
 * @param {(text: string) => boolean} opts.onSend  returns false if the message could not be sent
 */
export function createChat({ stage, onSend }) {
  const left = $('fL');
  const right = $('fR');
  const list = $('pl');
  const empty = $('pe');
  const bar = $('tb');
  const input = $('ti');
  const toggle = $('ci');

  function bubble(host, text) {
    const el = document.createElement('div');
    el.className = 'b';
    el.textContent = text;
    host.append(el); // newest sits at the bottom, older ones move up
    while (host.children.length > MAX_BUBBLES) host.firstElementChild.remove();
    setTimeout(() => el.remove(), BUBBLE_MS);
  }

  function add(text, mine, ts = Date.now()) {
    bubble(mine ? right : left, text);

    const when = Number.isFinite(ts) ? ts : Date.now();
    const row = document.createElement('div');
    row.className = mine ? 'pm me' : 'pm';
    const body = document.createElement('span');
    body.textContent = text;
    const time = document.createElement('time');
    time.dateTime = new Date(when).toISOString();
    time.textContent = clock.format(when);
    row.append(body, time);

    empty.hidden = true;
    list.append(row);
    list.scrollTop = list.scrollHeight;
  }

  function setPanel(open) {
    stage.classList.toggle('chat', open);
    toggle.setAttribute('aria-pressed', String(open));
    toggle.setAttribute('aria-label', open ? 'Hide chat history' : 'Show chat history');
    if (open) list.scrollTop = list.scrollHeight;
  }

  function openCompose() {
    bar.hidden = false;
    input.focus();
  }
  function closeCompose() {
    bar.hidden = true;
    input.blur();
  }

  input.addEventListener('blur', () => { bar.hidden = true; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeCompose(); return; }
    if (e.key !== 'Enter' || e.isComposing) return;
    const text = input.value.trim();
    if (text && onSend(text)) {
      add(text, true);
      input.value = '';
    }
  });

  toggle.addEventListener('click', () => setPanel(!stage.classList.contains('chat')));

  return {
    add,
    openCompose,
    closeCompose,
    togglePanel: () => setPanel(!stage.classList.contains('chat')),
    isComposing: () => !bar.hidden,
    reset() {
      left.replaceChildren();
      right.replaceChildren();
      list.replaceChildren();
      empty.hidden = false;
      input.value = '';
      bar.hidden = true;
      setPanel(false);
    },
  };
}
