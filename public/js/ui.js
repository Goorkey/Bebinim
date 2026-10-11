/* Small DOM and formatting helpers shared by every module. */

export const $ = (id) => document.getElementById(id);

/** 75 -> "1:15", 4000 -> "1:06:40" */
export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Swap the icon inside a button that contains <svg><use href="#i-..."/></svg>. */
export function setIcon(button, name) {
  button.querySelector('use').setAttribute('href', `#i-${name}`);
}

/** Short, non-blocking message at the top of the stage. */
export function toast(message, { kind = 'info', ms = 3500 } = {}) {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** Storage that never throws (private mode, blocked cookies, etc.). */
function safeStorage(getStore) {
  return {
    get(key) {
      try { return getStore().getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { getStore().setItem(key, value); } catch { /* ignore */ }
    },
  };
}
export const local = safeStorage(() => localStorage);
export const session = safeStorage(() => sessionStorage);

/** Copy text, falling back to execCommand so it also works on plain-HTTP LAN addresses. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'sprite';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    area.remove();
    return ok;
  }
}
