// Settings: defaults, applying them to the page, saving them to the account, and the settings dialog.
// They are kept in localStorage too, so theme, accent, text size and language apply before first paint.

const SETTINGS_KEY = 'chat_settings';
const APP_VERSION = '2.0.0';
const AI_TOOLS = [
  { id: 'calculator', icon: '🧮' },
  { id: 'datetime', icon: '🕒' },
  { id: 'read_url', icon: '📄' },
  { id: 'wikipedia', icon: '📚' },
];

const DEFAULT_SETTINGS = {
  language: 'auto',
  model: 'auto',
  sendOnEnter: true,
  showModel: true,
  openLast: true,
  theme: 'auto',
  accent: 'peach',
  font: 'nunito',
  textSize: 'm',
  density: 'comfortable',
  reduceMotion: false,
  aboutYou: '',
  instructions: '',
  replyLength: 'normal',
  temperature: null,        // null = the model's own default
  tools: { calculator: false, datetime: false, read_url: false, wikipedia: false },
};

const THEMES = [
  { id: 'auto', icon: '🌗' },
  { id: 'light', icon: '☀️' },
  { id: 'dark', icon: '🌙' },
];
const ACCENTS = [
  { id: 'peach', color: '#ff7a59' },
  { id: 'ocean', color: '#2f8fe0' },
  { id: 'forest', color: '#3f9a5a' },
  { id: 'grape', color: '#8b5cd6' },
  { id: 'mono', color: '#3d3d42' },
];
const FONTS = [
  { id: 'nunito', label: 'Nunito', css: '"Nunito"' },
  { id: 'inter', label: 'Inter', css: '"Inter"' },
  { id: 'lora', label: 'Lora (serif)', css: '"Lora", Georgia, serif' },
  { id: 'atkinson', label: 'Atkinson Hyperlegible', css: '"Atkinson Hyperlegible"' },
  { id: 'comic', label: 'Comic Neue', css: '"Comic Neue", "Comic Sans MS"' },
  { id: 'mono', label: 'Roboto Mono', css: '"Roboto Mono", ui-monospace, Consolas, monospace' },
  { id: 'system', label: 'System', css: 'system-ui' },
];

function readLocalSettings() {
  let saved = {};
  try { saved = JSON.parse(loadSetting(SETTINGS_KEY) || '{}') || {}; } catch {}
  // Older versions kept theme and font in their own keys.
  if (!saved.theme && loadSetting('chat_theme')) saved.theme = loadSetting('chat_theme');
  if (!saved.font && loadSetting('chat_font')) saved.font = loadSetting('chat_font');
  if (!saved.model && loadSetting('chat_model')) saved.model = loadSetting('chat_model');
  return mergeSettings(saved);
}

// Fills in anything missing, and drops anything that isn't a known key with a sane type.
function mergeSettings(saved) {
  const out = { ...DEFAULT_SETTINGS, tools: { ...DEFAULT_SETTINGS.tools } };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in (saved ?? {}))) continue;
    if (key === 'tools') {
      for (const id of Object.keys(DEFAULT_SETTINGS.tools)) out.tools[id] = saved.tools?.[id] === true;
    } else if (key === 'temperature') {
      out.temperature = typeof saved.temperature === 'number' ? Math.min(1.5, Math.max(0, saved.temperature)) : null;
    } else if (typeof saved[key] === typeof DEFAULT_SETTINGS[key]) {
      out[key] = saved[key];
    }
  }
  out.aboutYou = out.aboutYou.slice(0, 1500);
  out.instructions = out.instructions.slice(0, 1500);
  return out;
}

let settings = readLocalSettings();

function persistLocalSettings() {
  saveSetting(SETTINGS_KEY, JSON.stringify(settings));
  saveSetting('chat_theme', settings.theme);   // keeps the old key in step for cached copies of the page
}

// ---------- applying ----------

function resolveFont(id) {
  return FONTS.find((f) => f.id === id) || FONTS[0];
}

function applySettings() {
  const root = document.documentElement;
  window.applyTheme(settings.theme);
  root.dataset.accent = settings.accent;
  root.dataset.size = settings.textSize;
  root.dataset.density = settings.density;
  root.dataset.motion = settings.reduceMotion ? 'reduce' : 'normal';
  root.dataset.showmodel = settings.showModel ? '1' : '0';
  root.style.setProperty('--font', resolveFont(settings.font).css);
  setLanguage(resolveLanguage(settings.language));
  showTheme();
}

function showTheme() {
  const current = THEMES.find((x) => x.id === settings.theme) || THEMES[0];
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  const text = t('theme_tip', { current: t('theme_' + current.id), next: t('theme_' + next.id) });
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.textContent = current.icon;
    btn.title = text;
    btn.setAttribute('aria-label', text);
  }
}

function cycleTheme() {
  const i = THEMES.findIndex((x) => x.id === settings.theme);
  setSetting('theme', THEMES[(i + 1) % THEMES.length].id);
}

// ---------- saving ----------

const saveToAccount = debounce(async () => {
  if (!currentUserId) return;
  try {
    await Store.saveSettings(currentUserId, settings);
    flashSaved();
  } catch {
    flashSaved(true);
  }
}, 700);

function flashSaved(failed = false) {
  const el = $('saved-ind');
  if (!el) return;
  el.textContent = failed ? t('save_failed') : t('saved');
  el.classList.add('on');
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => el.classList.remove('on'), 1800);
}

function setSetting(key, value) {
  settings[key] = value;
  persistLocalSettings();
  applySettings();
  document.dispatchEvent(new CustomEvent('settingschange', { detail: { key } }));
  saveToAccount();
}

function setTool(id, on) {
  setSetting('tools', { ...settings.tools, [id]: on });
}

// On logout: keep how the page looks on this device, forget everything personal.
function clearPersonalSettings() {
  for (const key of ['model', 'sendOnEnter', 'showModel', 'openLast', 'aboutYou', 'instructions', 'replyLength', 'temperature']) {
    settings[key] = DEFAULT_SETTINGS[key];
  }
  settings.tools = { ...DEFAULT_SETTINGS.tools };
  persistLocalSettings();
  applySettings();
}

// Called after login: the account's settings win. A brand-new account keeps what this device had.
async function loadAccountSettings() {
  try {
    const remote = await Store.getSettings();
    if (remote && Object.keys(remote).length) {
      settings = mergeSettings(remote);
      persistLocalSettings();
      applySettings();
      document.dispatchEvent(new CustomEvent('settingschange', { detail: { key: '*' } }));
    } else {
      await Store.saveSettings(currentUserId, settings);
    }
  } catch {
    // offline or table missing: keep the local copy
  }
}

// ---------- the dialog ----------

const SETTINGS_SECTIONS = ['general', 'appearance', 'personal', 'tools', 'data', 'shortcuts', 'about'];
let settingsSection = 'general';

function openSettings(section) {
  if (section) settingsSection = section;
  renderSettings();
  const dlg = $('settings-dialog');
  if (!dlg.open) dlg.showModal();
}

function renderSettings() {
  const nav = $('set-nav');
  nav.replaceChildren(...SETTINGS_SECTIONS.map((id) =>
    h('button', {
      type: 'button',
      'aria-current': id === settingsSection ? 'true' : 'false',
      text: t('set_' + id),
      onclick: () => { settingsSection = id; renderSettings(); $('set-body').scrollTop = 0; },
    })));
  const builder = {
    general: sectionGeneral, appearance: sectionAppearance, personal: sectionPersonal,
    tools: sectionTools, data: sectionData, shortcuts: sectionShortcuts, about: sectionAbout,
  }[settingsSection];
  $('set-body').replaceChildren(h('h3', { text: t('set_' + settingsSection) }), ...builder());
}

function settingRow(label, sub, control, asLabel = true) {
  const text = h('div', {}, h('div', { class: 'lbl', text: label }), sub ? h('div', { class: 'sub', text: sub }) : null);
  return h(asLabel ? 'label' : 'div', { class: 'row-setting', role: asLabel ? null : 'group', 'aria-label': asLabel ? null : label }, text, control);
}

function switchControl(key, label) {
  return h('input', {
    type: 'checkbox', class: 'switch', role: 'switch', checked: !!settings[key], 'aria-label': label,
    onchange: (e) => setSetting(key, e.target.checked),
  });
}

function selectControl(key, options, onchange) {
  const select = h('select', { onchange: (e) => (onchange ?? ((v) => setSetting(key, v)))(e.target.value) },
    options.map((o) => h('option', { value: o.value, text: o.label })));
  select.value = String(settings[key]);
  return select;
}

function segControl(key, options) {
  const wrap = h('div', { class: 'seg' });
  const paint = () => wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(settings[key]))));
  for (const o of options) {
    wrap.append(h('button', {
      type: 'button', text: o.label, dataset: { value: o.value },
      onclick: () => { setSetting(key, o.value); paint(); },
    }));
  }
  paint();
  return wrap;
}

function sectionGeneral() {
  const modelOptions = [...$('model').options].map((o) => ({ value: o.value, label: o.textContent }));
  if (!modelOptions.some((o) => o.value === settings.model)) modelOptions.push({ value: settings.model, label: settings.model });
  return [
    settingRow(t('set_language'), t('set_language_sub'), selectControl('language', [
      { value: 'auto', label: t('lang_auto') }, { value: 'da', label: 'Dansk' }, { value: 'en', label: 'English' },
    ])),
    settingRow(t('set_default_model'), t('set_default_model_sub'), selectControl('model', modelOptions, (v) => {
      setSetting('model', v);
      applyDefaultModel();
    })),
    settingRow(t('set_enter'), t('set_enter_sub'), switchControl('sendOnEnter', t('set_enter'))),
    settingRow(t('set_showmodel'), t('set_showmodel_sub'), switchControl('showModel', t('set_showmodel'))),
    settingRow(t('set_openlast'), t('set_openlast_sub'), switchControl('openLast', t('set_openlast'))),
  ];
}

function sectionAppearance() {
  const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': t('set_accent') },
    ACCENTS.map((a) => h('button', {
      type: 'button', style: `--sw:${a.color}`, title: t('accent_' + a.id), 'aria-label': t('accent_' + a.id),
      'aria-pressed': String(settings.accent === a.id),
      onclick: (e) => {
        setSetting('accent', a.id);
        e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      },
    })));
  return [
    settingRow(t('set_theme'), null, segControl('theme', THEMES.map((x) => ({ value: x.id, label: x.icon + ' ' + t('theme_' + x.id) }))), false),
    settingRow(t('set_accent'), null, swatches, false),
    settingRow(t('set_font'), null, selectControl('font', FONTS.map((f) => ({ value: f.id, label: f.label })))),
    settingRow(t('set_textsize'), null, segControl('textSize', ['s', 'm', 'l', 'xl'].map((v) => ({ value: v, label: v.toUpperCase() }))), false),
    settingRow(t('set_density'), null, segControl('density', [
      { value: 'comfortable', label: t('density_comfortable') }, { value: 'compact', label: t('density_compact') },
    ]), false),
    settingRow(t('set_motion'), t('set_motion_sub'), switchControl('reduceMotion', t('set_motion'))),
  ];
}

function textareaSetting(key, label, sub, placeholder) {
  const counter = h('div', { class: 'counter', text: `${settings[key].length} / 1500` });
  const area = h('textarea', {
    maxlength: 1500, placeholder, 'aria-label': label, value: settings[key],
    oninput: (e) => { counter.textContent = `${e.target.value.length} / 1500`; setSetting(key, e.target.value); },
  });
  return h('div', { class: 'stack-setting' }, h('div', { class: 'lbl', text: label }), h('div', { class: 'sub', text: sub }), area, counter);
}

function sectionPersonal() {
  const value = h('span', { text: settings.temperature === null ? t('temp_default') : settings.temperature.toFixed(1) });
  const range = h('input', {
    type: 'range', min: 0, max: 1.5, step: 0.1, value: settings.temperature ?? 1, 'aria-label': t('set_creativity'),
    oninput: (e) => { value.textContent = Number(e.target.value).toFixed(1); },
    onchange: (e) => setSetting('temperature', Number(e.target.value)),
  });
  const reset = h('button', { type: 'button', class: 'link', text: t('temp_reset'), onclick: () => { setSetting('temperature', null); value.textContent = t('temp_default'); range.value = 1; } });
  return [
    textareaSetting('aboutYou', t('set_aboutyou'), t('set_aboutyou_sub'), t('set_aboutyou_ph')),
    textareaSetting('instructions', t('set_instructions'), t('set_instructions_sub'), t('set_instructions_ph')),
    settingRow(t('set_length'), null, segControl('replyLength', [
      { value: 'short', label: t('length_short') }, { value: 'normal', label: t('length_normal') }, { value: 'detailed', label: t('length_detailed') },
    ]), false),
    h('div', { class: 'stack-setting' },
      h('div', { class: 'row-setting' }, h('div', {}, h('div', { class: 'lbl', text: t('set_creativity') }), h('div', { class: 'sub', text: t('set_creativity_sub') })), h('div', {}, value, ' ', reset)),
      range),
  ];
}

function sectionTools() {
  const rows = AI_TOOLS.map((tool) => settingRow(
    `${tool.icon} ${t('tool_' + tool.id)}`, t('tool_' + tool.id + '_sub'),
    h('input', {
      type: 'checkbox', class: 'switch', role: 'switch', checked: settings.tools[tool.id], 'aria-label': t('tool_' + tool.id),
      onchange: (e) => setTool(tool.id, e.target.checked),
    })));
  const web = webGrant
    ? t('web_on', { n: webGrant.daily_limit })
    : t('web_off');
  return [
    h('p', { class: 'sub muted', text: t('tools_intro') }),
    ...rows,
    h('div', { class: 'row-setting' }, h('div', {}, h('div', { class: 'lbl', text: '🌐 ' + t('web_search') }), h('div', { class: 'sub', text: web }))),
    h('p', { class: 'sub muted', text: t('tools_models_note') }),
  ];
}

function sectionData() {
  const word = t('delete_word');
  const confirmInput = h('input', { type: 'text', placeholder: word, 'aria-label': t('delete_type', { word }), autocomplete: 'off' });
  const deleteBtn = h('button', { type: 'button', class: 'danger', disabled: true, text: t('delete_all') });
  confirmInput.addEventListener('input', () => { deleteBtn.disabled = confirmInput.value.trim().toLowerCase() !== word.toLowerCase(); });
  deleteBtn.addEventListener('click', async () => {
    deleteBtn.disabled = true;
    try {
      await Store.deleteAllChats();
      await refreshSessions();
      startNewChat();
      confirmInput.value = '';
      flash(t('deleted_all'));
    } catch {
      flash(t('action_failed'));
    }
  });
  return [
    h('div', { class: 'stack-setting' },
      h('div', { class: 'lbl', text: t('export_all') }), h('div', { class: 'sub', text: t('export_all_sub') }),
      h('div', { class: 'foot-row' },
        h('button', { type: 'button', text: '⬇ Markdown', onclick: () => exportAllChats('md') }),
        h('button', { type: 'button', text: '⬇ JSON', onclick: () => exportAllChats('json') }))),
    h('div', { class: 'stack-setting' },
      h('div', { class: 'lbl', text: t('delete_all') }), h('div', { class: 'sub', text: t('delete_all_sub') + ' ' + t('delete_type', { word }) }),
      h('div', { class: 'foot-row' }, confirmInput, deleteBtn)),
  ];
}

const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const SHORTCUTS = [
  [[MOD, 'K'], 'sc_search'], [[MOD, 'Shift', 'O'], 'sc_new'], [[MOD, 'B'], 'sc_sidebar'],
  [[MOD, ','], 'sc_settings'], [[MOD, 'Shift', 'C'], 'sc_copy'], [['/'], 'sc_focus'], [['Esc'], 'sc_close'],
  [['Enter'], 'sc_send'], [['Shift', 'Enter'], 'sc_newline'],
];

function sectionShortcuts() {
  const grid = h('div', { class: 'kbd-list' });
  for (const [keys, label] of SHORTCUTS) {
    grid.append(h('span', {}, keys.map((k, i) => [i ? ' + ' : '', h('kbd', { text: k })])), h('span', { text: t(label) }));
  }
  return [grid];
}

function sectionAbout() {
  return [
    h('div', { class: 'row-setting' }, h('div', {}, h('div', { class: 'lbl', text: 'Free Chatbot' }), h('div', { class: 'sub', text: t('about_version', { v: APP_VERSION }) }))),
    h('p', { text: t('about_privacy') }),
    h('p', { class: 'sub muted', text: t('about_deleted') }),
  ];
}

// ---------- export everything ----------

async function exportAllChats(fmt) {
  try {
    const [rows] = await Promise.all([Store.allMessages(), sessionsLoaded()]);
    const byChat = new Map();
    for (const m of rows) {
      if (!byChat.has(m.session_id)) byChat.set(m.session_id, []);
      byChat.get(m.session_id).push(m);
    }
    const chats = sessions
      .filter((s) => byChat.has(s.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((s) => ({ id: s.id, title: s.title || t('untitled'), created_at: s.created_at, messages: byChat.get(s.id) }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'json') {
      const data = chats.map((c) => ({ ...c, messages: c.messages.map(({ role, content, model, created_at }) => ({ role, content, model, created_at })) }));
      downloadFile(`chats-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
    } else {
      downloadFile(`chats-${stamp}.md`, chats.map((c) => chatToMarkdown(c.title, c.messages, c.created_at)).join('\n\n---\n\n'), 'text/markdown');
    }
  } catch {
    flash(t('action_failed'));
  }
}

$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('click', (e) => { if (e.target === $('settings-dialog')) $('settings-dialog').close(); });
$('open-settings').addEventListener('click', () => openSettings());
for (const btn of document.querySelectorAll('.theme-toggle')) btn.addEventListener('click', cycleTheme);
document.addEventListener('langchange', () => {
  showTheme();
  if ($('settings-dialog').open) renderSettings();
});
document.addEventListener('modelsloaded', () => {
  if ($('settings-dialog').open && settingsSection === 'general') renderSettings();
});

// Login screen: a quick DA / EN switch (shows the language you would switch to).
$('lang-toggle-login').addEventListener('click', () => setSetting('language', currentLang === 'da' ? 'en' : 'da'));
document.addEventListener('langchange', () => {
  $('lang-toggle-login').textContent = currentLang === 'da' ? 'EN' : 'DA';
});
