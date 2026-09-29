// Sidebar: layout and drawer behaviour, the Chats tab (list, search, per-chat menu), the Tools tab,
// the chat title in the top bar, and exporting.

let sessions = [];                 // chat_sessions rows that aren't deleted, newest first
let sessionsReady = Promise.resolve();
let sidebarTab = 'chats';
let searchQuery = '';
let searchHits = new Map();        // session id -> message snippet, from searching message text

const SIDEBAR_KEY = 'chat_sidebar_collapsed';
const drawerQuery = window.matchMedia('(max-width: 899px)');
const isDrawerMode = () => drawerQuery.matches;

function sessionsLoaded() { return sessionsReady; }
const currentSession = () => sessions.find((s) => s.id === sessionId) ?? null;

async function refreshSessions() {
  try { sessions = await Store.sessions(); } catch { /* keep what we had */ }
  renderChatList();
  updateHeader();
}

// ---------- sidebar shell ----------

function setDrawer(open) {
  const app = $('chat-view');
  app.classList.toggle('drawer-open', open);
  $('backdrop').hidden = !open;
  $('sb-open').setAttribute('aria-expanded', String(open));
  if (open) $('new-chat').focus();
}
function openDrawer() { setDrawer(true); }
function closeDrawer() {
  if (isDrawerMode() && $('chat-view').classList.contains('drawer-open')) {
    setDrawer(false);
    $('sb-open').focus();
  }
}

function setCollapsed(collapsed) {
  $('chat-view').classList.toggle('collapsed', collapsed);
  saveSetting(SIDEBAR_KEY, collapsed ? '1' : '0');
  $('sb-open').setAttribute('aria-expanded', String(!collapsed));
}

function toggleSidebar() {
  if (isDrawerMode()) {
    if ($('chat-view').classList.contains('drawer-open')) closeDrawer(); else openDrawer();
  } else {
    const collapsed = !$('chat-view').classList.contains('collapsed');
    setCollapsed(collapsed);
    (collapsed ? $('sb-open') : $('new-chat')).focus();
  }
}

$('sb-open').addEventListener('click', () => {
  if (isDrawerMode()) openDrawer(); else setCollapsed(false);
});
$('sb-collapse').addEventListener('click', () => {
  if (isDrawerMode()) closeDrawer(); else { setCollapsed(true); $('sb-open').focus(); }
});
$('backdrop').addEventListener('click', closeDrawer);
$('sidebar').addEventListener('keydown', (e) => {
  if (isDrawerMode() && $('chat-view').classList.contains('drawer-open')) trapTab(e, $('sidebar'));
});
drawerQuery.addEventListener('change', () => {
  setDrawer(false);
  $('sb-open').setAttribute('aria-expanded', String(!isDrawerMode() && !$('chat-view').classList.contains('collapsed')));
});
if (loadSetting(SIDEBAR_KEY) === '1') $('chat-view').classList.add('collapsed');
$('sb-open').setAttribute('aria-expanded', String(!isDrawerMode() && !$('chat-view').classList.contains('collapsed')));

// Swipe left to close the drawer, swipe right from the left edge to open it.
{
  let start = null;
  document.addEventListener('touchstart', (e) => {
    const p = e.touches[0];
    start = e.touches.length === 1 ? { x: p.clientX, y: p.clientY } : null;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!start || !isDrawerMode() || $('chat-view').hidden) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - start.x;
    const dy = Math.abs(p.clientY - start.y);
    const open = $('chat-view').classList.contains('drawer-open');
    if (open && dx < -60 && dy < 50) closeDrawer();
    else if (!open && start.x < 24 && dx > 70 && dy < 50) openDrawer();
    start = null;
  }, { passive: true });
}

// ---------- tabs ----------

const TABS = ['chats', 'skills', 'tools'];

function selectTab(name, focus = false) {
  sidebarTab = name;
  for (const id of TABS) {
    const selected = id === name;
    const tab = $('tab-btn-' + id);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $('tab-' + id).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  if (name === 'tools') renderToolsTab();
}
for (const id of TABS) {
  $('tab-btn-' + id).addEventListener('click', () => selectTab(id));
  $('tab-btn-' + id).addEventListener('keydown', (e) => {
    const i = TABS.indexOf(id);
    const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(TABS[next], true);
  });
}

// ---------- context menu ----------

function closeMenu() {
  document.querySelector('.menu')?.remove();
  document.querySelectorAll('.menu-open').forEach((el) => el.classList.remove('menu-open'));
}

function openMenu(anchor, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.map((item) => (item === '-'
      ? h('hr')
      : h('button', {
          type: 'button', role: 'menuitem', class: 'plain' + (item.danger ? ' danger' : ''), text: item.label,
          onclick: () => { closeMenu(); item.run(); },
        }))));
  document.body.append(menu);
  anchor.closest('.chat-item, .card-item')?.classList.add('menu-open');
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  menu.style.top = (r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4) + 'px';
  menu.querySelector('button')?.focus();
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i + buttons.length - 1) % buttons.length].focus(); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus(); }
    else if (e.key === 'Tab') closeMenu();
  });
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('.chat-more')) closeMenu();
});

// ---------- chats list ----------

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupSessions(list) {
  const today = dayStart(new Date());
  const day = 86400000;
  const groups = [
    { key: 'group_pinned', items: [] }, { key: 'group_today', items: [] }, { key: 'group_yesterday', items: [] },
    { key: 'group_week', items: [] }, { key: 'group_older', items: [] },
  ];
  for (const s of list) {
    const at = dayStart(new Date(s.updated_at));
    const g = s.pinned ? 0 : at >= today ? 1 : at >= today - day ? 2 : at >= today - 7 * day ? 3 : 4;
    groups[g].items.push(s);
  }
  return groups.filter((g) => g.items.length);
}

function snippetAround(text, query) {
  const flat = text.replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return flat.slice(0, 80);
  const from = Math.max(0, at - 24);
  return (from > 0 ? '…' : '') + flat.slice(from, at + query.length + 56);
}

function chatItem(s, snippet) {
  const current = s.id === sessionId;
  const title = s.title || t('untitled');
  const open = h('button', {
    type: 'button', class: 'plain chat-open', 'aria-current': current ? 'true' : null,
    onclick: () => { closeMenu(); openSessionFromList(s.id); },
  },
    h('span', { class: 'ttl' }, s.pinned ? h('span', { class: 'pin', 'aria-hidden': 'true', text: '📌' }) : null, ...highlight(title, searchQuery)),
    snippet ? h('span', { class: 'snippet' }, ...highlight(snippet, searchQuery)) : null);
  const more = h('button', {
    type: 'button', class: 'plain chat-more', 'aria-haspopup': 'menu', 'aria-label': t('chat_options', { title }), text: '⋯',
    onclick: (e) => openMenu(e.currentTarget, [
      { label: '✏️ ' + t('rename'), run: () => renameInList(s.id) },
      { label: (s.pinned ? '📍 ' + t('unpin') : '📌 ' + t('pin')), run: () => togglePin(s) },
      '-',
      { label: '⬇ ' + t('export_md'), run: () => exportSession(s, 'md') },
      { label: '🖨 ' + t('export_pdf'), run: () => exportSession(s, 'pdf') },
      '-',
      { label: '🗑 ' + t('delete'), danger: true, run: () => deleteChat(s) },
    ]),
  });
  return h('div', { class: 'chat-item' + (current ? ' current' : ''), dataset: { id: s.id } }, open, more);
}

function renderChatList() {
  const box = $('chat-list');
  if (!box) return;
  const q = searchQuery.toLowerCase();
  let list = sessions;
  if (q) list = sessions.filter((s) => (s.title || '').toLowerCase().includes(q) || searchHits.has(s.id));

  if (!list.length) {
    box.replaceChildren(h('div', { class: 'sb-empty', text: q ? t('search_none') : t('chats_none') }));
    return;
  }
  if (q) {
    box.replaceChildren(...list.map((s) => chatItem(s, (s.title || '').toLowerCase().includes(q) ? null : searchHits.get(s.id))));
    return;
  }
  box.replaceChildren(...groupSessions(list).flatMap((g) => [
    h('div', { class: 'group-label', text: t(g.key) }),
    ...g.items.map((s) => chatItem(s)),
  ]));
}

async function openSessionFromList(sid) {
  closeDrawer();
  if (sid === sessionId) return;
  controller?.abort();
  await openSession(sid);
}

function renameInList(sid) {
  const s = sessions.find((x) => x.id === sid);
  const item = document.querySelector(`.chat-item[data-id="${sid}"]`);
  if (!s || !item) return;
  const input = h('input', { type: 'text', class: 'rename-input', value: s.title || '', maxlength: 120, 'aria-label': t('rename') });
  const finish = async (save) => {
    input.onblur = null;
    if (save && input.value.trim() && input.value.trim() !== s.title) await renameSession(sid, input.value.trim());
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  input.onblur = () => finish(true);
  item.replaceChildren(input);
  input.focus();
  input.select();
}

async function renameSession(sid, title) {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) return;
  try {
    await Store.updateSession(sid, { title: clean });
    const s = sessions.find((x) => x.id === sid);
    if (s) s.title = clean;
    renderChatList();
    updateHeader();
  } catch {
    flash(t('action_failed'));
  }
}

async function togglePin(s) {
  try {
    await Store.updateSession(s.id, { pinned: !s.pinned });
    s.pinned = !s.pinned;
    renderChatList();
  } catch {
    flash(t('action_failed'));
  }
}

async function deleteChat(s) {
  if (!confirm(t('confirm_delete_chat', { title: s.title || t('untitled') }))) return;
  try {
    if (s.id === sessionId) controller?.abort();
    await flushSaves();
    await Store.deleteSession(s.id);
    sessions = sessions.filter((x) => x.id !== s.id);
    if (s.id === sessionId) startNewChat();
    renderChatList();
  } catch {
    flash(t('action_failed'));
  }
}

// ---------- search ----------

const searchMessagesSoon = debounce(async (q) => {
  if (q.length < 2) return;
  try {
    const rows = await Store.searchMessages(q);
    if (q !== searchQuery) return;             // the user kept typing
    searchHits = new Map();
    for (const r of rows) if (!searchHits.has(r.session_id)) searchHits.set(r.session_id, snippetAround(r.content, q));
    // Only chats the user can still see.
    for (const id of [...searchHits.keys()]) if (!sessions.some((s) => s.id === id)) searchHits.delete(id);
    renderChatList();
  } catch { /* title matches still work */ }
}, 350);

$('search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  searchHits = new Map();
  if (searchQuery && sidebarTab !== 'chats') selectTab('chats');
  renderChatList();
  if (searchQuery) searchMessagesSoon(searchQuery);
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('search').value) {
    e.stopPropagation();
    $('search').value = '';
    $('search').dispatchEvent(new Event('input'));
  }
});

function focusSearch() {
  if (isDrawerMode()) openDrawer(); else if ($('chat-view').classList.contains('collapsed')) setCollapsed(false);
  selectTab('chats');
  $('search').focus();
  $('search').select();
}

// ---------- the chat title in the top bar ----------

function updateHeader() {
  const s = currentSession();
  const title = $('chat-title');
  title.textContent = s?.title || t('new_chat_title');
  title.classList.toggle('editable', !!s);
  title.title = s ? t('rename') : '';
  document.title = s?.title ? `${s.title} · Free Chatbot` : 'Free Chatbot';
}

$('chat-title').addEventListener('click', () => {
  const s = currentSession();
  if (!s) return;
  const title = $('chat-title');
  const input = h('input', { type: 'text', id: 'title-input', value: s.title || '', maxlength: 120, 'aria-label': t('rename') });
  const finish = async (save) => {
    input.onblur = null;
    input.replaceWith(title);
    if (save && input.value.trim() && input.value.trim() !== s.title) await renameSession(s.id, input.value.trim());
    else updateHeader();
    title.focus?.();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  input.onblur = () => finish(true);
  title.replaceWith(input);
  input.focus();
  input.select();
});
$('chat-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.currentTarget.click(); });

// ---------- export ----------

function chatToMarkdown(title, msgs, createdAt) {
  const when = createdAt ? formatDateTime(createdAt) : '';
  const parts = [`# ${title}`, when ? `_${when}_` : ''].filter(Boolean);
  for (const m of msgs) {
    const who = m.role === 'user' ? t('you') : t('ai') + (m.model ? ` (${m.model})` : '');
    parts.push(`**${who}:**\n\n${m.content}`);
  }
  return parts.join('\n\n');
}

function chatToText(msgs) {
  return msgs.map((m) => `${m.role === 'user' ? t('you') : t('ai')}: ${m.content}`).join('\n\n');
}

function printChat(title, msgs, createdAt) {
  const area = $('print-area');
  area.replaceChildren(
    h('h1', { text: title }),
    h('div', { class: 'meta', text: createdAt ? formatDateTime(createdAt) : '' }),
    ...msgs.map((m) => {
      const body = h('div', { class: 'body' });
      if (m.role === 'assistant') body.innerHTML = renderMarkdown(m.content);
      else { body.style.whiteSpace = 'pre-wrap'; body.textContent = m.content; }
      return h('div', { class: 'pmsg ' + m.role }, h('div', { class: 'role', text: m.role === 'user' ? t('you') : t('ai') + (m.model ? ` · ${m.model}` : '') }), body);
    }));
  const cleanup = () => { document.body.classList.remove('printing'); area.replaceChildren(); };
  document.body.classList.add('printing');
  window.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => { if (document.body.classList.contains('printing')) cleanup(); }, 5 * 60_000);
  window.print();
}

async function exportSession(s, fmt) {
  try {
    await flushSaves();
    const msgs = await Store.messages(s.id);
    if (!msgs.length) return flash(t('nothing_to_export'));
    const title = s.title || t('untitled');
    if (fmt === 'pdf') printChat(title, msgs, s.created_at);
    else downloadFile(safeFileName(title) + '.md', chatToMarkdown(title, msgs, s.created_at), 'text/markdown');
  } catch {
    flash(t('action_failed'));
  }
}

// ---------- Tools tab ----------

function chatStats() {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const words = messages.reduce((n, m) => n + (m.content.match(/\S+/g)?.length ?? 0), 0);
  return { count: messages.length, words, tokens: Math.ceil(chars / 4) };
}

function renderToolsTab() {
  const box = $('tab-tools');
  if (!box || sidebarTab !== 'tools') return;
  const s = currentSession();
  const has = messages.length > 0 && !!s;
  const btn = (icon, label, run, disabled = !has) =>
    h('button', { type: 'button', class: 'plain tool-btn', disabled, onclick: () => { closeDrawer(); run(); } },
      h('span', { class: 'emoji', 'aria-hidden': 'true', text: icon }), h('span', { text: label }));
  const st = chatStats();
  const fmtN = (n) => n.toLocaleString(currentLang);
  box.replaceChildren(
    h('div', { class: 'group-label', text: t('tools_this_chat') }),
    btn('⬇', t('export_md'), () => exportSession(s, 'md')),
    btn('🖨', t('export_pdf'), () => exportSession(s, 'pdf')),
    btn('📋', t('copy_chat'), async () => flash((await copyText(chatToText(messages))) ? t('copied') : t('action_failed'))),
    btn('📝', t('summarize'), () => sendSummary(), !has || !!controller),
    h('div', { class: 'stats-box' },
      h('span', { text: t('stat_messages') }), h('b', { text: fmtN(st.count) }),
      h('span', { text: t('stat_words') }), h('b', { text: fmtN(st.words) }),
      h('span', { text: t('stat_tokens') }), h('b', { text: '≈ ' + fmtN(st.tokens) })),
    h('div', { class: 'group-label', text: t('tools_ai') }),
    ...AI_TOOLS.map((tool) => h('label', { class: 'switch-row' },
      h('span', { text: `${tool.icon} ${t('tool_' + tool.id)}` }),
      h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: settings.tools[tool.id], 'aria-label': t('tool_' + tool.id), onchange: (e) => setTool(tool.id, e.target.checked) }))),
    h('div', { class: 'section-actions' },
      h('button', { type: 'button', text: '⚙ ' + t('tools_more'), onclick: () => { closeDrawer(); openSettings('tools'); } })),
    h('div', { class: 'sb-empty', text: webGrant ? t('web_on', { n: webGrant.daily_limit }) : t('web_off') }),
  );
}

document.addEventListener('settingschange', () => renderToolsTab());
document.addEventListener('langchange', () => { renderChatList(); updateHeader(); renderToolsTab(); });

// ---------- start ----------

$('new-chat').addEventListener('click', () => { closeDrawer(); startNewChat(); });
selectTab('chats');
