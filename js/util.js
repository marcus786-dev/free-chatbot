// Small helpers shared by every script. Loaded first; no other file is needed to run these.

const $ = (id) => document.getElementById(id);

// Tiny DOM builder. Text always goes in through textContent / text nodes, never as HTML.
//   h('button', { class: 'x', onclick: fn, 'aria-label': 'Close' }, '✕')
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list' && key !== 'form' && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function loadSetting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function saveSetting(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function newId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0;top:0' });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

function downloadFile(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeFileName(s, fallback = 'chat') {
  const cleaned = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned || fallback;
}

// Short floating message ("Copied ✓").
function flash(text) {
  document.querySelectorAll('.toast-note').forEach((n) => n.remove());
  const n = h('div', { class: 'toast-note', role: 'status', text });
  document.body.append(n);
  setTimeout(() => n.remove(), 1800);
}

// Keeps Tab inside `container` while it is open (used by the mobile drawer; <dialog> traps focus itself).
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function trapTab(e, container) {
  if (e.key !== 'Tab') return;
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// Puts <mark> around every match of `query` inside `text`, as DOM nodes (no innerHTML).
function highlight(text, query) {
  const q = (query || '').trim();
  if (!q) return [document.createTextNode(text)];
  const out = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let pos = 0;
  let at;
  while ((at = lower.indexOf(needle, pos)) !== -1) {
    if (at > pos) out.push(document.createTextNode(text.slice(pos, at)));
    out.push(h('mark', { text: text.slice(at, at + needle.length) }));
    pos = at + needle.length;
  }
  if (pos < text.length) out.push(document.createTextNode(text.slice(pos)));
  return out;
}
