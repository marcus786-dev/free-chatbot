// The chat itself: login, models, the message list, streaming replies, message actions and the composer.

const CHAT_URL = SUPABASE_URL + '/functions/v1/chat';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
// "auto" lets the server pick a free model (and switch if one is busy).
const AUTO = 'auto';
// Classifiers that can't chat; never offered.
const NOT_CHAT = /(safety|guard|moderation)/i;
// On a website (not a double-clicked file) email links can come straight back to this page.
const HOSTED = location.protocol === 'https:' || location.protocol === 'http:';
// Phones: Return adds a new line and the Send button sends.
const IS_TOUCH = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const MAX_INPUT = 8000;

let messages = [];        // this chat's messages: { id, role, content, model, feedback, meta }
let sessionId = null;     // current conversation id (chat_sessions.id / chat_messages.session_id)
let currentUserId = null;
let controller = null;    // AbortController while a reply is streaming
let autoModel = null;     // model Auto used last, so a conversation keeps the same model
let assignedModels = [];  // extra models the admin gave this user, on top of every free model
let removedFreeModels = [];   // free models the admin took away from this user
let toolModels = new Set();   // model ids that support tool calling
let webGrant = null;      // { daily_limit } when the admin allowed web search for this user
let webOn = false;        // the 🌐 button for the next message
let signUpMode = false;
let toolNoteShown = false;
let saveChain = Promise.resolve();

class ChatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

applySettings();

// ---------- startup ----------

// iPhone: size the app to the visible area so the keyboard never hides the header or composer.
function fitViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const stick = isNearBottom();
  root.style.setProperty('--app-height', (vv ? vv.height : window.innerHeight) + 'px');
  root.classList.toggle('kb', !!vv && window.innerHeight - vv.height > 120);
  if (vv) window.scrollTo(0, 0);
  if (stick) scrollToBottom();
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
fitViewport();

// A confirmation link that failed (e.g. expired) comes back with the reason in the URL.
const linkError = new URLSearchParams(location.hash.slice(1)).get('error_description');
if (linkError) {
  setLoginMessage(linkError + ' ' + t('login_link_failed'), 'error');
  history.replaceState(null, '', location.pathname);
}

if (!sb) {
  $('loading').textContent = t('supabase_failed');
  throw new Error('supabase-js failed to load');
}

// Fires once on load (INITIAL_SESSION) and on every login, logout and token refresh.
// Supabase calls must not be awaited inside this callback, so defer the work.
sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => showFor(session), 0);
});

async function showFor(session) {
  $('loading').hidden = true;
  const user = session?.user ?? null;

  if (!user) {
    // Supabase can repeat "signed out" events; don't wipe a half-typed password.
    if (currentUserId === null && !$('login-view').hidden) return;
    currentUserId = null;
    sessionId = null;
    controller?.abort();
    sessions = [];
    customSkills = [];
    webGrant = null;
    webOn = false;
    currentSkillId = null;
    assignedModels = [];
    removedFreeModels = [];
    clearPersonalSettings();
    clearChat();
    closeMenu();
    setDrawer(false);
    $('chat-view').hidden = true;
    $('login-view').hidden = false;
    $('password').value = '';
    $('email').focus();
    return;
  }

  if (user.id === currentUserId) return;  // token refresh, nothing to redraw
  currentUserId = user.id;
  $('login-view').hidden = true;
  $('chat-view').hidden = false;
  $('user-email').textContent = user.email ?? '';
  $('user-email').title = user.email ?? '';
  $('admin-link').hidden = true;
  // Ask the server for the current user record: the admin flag can be newer than the saved session.
  sb.auth.getUser().then(({ data }) => {
    $('admin-link').hidden = data.user?.app_metadata?.is_admin !== true;
  });

  await loadAccountSettings();
  Promise.all([Store.assignedModels(), Store.removedFreeModels().catch(() => [])]).then(([assigned, removed]) => {
    assignedModels = (assigned ?? []).map((r) => r.model);
    removedFreeModels = (removed ?? []).map((r) => r.model);
    loadModels();
  }).catch(() => {});
  Store.features().then((rows) => {
    const web = (rows ?? []).find((r) => r.feature === 'web_search');
    webGrant = web ? { daily_limit: web.daily_limit } : null;
    updateWebToggle();
    renderToolsTab();
  }).catch(() => {});
  loadCustomSkills();

  sessionsReady = refreshSessions();
  await sessionsReady;
  if (settings.openLast && sessions.length) await openSession(sessions[0].id);
  else startNewChat();
  if (!isDrawerMode()) $('input').focus();
}

// ---------- login ----------

function setMode(signUp) {
  signUpMode = signUp;
  $('login-submit').textContent = t(signUp ? 'signup' : 'login');
  $('login-subtitle').textContent = t(signUp ? 'login_sub_signup' : 'login_sub_login');
  $('toggle-text').textContent = t(signUp ? 'have_account' : 'no_account');
  $('mode-toggle').textContent = t(signUp ? 'login' : 'create_account');
  $('password').autocomplete = signUp ? 'new-password' : 'current-password';
  $('login-submit').disabled = false;
  setLoginMessage('');
}
document.addEventListener('langchange', () => setMode(signUpMode));

// The admin can close sign-ups; say so before someone makes an account that can't chat.
async function checkSignupsOpen() {
  const data = await Store.appSettings().catch(() => null);
  if (signUpMode && data?.signups_closed_at) {
    setLoginMessage(t('err_signups_closed'), 'error');
    $('login-submit').disabled = true;
  }
}

function setLoginMessage(text, kind = 'info') {
  const el = $('login-message');
  el.textContent = text;
  el.className = 'message ' + kind;
}

function friendlyAuthError(err) {
  const code = err?.code ?? '';
  const msg = err?.message ?? String(err);
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return t('err_wrong_credentials');
  if (code === 'email_not_confirmed' || /not confirmed/i.test(msg)) return t('err_not_confirmed');
  if (code === 'user_already_exists' || /already registered/i.test(msg)) return t('err_already_exists');
  if (code === 'signup_disabled' || /signups not allowed/i.test(msg)) return t('err_signup_disabled');
  if (err?.status === 429 || /rate limit|too many/i.test(msg)) return t('err_too_many_attempts');
  return msg;
}

$('mode-toggle').addEventListener('click', () => {
  setMode(!signUpMode);
  if (signUpMode) checkSignupsOpen();
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) return setLoginMessage(t('err_enter_both'), 'error');
  if (signUpMode && password.length < 6) return setLoginMessage(t('err_password_short'), 'error');

  setLoginMessage('');
  $('login-submit').disabled = true;
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: HOSTED ? { emailRedirectTo: location.origin + location.pathname } : undefined,
      });
      if (error) throw error;
      if (!data.session) {
        setMode(false);
        setLoginMessage(t(HOSTED ? 'signup_check_email_hosted' : 'signup_check_email_file'));
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    setLoginMessage(friendlyAuthError(err), 'error');
  } finally {
    $('login-submit').disabled = false;
  }
});

$('logout').addEventListener('click', () => sb.auth.signOut());

// ---------- free models ----------

// Everyone gets the free models, except any the admin removed. Models the admin assigned (paid ones too) come on top.
function filterModels(list, assigned, removed = []) {
  const isChat = (m) => {
    const out = m.architecture?.output_modalities;
    return !Array.isArray(out) || out.includes('text');
  };
  return (list ?? [])
    .filter((m) => typeof m?.id === 'string' && isChat(m))
    .filter((m) => assigned.includes(m.id) || (m.id.endsWith(':free') && !NOT_CHAT.test(m.id) && !removed.includes(m.id)))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

function formatContext(n) {
  if (!n) return '? ctx';
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M ctx` : `${Math.round(n / 1000)}K ctx`;
}

const autoLabel = () => t(assignedModels.length ? 'auto_label_assigned' : 'auto_label_free');

// A model can use tools if OpenRouter lists "tools" among its supported parameters.
// If the list hasn't loaded we can't tell, so we let the server decide.
const toolCapable = (id) => id === AUTO || toolModels.size === 0 || toolModels.has(id);

// Auto is always available (the server keeps its own list); specific models are added once loaded.
async function loadModels() {
  const select = $('model');
  const wanted = select.value || settings.model || AUTO;
  select.replaceChildren(new Option(autoLabel(), AUTO));
  $('retry-models').hidden = true;

  try {
    const res = await fetch(MODELS_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const models = filterModels((await res.json()).data, assignedModels, removedFreeModels);
    toolModels = new Set(models.filter((m) => m.supported_parameters?.includes('tools')).map((m) => m.id));
    select.append(...models.map((m) => new Option(
      `${toolModels.has(m.id) ? '🛠 ' : ''}${m.name || m.id} · ${formatContext(m.context_length)}${m.id.endsWith(':free') ? '' : ' · paid'}`, m.id)));
  } catch {
    $('retry-models').hidden = false;  // Auto still works; Retry loads the specific models
  }
  select.value = [...select.options].some((o) => o.value === wanted) ? wanted : AUTO;
  updateSendState();
  document.dispatchEvent(new Event('modelsloaded'));
}

// Picks a model in the top bar without changing the saved default (used by skills).
function preferModel(id) {
  const select = $('model');
  if ([...select.options].some((o) => o.value === id)) select.value = id;
  updateSendState();
}
function applyDefaultModel() {
  preferModel(settings.model || AUTO);
}

$('model').addEventListener('change', (e) => setSetting('model', e.target.value));
$('retry-models').addEventListener('click', loadModels);
document.addEventListener('langchange', () => {
  const first = $('model').options[0];
  if (first) first.textContent = autoLabel();
});

// ---------- chat rendering ----------

const WELCOME_SKILLS = ['builtin:translator', 'builtin:code', 'builtin:teacher', 'builtin:writing'];

function buildWelcome() {
  const skill = findSkill(currentSkillId);
  const box = h('div', { class: 'empty' },
    h('div', { class: 'empty-emoji', 'aria-hidden': 'true', text: skill ? skill.emoji : '✨' }),
    h('strong', { text: skill ? t('welcome_skill', { name: skill.name }) : t('welcome_title') }),
    h('div', { class: 'sub', text: skill ? skill.description : t('welcome_sub') }));
  if (!skill) {
    box.append(h('div', { class: 'suggest-grid' }, WELCOME_SKILLS.map((id) => findSkill(id)).filter(Boolean).map((s) =>
      h('button', { type: 'button', class: 'suggest', onclick: () => startChatWithSkill(s.id) },
        h('span', { class: 'em', text: s.emoji }), h('b', { text: s.name }), h('small', { text: s.description })))));
  }
  box.append(h('div', { class: 'prompt-chips' }, [1, 2, 3, 4].map((n) =>
    h('button', { type: 'button', text: t('example_' + n), onclick: () => send(t('example_' + n)) }))));
  return box;
}

function updateWelcome() {
  const empty = $('thread')?.querySelector('.empty');
  if (empty && !messages.length) empty.replaceWith(buildWelcome());
}
document.addEventListener('langchange', updateWelcome);

function clearChat() {
  messages = [];
  toolNoteShown = false;
  $('thread').replaceChildren(buildWelcome());
}

function isNearBottom() {
  const el = $('messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom() {
  const el = $('messages');
  el.scrollTop = el.scrollHeight;
}

// Parts of a message row are kept in this order however they are created.
const PART_ORDER = ['tool-chips', 'bubble', 'sources', 'caption', 'actions'];
function ensurePart(row, cls) {
  let el = row.querySelector(':scope > .' + cls);
  if (el) return el;
  el = h('div', { class: cls });
  const rank = PART_ORDER.indexOf(cls);
  const next = [...row.children].find((c) => PART_ORDER.findIndex((p) => c.classList.contains(p)) > rank);
  row.insertBefore(el, next ?? null);
  return el;
}

function messageCaption(item) {
  if (item.role !== 'assistant' || !item.model) return '';
  return item.model + (item.meta?.stopped ? ' · ' + t('stopped') : '');
}

function setCaption(row, text) {
  if (!text) return row.querySelector(':scope > .caption')?.remove();
  ensurePart(row, 'caption').textContent = text;
}

// Adds a message to the thread. Assistant text is rendered as markdown.
function addMessage(item, { thinking = false } = {}) {
  $('thread').querySelector('.empty')?.remove();
  const row = h('div', { class: 'msg ' + item.role });
  row._item = item;
  const bubble = ensurePart(row, 'bubble');
  bubble.className = 'bubble';
  if (thinking) {
    bubble.textContent = t('thinking');
    bubble.classList.add('thinking');
  } else if (item.role === 'assistant') {
    renderInto(bubble, item.content);
  } else {
    bubble.textContent = item.content;
  }
  $('thread').append(row);
  if (!thinking) {
    if (item.meta?.tools?.length) for (const tool of item.meta.tools) setToolChip(row, tool.name, 'done', tool.name);
    if (item.meta?.sources?.length) renderSources(row, item.meta.sources);
    setCaption(row, messageCaption(item));
    buildActions(row);
    refreshRegen();
  }
  return { row, bubble };
}

function rowFor(item) {
  return [...$('thread').querySelectorAll('.msg')].find((r) => r._item === item) ?? null;
}

function showNote(text, kind = 'error') {
  $('thread').querySelector('.empty')?.remove();
  const note = h('div', { class: 'note ' + kind, text });
  $('thread').append(note);
  scrollToBottom();
}

// ----- tool chips and sources -----

const TOOL_ICONS = { calculator: '🧮', datetime: '🕒', read_url: '📄', wikipedia: '📚', web_search: '🌐' };

function setToolChip(row, key, status, name) {
  const wrap = ensurePart(row, 'tool-chips');
  let chip = [...wrap.children].find((c) => c.dataset.key === key);
  if (!chip) {
    chip = h('span', { class: 'tool-chip', dataset: { key } });
    wrap.append(chip);
  }
  const known = name in TOOL_ICONS;
  const icon = TOOL_ICONS[name] ?? '⚙️';
  const label = known ? t('chip_' + name + '_' + (status === 'running' ? 'run' : 'done')) : name;
  chip.textContent = `${icon} ${label}`;
  chip.className = 'tool-chip' + (status === 'running' ? ' running' : '') + (status === 'error' ? ' err' : '');
  if (status === 'error') chip.textContent = `${icon} ${t('chip_failed', { name: known ? t('tool_' + name) : name })}`;
}

function renderSources(row, sources) {
  const box = ensurePart(row, 'sources');
  const safe = sources.filter((s) => /^https?:\/\//i.test(s.url));
  if (!safe.length) return box.remove();
  box.replaceChildren(
    h('strong', { text: t('sources') }),
    h('ol', {}, safe.map((s) => {
      let host = s.url;
      try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch {}
      return h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title || host }), ' ', h('span', { class: 'muted', text: host }));
    })));
}

// ----- per-message actions -----

let speakingButton = null;

function buildActions(row) {
  const item = row._item;
  const bar = ensurePart(row, 'actions');
  const btn = (icon, label, run, extra = {}) => h('button', { type: 'button', title: label, 'aria-label': label, text: icon, onclick: run, ...extra });
  const buttons = [btn('📋', t('copy'), async () => flash((await copyText(item.content)) ? t('copied') : t('action_failed')))];
  if (item.role === 'user') {
    buttons.push(btn('✏️', t('edit_resend'), () => startEdit(row)));
  } else {
    buttons.push(
      btn('🔄', t('regenerate'), regenerate, { class: 'regen' }),
      btn('🔊', t('read_aloud'), (e) => toggleSpeak(item, e.currentTarget), { 'aria-pressed': 'false' }),
      btn('👍', t('good_reply'), () => setMessageFeedback(item, 1, bar), { dataset: { fb: '1' }, 'aria-pressed': String(item.feedback === 1) }),
      btn('👎', t('bad_reply'), () => setMessageFeedback(item, -1, bar), { dataset: { fb: '-1' }, 'aria-pressed': String(item.feedback === -1) }));
  }
  bar.replaceChildren(...buttons);
}

// Only the newest reply can be regenerated.
function refreshRegen() {
  const rows = [...$('thread').querySelectorAll('.msg.assistant')];
  const last = rows.at(-1);
  for (const r of rows) r.querySelector('.regen')?.toggleAttribute('hidden', r !== last);
}

document.addEventListener('langchange', () => {
  for (const row of $('thread').querySelectorAll('.msg')) if (row._item && row.querySelector('.actions')) buildActions(row);
  refreshRegen();
});

// On phones there is no hover, so a tap on a message shows its actions.
$('thread').addEventListener('click', (e) => {
  if (!window.matchMedia('(hover: none)').matches) return;
  const row = e.target.closest('.msg');
  if (!row || e.target.closest('button, a, textarea')) return;
  const on = !row.classList.contains('show-actions');
  $('thread').querySelectorAll('.show-actions').forEach((r) => r.classList.remove('show-actions'));
  row.classList.toggle('show-actions', on);
});

function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/[*_~]/g, '');
}

function toggleSpeak(item, button) {
  if (!('speechSynthesis' in window)) return flash(t('tts_unsupported'));
  const wasThis = speakingButton === button;
  speechSynthesis.cancel();
  speakingButton?.setAttribute('aria-pressed', 'false');
  speakingButton = null;
  if (wasThis) return;
  const utterance = new SpeechSynthesisUtterance(stripMarkdown(item.content));
  utterance.lang = currentLang === 'da' ? 'da-DK' : 'en-US';
  const done = () => { button.setAttribute('aria-pressed', 'false'); if (speakingButton === button) speakingButton = null; };
  utterance.onend = done;
  utterance.onerror = done;
  speakingButton = button;
  button.setAttribute('aria-pressed', 'true');
  speechSynthesis.speak(utterance);
}

async function setMessageFeedback(item, value, bar) {
  const next = item.feedback === value ? null : value;
  await flushSaves();
  if (!item.id) return flash(t('action_failed'));
  try {
    await Store.setFeedback(item.id, next);
    item.feedback = next;
    bar.querySelectorAll('[data-fb]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.fb) === next)));
  } catch {
    flash(t('action_failed'));
  }
}

async function regenerate() {
  if (controller) return;
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return;
  messages.pop();
  rowFor(last)?.remove();
  refreshRegen();
  await send(null, { regenerate: true, replaced: last });
}

// Edit a user message in place; sending hides it and everything after it, then asks again.
function startEdit(row) {
  if (controller) return;
  const item = row._item;
  const bubble = row.querySelector('.bubble');
  const area = h('textarea', { value: item.content, 'aria-label': t('edit_resend'), maxlength: MAX_INPUT });
  const cancel = () => { row.classList.remove('editing'); box.replaceWith(bubble); row.querySelector('.actions').hidden = false; };
  const box = h('div', { class: 'edit-box' }, area,
    h('div', { class: 'btns' },
      h('button', { type: 'button', text: t('cancel'), onclick: cancel }),
      h('button', { type: 'button', class: 'primary', text: t('send_edited'), onclick: () => commitEdit(row, area.value.trim()) })));
  row.classList.add('editing');
  row.querySelector('.actions').hidden = true;
  bubble.replaceWith(box);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  area.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } });
}

async function commitEdit(row, text) {
  const item = row._item;
  if (!text || controller) return;
  try {
    await flushSaves();
    const from = messages.indexOf(item);
    if (from === -1) return;
    await Store.hideMessages(messages.slice(from).map((m) => m.id).filter(Boolean));
    messages.splice(from);
    while (row.nextSibling) row.nextSibling.remove();
    row.remove();
    refreshRegen();
  } catch {
    return flash(t('action_failed'));
  }
  send(text);
}

// ---------- opening and starting chats ----------

async function openSession(sid) {
  controller?.abort();
  clearChat();
  sessionId = sid;
  webOn = false;
  updateWebToggle();
  const session = sessions.find((s) => s.id === sid);
  setCurrentSkill(session?.skill ?? null, { persist: false });
  updateHeader();
  renderChatList();
  let rows;
  try {
    rows = await Store.messages(sid);
  } catch {
    return showNote(t('err_load_chat'), 'warn');
  }
  if (sid !== sessionId) return;   // the user already moved on
  for (const r of rows) {
    const item = { id: r.id, role: r.role, content: r.content, model: r.model, feedback: r.feedback, meta: r.meta };
    messages.push(item);
    addMessage(item);
  }
  autoModel = rows.filter((r) => r.role === 'assistant' && r.model).at(-1)?.model ?? null;
  if (!rows.length) $('thread').replaceChildren(buildWelcome());
  scrollToBottom();
  renderToolsTab();
}

function startNewChat() {
  controller?.abort();
  clearChat();
  sessionId = newId();
  autoModel = null;
  webOn = false;
  updateWebToggle();
  setCurrentSkill(null, { persist: false });
  applyDefaultModel();
  updateHeader();
  renderChatList();
  renderToolsTab();
  $('input').focus();
}

// ---------- saving ----------

// Saves are queued, so two quick turns can't swap order. Anything that needs a message id waits on this.
function flushSaves() {
  return saveChain;
}

function saveTurn(sid, userItem, asstItem, { skill = null, replaced = null } = {}) {
  const job = async () => {
    try {
      if (!sessions.some((s) => s.id === sid)) {
        await Store.upsertSession({ id: sid, title: (userItem?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null, skill });
      }
      const rows = [];
      if (userItem) rows.push({ session_id: sid, role: 'user', content: userItem.content });
      rows.push({ session_id: sid, role: 'assistant', content: asstItem.content, model: asstItem.model, meta: asstItem.meta ?? null });
      const inserted = await Store.insertMessages(rows);
      const ids = Object.fromEntries(inserted.map((r) => [r.role, r.id]));
      if (userItem) userItem.id = ids.user;
      asstItem.id = ids.assistant;
      if (replaced?.id) await Store.hideMessages([replaced.id]);
      await refreshSessions();
    } catch {
      if (sid === sessionId) showNote(t('err_save'), 'warn');
    }
  };
  saveChain = saveChain.then(job, job);
  return saveChain;
}

// ---------- sending and streaming ----------

async function readErrorMessage(res) {
  try {
    const body = await res.json();
    return body?.error?.message || body?.message || body?.msg || res.statusText;
  } catch {
    return res.statusText || `Request failed (${res.status}).`;
  }
}

function friendlyChatError(err) {
  if (err instanceof ChatError) {
    if (err.status === 401) return t('err_session_expired');
    if (/web search/i.test(err.message)) return err.status === 429 ? t('err_web_limit') : t('err_web_denied');
    if (err.status === 429) {
      if (/per-day|per day/i.test(err.message)) return t('err_daily_limit');
      if (/per-min/i.test(err.message)) return t('err_minute_limit');
      return t('err_busy');
    }
    if (err.status === 402) return t('err_negative_balance');
    return err.message || t('err_request_failed', { status: err.status });
  }
  return t('err_network');
}

function setStreaming(on) {
  $('send').textContent = on ? '■' : '➤';
  $('send').setAttribute('aria-label', t(on ? 'stop' : 'send'));
  updateSendState();
  renderToolsTab();
}

function updateSendState() {
  $('send').disabled = !controller && !$('model').value;
}

// The hidden instruction sent with every message: skill + what the user told us about themselves.
function buildSystem() {
  const skill = findSkill(currentSkillId);
  const parts = [];
  if (skill?.instructions) parts.push(skill.instructions);
  if (settings.aboutYou.trim()) parts.push('About the user:\n' + settings.aboutYou.trim());
  if (settings.instructions.trim()) parts.push('How the user wants you to answer:\n' + settings.instructions.trim());
  if (settings.replyLength === 'short') parts.push('Keep answers short and to the point unless asked for more.');
  if (settings.replyLength === 'detailed') parts.push('Give thorough, detailed answers.');
  return parts.join('\n\n');
}

function activeTools() {
  const skill = findSkill(currentSkillId);
  return AI_TOOLS.map((tool) => tool.id).filter((id) => settings.tools[id] || skill?.tools?.includes(id));
}

// Pulls url_citation annotations out of a streamed chunk (OpenRouter's web search results).
function collectSources(delta, sources) {
  for (const a of delta?.annotations ?? []) {
    const c = a?.url_citation;
    if (a?.type === 'url_citation' && c?.url && !sources.some((s) => s.url === c.url)) sources.push({ url: c.url, title: c.title || '' });
  }
}

async function send(text, { regenerate = false, replaced = null } = {}) {
  const model = $('model').value;
  if (!model || controller) return;
  const list = messages;   // this chat's list; a later "New chat" swaps `messages` but not this one
  const userItem = regenerate ? list.at(-1) : { role: 'user', content: text };
  if (!userItem || (!regenerate && !text)) return;
  text = userItem.content;

  const sid = sessionId;
  const skillAtSend = currentSkillId;
  if (!regenerate) {
    list.push(userItem);
    addMessage(userItem);
  }
  const asstItem = { role: 'assistant', content: '', model, meta: {} };
  const { row, bubble } = addMessage(asstItem, { thinking: true });
  scrollToBottom();

  const tools = activeTools();
  const useTools = tools.length > 0 && toolCapable(model);
  if (tools.length && !useTools && !toolNoteShown) {
    toolNoteShown = true;
    showNote(t('tools_off_model'), 'warn');
  }
  const useWeb = webOn && !!webGrant;
  webOn = false;
  updateWebToggle();

  controller = new AbortController();
  setStreaming(true);

  let reply = '';
  let usedModel = model;
  let errorText = null;
  let aborted = false;
  const sources = [];
  const toolsUsed = [];
  const runningChips = new Map();   // tool chips still showing "…"
  const finishRunningChips = () => {
    for (const [key, name] of runningChips) setToolChip(row, key, 'done', name);
    runningChips.clear();
  };

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new ChatError(401, 'Not logged in.');

    const system = buildSystem();
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + session.access_token,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prefer: model === AUTO ? autoModel : undefined,
        messages: list.map((m) => ({ role: m.role, content: m.content })),
        system: system || undefined,
        temperature: settings.temperature ?? undefined,
        tools: useTools ? tools : undefined,
        web: useWeb || undefined,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new ChatError(res.status, await readErrorMessage(res));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    read: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;  // blank lines and ": OPENROUTER PROCESSING" comments

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          reader.cancel().catch(() => {});
          break read;
        }

        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.error) throw new ChatError(chunk.error.code, chunk.error.message);

        if (chunk.tool_event) {
          const ev = chunk.tool_event;
          const key = ev.id ?? ev.name;
          setToolChip(row, key, ev.status, ev.name);
          if (ev.status === 'running') runningChips.set(key, ev.name); else runningChips.delete(key);
          if (!toolsUsed.some((x) => x.name === ev.name)) toolsUsed.push({ name: ev.name });
          if (sid === sessionId && isNearBottom()) scrollToBottom();
          continue;
        }
        if (chunk.model) usedModel = chunk.model;

        const delta = chunk.choices?.[0]?.delta;
        collectSources(delta, sources);
        collectSources(chunk.choices?.[0]?.message, sources);
        if (delta?.content) {
          const stick = isNearBottom();
          if (!reply) {
            bubble.classList.remove('thinking');
            finishRunningChips();
          }
          reply += delta.content;
          renderInto(bubble, reply);
          if (stick) scrollToBottom();
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') aborted = true;
    else errorText = friendlyChatError(err);
  } finally {
    controller = null;
    setStreaming(false);
    finishRunningChips();
  }

  asstItem.content = reply;
  asstItem.model = usedModel;
  asstItem.meta = {
    ...(toolsUsed.length ? { tools: toolsUsed } : {}),
    ...(sources.length ? { sources } : {}),
    ...(skillAtSend ? { skill: skillAtSend } : {}),
    ...(aborted ? { stopped: true } : {}),
  };
  if (!Object.keys(asstItem.meta).length) asstItem.meta = null;

  // "New chat" or logout happened while streaming: keep the old chat's record, leave the screen alone.
  if (sid !== sessionId) {
    if (reply && currentUserId) saveTurn(sid, regenerate ? null : userItem, asstItem, { skill: skillAtSend, replaced });
    return;
  }

  if (reply) {
    list.push(asstItem);
    if (model === AUTO) autoModel = usedModel;
    bubble.classList.remove('thinking');
    setCaption(row, (model === AUTO ? t('auto') + ' · ' : '') + messageCaption(asstItem));
    row._item = asstItem;
    if (sources.length) renderSources(row, sources);
    buildActions(row);
    refreshRegen();
    if (errorText) showNote(errorText);
    saveTurn(sid, regenerate ? null : userItem, asstItem, { skill: skillAtSend, replaced });
  } else {
    // Nothing arrived: undo the turn and give the text back so it can be resent.
    row.remove();
    if (regenerate && replaced) {
      list.push(replaced);
      addMessage(replaced);
    } else {
      list.pop();
      $('thread').querySelectorAll('.msg.user').forEach((r) => { if (r._item === userItem) r.remove(); });
      if (!list.length) $('thread').replaceChildren(buildWelcome());
      $('input').value = text;
      autosize();
    }
    if (!aborted) showNote(errorText ?? t('err_empty_reply'));
  }
  renderToolsTab();
  $('input').focus();
}

function sendSummary() {
  if (!controller) send(t('summarize_prompt'));
}

// ---------- composer ----------

function autosize() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight + 2, 200) + 'px';
  const len = el.value.length;
  const counter = $('char-count');
  counter.textContent = len >= MAX_INPUT * 0.8 ? `${len.toLocaleString(currentLang)} / ${MAX_INPUT.toLocaleString(currentLang)}` : '';
  counter.classList.toggle('over', len >= MAX_INPUT);
}

$('input').addEventListener('input', autosize);

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && controller) { e.stopPropagation(); controller.abort(); return; }
  if (e.key !== 'Enter' || e.isComposing) return;
  const plainEnter = settings.sendOnEnter && !e.shiftKey && !IS_TOUCH;
  const modEnter = !settings.sendOnEnter && (e.ctrlKey || e.metaKey) && !IS_TOUCH;
  if (plainEnter || modEnter) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (controller) {
    controller.abort();
    return;
  }
  const text = $('input').value.trim();
  if (!text || !$('model').value) return;
  $('input').value = '';
  autosize();
  send(text);
});

// 🌐 web search: only shown to users the admin has allowed.
function updateWebToggle() {
  const btn = $('web-toggle');
  btn.hidden = !webGrant;
  btn.setAttribute('aria-pressed', String(webOn));
  btn.title = t('web_toggle_tip');
  btn.setAttribute('aria-label', t('web_toggle_tip'));
}
$('web-toggle').addEventListener('click', () => { webOn = !webOn; updateWebToggle(); $('input').focus(); });
document.addEventListener('langchange', updateWebToggle);

// 🎤 voice input (hidden where the browser can't do it)
{
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('mic');
  let rec = null;
  if (!Recognition) mic.hidden = true;
  mic.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new Recognition();
    rec.lang = currentLang === 'da' ? 'da-DK' : 'en-US';
    rec.interimResults = true;
    const base = $('input').value;
    rec.onresult = (e) => {
      const spoken = [...e.results].map((r) => r[0].transcript).join(' ');
      $('input').value = (base ? base + ' ' : '') + spoken;
      autosize();
    };
    const finish = () => { rec = null; mic.classList.remove('listening'); mic.setAttribute('aria-pressed', 'false'); };
    rec.onend = finish;
    rec.onerror = (e) => { finish(); if (e.error === 'not-allowed') flash(t('mic_denied')); };
    mic.classList.add('listening');
    mic.setAttribute('aria-pressed', 'true');
    try { rec.start(); } catch { finish(); }
  });
}

// ---------- keyboard shortcuts ----------

const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('.menu')) closeMenu();
    else closeDrawer();
    return;
  }
  if ($('chat-view').hidden || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.shiftKey && !e.altKey && key === 'k') { e.preventDefault(); focusSearch(); }
  else if (mod && e.shiftKey && key === 'o') { e.preventDefault(); startNewChat(); }
  else if (mod && !e.shiftKey && key === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (mod && key === ',') { e.preventDefault(); openSettings(); }
  else if (mod && e.shiftKey && key === 'c' && !window.getSelection()?.toString()) {
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (last) { e.preventDefault(); copyText(last.content).then((ok) => flash(ok ? t('copied') : t('action_failed'))); }
  } else if (e.key === '/' && !mod && !e.altKey && !isTyping(e.target)) { e.preventDefault(); $('input').focus(); }
});

// ---------- go ----------

document.addEventListener('langchange', () => { setStreaming(!!controller); });
setMode(false);
clearChat();
loadModels();
