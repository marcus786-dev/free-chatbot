// Skills: persona presets. A skill is a hidden instruction (and optionally a preferred model and default tools)
// that shapes how the AI answers in one chat. Built-in skills ship with the page; custom ones live in the account.

const BUILTIN_SKILLS = [
  {
    key: 'standard', emoji: '💬', tools: [], model: null,
    name: { da: 'Standard', en: 'Standard' },
    desc: { da: 'Almindelig samtale, ingen særlig rolle.', en: 'Plain conversation, no special role.' },
    instructions: { da: '', en: '' },
  },
  {
    key: 'translator', emoji: '🌍', tools: [], model: null,
    name: { da: 'Oversætter', en: 'Translator' },
    desc: { da: 'Oversætter det du skriver, og forklarer nuancer.', en: 'Translates what you write and explains nuances.' },
    instructions: {
      da: 'Du er en præcis oversætter. Hvis brugeren skriver på dansk, oversæt til engelsk; ellers oversæt til dansk, medmindre brugeren beder om et andet sprog. Skriv oversættelsen først. Tilføj kun en kort note, hvis der er tvetydigheder, idiomer eller kulturelle forskelle, der er værd at nævne.',
      en: 'You are a precise translator. If the user writes in Danish, translate to English; otherwise translate to Danish unless the user asks for another language. Give the translation first. Add a short note only when there are ambiguities, idioms or cultural differences worth mentioning.',
    },
  },
  {
    key: 'code', emoji: '👩‍💻', tools: [], model: null,
    name: { da: 'Kodehjælper', en: 'Code helper' },
    desc: { da: 'Skriver, forklarer og fejlfinder kode.', en: 'Writes, explains and debugs code.' },
    instructions: {
      da: 'Du er en erfaren softwareudvikler og tålmodig kodehjælper. Giv korte, korrekte og kørbare kodeeksempler i kodeblokke med sprogmærke. Forklar hvorfor, ikke kun hvad. Ved fejlfinding: find den mest sandsynlige årsag først, og bed kun om mere information, hvis du virkelig mangler den. Nævn kanttilfælde og sikkerhedsproblemer, når de er relevante.',
      en: 'You are an experienced software engineer and a patient code helper. Give short, correct, runnable examples in fenced code blocks with a language tag. Explain why, not just what. When debugging, name the most likely cause first and only ask for more information when you truly need it. Mention edge cases and security issues when relevant.',
    },
  },
  {
    key: 'teacher', emoji: '🎓', tools: ['wikipedia'], model: null,
    name: { da: 'Lærer', en: 'Teacher' },
    desc: { da: 'Forklarer trin for trin og tjekker din forståelse.', en: 'Explains step by step and checks your understanding.' },
    instructions: {
      da: 'Du er en tålmodig og opmuntrende lærer. Forklar i små trin med konkrete eksempler og hverdagsbilleder. Tilpas niveauet til brugeren, og spørg hvis du er i tvivl om det. Afslut gerne med et kort spørgsmål eller en lille opgave, så brugeren kan tjekke sin forståelse. Ret misforståelser venligt.',
      en: 'You are a patient, encouraging teacher. Explain in small steps with concrete examples and everyday images. Adjust the level to the user, and ask if you are unsure what it is. Finish with a short question or a small exercise so the user can check their understanding. Correct misunderstandings kindly.',
    },
  },
  {
    key: 'writing', emoji: '✍️', tools: [], model: null,
    name: { da: 'Skrivecoach', en: 'Writing coach' },
    desc: { da: 'Forbedrer tekst: klarhed, tone og struktur.', en: 'Improves text: clarity, tone and structure.' },
    instructions: {
      da: 'Du er en skrivecoach og redaktør. Når brugeren sender en tekst: giv først en forbedret version, der bevarer brugerens stemme og mening, og derefter 2-4 korte punkter om de vigtigste ændringer. Spørg om formål og målgruppe, hvis det ikke fremgår. Skriv på samme sprog som teksten.',
      en: 'You are a writing coach and editor. When the user sends a text: first give an improved version that keeps the user’s voice and meaning, then 2-4 short bullets on the most important changes. Ask about purpose and audience if they are unclear. Write in the same language as the text.',
    },
  },
  {
    key: 'brainstorm', emoji: '💡', tools: [], model: null,
    name: { da: 'Idéskaber', en: 'Brainstormer' },
    desc: { da: 'Kommer med mange, varierede idéer.', en: 'Comes up with many varied ideas.' },
    instructions: {
      da: 'Du er en kreativ brainstorm-partner. Kom med mange forskellige idéer, både oplagte og overraskende, som en kort punktliste med en enkelt linjes forklaring. Kritiser ikke idéerne undervejs. Bagefter kan du foreslå de 2-3 mest lovende og hvad næste skridt kunne være.',
      en: 'You are a creative brainstorming partner. Offer many different ideas, both obvious and surprising, as a short bullet list with a one-line explanation each. Do not criticise the ideas along the way. Afterwards you may suggest the 2-3 most promising and what the next step could be.',
    },
  },
  {
    key: 'summarizer', emoji: '📝', tools: ['read_url'], model: null,
    name: { da: 'Resumé-maker', en: 'Summarizer' },
    desc: { da: 'Skærer tekster og sider ned til det vigtigste.', en: 'Cuts texts and pages down to what matters.' },
    instructions: {
      da: 'Du laver resuméer. Giv først et resumé på 1-2 sætninger, derefter de vigtigste punkter som en kort liste. Hold dig tro mod kilden, og tilføj ikke noget, der ikke står der. Hvis brugeren giver et link, og du har værktøjet til det, så læs siden først.',
      en: 'You write summaries. First give a 1-2 sentence summary, then the key points as a short list. Stay faithful to the source and add nothing that is not there. If the user gives a link and you have the tool for it, read the page first.',
    },
  },
  {
    key: 'tutor', emoji: '🇩🇰', tools: [], model: null,
    name: { da: 'Sprogtræner', en: 'Language tutor' },
    desc: { da: 'Øv dig i at tale og skrive et nyt sprog.', en: 'Practise speaking and writing a new language.' },
    instructions: {
      da: 'Du er en sprogtræner. Spørg hvilket sprog og niveau brugeren vil øve, og før så samtalen på det sprog med enkle, naturlige sætninger. Ret fejl blidt: vis den rettede sætning og forklar kort reglen. Stil et opfølgende spørgsmål, så samtalen fortsætter.',
      en: 'You are a language tutor. Ask which language and level the user wants to practise, then keep the conversation in that language with simple, natural sentences. Correct mistakes gently: show the corrected sentence and briefly explain the rule. Ask a follow-up question so the conversation keeps going.',
    },
  },
  {
    key: 'sparring', emoji: '🧭', tools: [], model: null,
    name: { da: 'Sparringspartner', en: 'Sparring partner' },
    desc: { da: 'Stiller spørgsmål i stedet for at give svar.', en: 'Asks questions instead of giving answers.' },
    instructions: {
      da: 'Du er en sparringspartner, ikke en løsningsmaskine. Hjælp brugeren med at tænke selv: stil ét til tre skarpe, åbne spørgsmål ad gangen, spejl det du hører, og udfordr antagelser venligt. Giv kun et direkte svar eller en anbefaling, hvis brugeren udtrykkeligt beder om det. Hold svarene korte.',
      en: 'You are a sparring partner, not an answer machine. Help the user think for themselves: ask one to three sharp, open questions at a time, reflect back what you hear, and challenge assumptions kindly. Only give a direct answer or recommendation if the user explicitly asks for it. Keep replies short.',
    },
  },
  {
    key: 'chef', emoji: '🍳', tools: [], model: null,
    name: { da: 'Kok', en: 'Chef' },
    desc: { da: 'Opskrifter og madlavning ud fra det, du har.', en: 'Recipes and cooking from what you have.' },
    instructions: {
      da: 'Du er en erfaren og venlig kok. Foreslå opskrifter ud fra det, brugeren har i køkkenet, kostønsker og tid. Skriv ingredienser med mængder og en nummereret fremgangsmåde. Brug metriske mål. Tilføj gerne et par tips til variationer eller erstatninger.',
      en: 'You are an experienced, friendly chef. Suggest recipes based on what the user has in the kitchen, dietary wishes and time. List ingredients with amounts and a numbered method. Use metric units. Feel free to add a few tips for variations or substitutions.',
    },
  },
];

let customSkills = [];        // rows from the skills table
let currentSkillId = null;    // 'builtin:<key>' or a skills.id uuid; null = no skill

const skillText = (field) => (field && (field[currentLang] ?? field.en)) || '';

// Normalises built-in and custom skills into one shape.
function skillView(skill) {
  if (skill.key) {
    return {
      id: 'builtin:' + skill.key, builtin: true, emoji: skill.emoji,
      name: skillText(skill.name), description: skillText(skill.desc), instructions: skillText(skill.instructions),
      model: skill.model, tools: skill.tools,
    };
  }
  return {
    id: skill.id, builtin: false, emoji: skill.emoji || '✨', name: skill.name, description: skill.description || '',
    instructions: skill.instructions || '', model: skill.model || null, tools: skill.tools || [],
  };
}

function allSkillViews() {
  return [...BUILTIN_SKILLS.map(skillView), ...customSkills.map(skillView)];
}

function findSkill(id) {
  if (!id || id === 'builtin:standard') return null;
  return allSkillViews().find((s) => s.id === id) ?? null;
}

async function loadCustomSkills() {
  try { customSkills = await Store.skills(); } catch { customSkills = []; }
  renderSkillsTab();
  renderSkillChips();
}

// ---------- the current chat's skill ----------

function setCurrentSkill(id, { persist = true } = {}) {
  currentSkillId = id && id !== 'builtin:standard' ? id : null;
  renderSkillChips();
  renderSkillsTab();
  if (persist && sessions.some((s) => s.id === sessionId)) {
    Store.updateSession(sessionId, { skill: currentSkillId }).then(() => {
      const s = sessions.find((x) => x.id === sessionId);
      if (s) s.skill = currentSkillId;
    }).catch(() => flash(t('action_failed')));
  }
}

function renderSkillChips() {
  const skill = findSkill(currentSkillId);
  const header = $('skill-chip');
  const composer = $('composer-chips');
  header.replaceChildren();
  header.hidden = !skill;
  composer.querySelector('.skill-chip')?.remove();
  if (skill) {
    const label = `${skill.emoji} ${skill.name}`;
    const build = () => h('span', { class: 'chip', title: skill.description },
      h('span', { text: label }),
      h('button', { type: 'button', class: 'x', 'aria-label': t('skill_remove'), title: t('skill_remove'), text: '✕', onclick: () => setCurrentSkill(null) }));
    header.append(build());
    const c = build();
    c.classList.add('skill-chip');
    composer.prepend(c);
  }
  composer.hidden = !composer.children.length;
  if (typeof updateWelcome === 'function') updateWelcome();
}

// Start a fresh chat with a skill (the skill is saved with the chat when the first message is sent).
function startChatWithSkill(id) {
  startNewChat();
  setCurrentSkill(id, { persist: false });
  const skill = findSkill(id);
  if (skill?.model) preferModel(skill.model);
  closeDrawer();
  $('input').focus();
}

// ---------- the Skills tab ----------

function renderSkillsTab() {
  const box = $('tab-skills');
  if (!box) return;
  const card = (skill) => {
    const actions = skill.builtin
      ? [['📄', t('skill_duplicate'), () => openSkillEditor(null, { ...skill, name: skill.name + ' ' + t('skill_copy_suffix') })]]
      : [
          ['✏️', t('edit'), () => openSkillEditor(skill)],
          ['📄', t('skill_duplicate'), () => openSkillEditor(null, { ...skill, name: skill.name + ' ' + t('skill_copy_suffix') })],
          ['⬇', t('skill_export'), () => exportSkill(skill)],
          ['🗑', t('delete'), () => deleteSkill(skill)],
        ];
    return h('div', { class: 'card-item' + (skill.id === (currentSkillId ?? 'builtin:standard') ? ' current' : '') },
      h('button', { type: 'button', class: 'plain', style: 'flex:1;min-width:0;display:flex;gap:10px;align-items:flex-start', onclick: () => startChatWithSkill(skill.id), title: t('skill_start') },
        h('span', { class: 'emoji', text: skill.emoji }),
        h('span', { class: 'txt' }, h('strong', { text: skill.name }), h('span', { text: skill.description }))),
      h('button', {
        type: 'button', class: 'plain chat-more', 'aria-haspopup': 'menu', 'aria-label': t('more'), text: '⋯',
        onclick: (e) => openMenu(e.currentTarget, actions.map(([icon, label, run]) => ({ label: `${icon} ${label}`, run, danger: label === t('delete') }))),
      }));
  };
  const mine = customSkills.map(skillView);
  box.replaceChildren(
    h('div', { class: 'section-actions' },
      h('button', { type: 'button', class: 'primary', text: '＋ ' + t('skill_new'), onclick: () => openSkillEditor(null) }),
      h('button', { type: 'button', text: '⬆ ' + t('skill_import'), onclick: () => $('skill-file').click() })),
    h('div', { class: 'group-label', text: t('skills_builtin') }),
    ...BUILTIN_SKILLS.map((s) => card(skillView(s))),
    h('div', { class: 'group-label', text: t('skills_mine') }),
    mine.length ? mine.map(card) : h('div', { class: 'sb-empty', text: t('skills_none') }),
  );
}

// ---------- editor ----------

let editingSkill = null;

// One visible character, even for emoji built from several code points (like 👩‍💻).
function firstGrapheme(text) {
  if (window.Intl?.Segmenter) {
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) return part.segment;
    return '';
  }
  return [...text][0] ?? '';
}

function openSkillEditor(skill, prefill) {
  editingSkill = skill;
  const src = skill ?? prefill ?? { emoji: '✨', name: '', description: '', instructions: '', model: null, tools: [] };
  const form = $('skill-form');
  form.elements.emoji.value = src.emoji || '✨';
  form.elements.name.value = src.name || '';
  form.elements.description.value = src.description || '';
  form.elements.instructions.value = src.instructions || '';
  const modelSelect = form.elements.model;
  modelSelect.replaceChildren(h('option', { value: '', text: t('skill_model_any') }),
    ...[...$('model').options].filter((o) => o.value !== AUTO).map((o) => h('option', { value: o.value, text: o.textContent })));
  if (src.model && ![...modelSelect.options].some((o) => o.value === src.model)) modelSelect.append(h('option', { value: src.model, text: src.model }));
  modelSelect.value = src.model || '';
  const toolBox = $('skill-tools');
  toolBox.replaceChildren(...AI_TOOLS.map((tool) => h('label', { class: 'switch-row' },
    h('span', { text: `${tool.icon} ${t('tool_' + tool.id)}` }),
    h('input', { type: 'checkbox', class: 'switch', role: 'switch', name: 'tool_' + tool.id, checked: (src.tools || []).includes(tool.id) }))));
  $('skill-title').textContent = skill ? t('skill_edit_title') : t('skill_new_title');
  updateSkillCounter();
  $('skill-dialog').showModal();
  form.elements.name.focus();
}

function updateSkillCounter() {
  $('skill-count').textContent = `${$('skill-form').elements.instructions.value.length} / 4000`;
}

$('skill-form').elements.instructions.addEventListener('input', updateSkillCounter);
$('skill-cancel').addEventListener('click', () => $('skill-dialog').close());
$('skill-close').addEventListener('click', () => $('skill-dialog').close());

$('skill-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget.elements;
  const name = f.name.value.trim().slice(0, 60);
  if (!name) { f.name.focus(); return; }
  const row = {
    ...(editingSkill ? { id: editingSkill.id } : {}),
    name,
    emoji: firstGrapheme(f.emoji.value.trim()) || '✨',
    description: f.description.value.trim().slice(0, 200),
    instructions: f.instructions.value.trim().slice(0, 4000),
    model: f.model.value || null,
    tools: AI_TOOLS.filter((tool) => f['tool_' + tool.id].checked).map((tool) => tool.id),
  };
  $('skill-save').disabled = true;
  try {
    await Store.saveSkill(row);
    $('skill-dialog').close();
    await loadCustomSkills();
  } catch {
    flash(t('action_failed'));
  } finally {
    $('skill-save').disabled = false;
  }
});

async function deleteSkill(skill) {
  if (!confirm(t('skill_confirm_delete', { name: skill.name }))) return;
  try {
    await Store.deleteSkill(skill.id);
    if (currentSkillId === skill.id) setCurrentSkill(null);
    await loadCustomSkills();
  } catch {
    flash(t('action_failed'));
  }
}

// ---------- sharing ----------

function exportSkill(skill) {
  const data = {
    type: 'free-chatbot-skill', version: 1,
    skill: { name: skill.name, emoji: skill.emoji, description: skill.description, instructions: skill.instructions, model: skill.model, tools: skill.tools },
  };
  downloadFile(`skill-${safeFileName(skill.name, 'skill')}.json`, JSON.stringify(data, null, 2), 'application/json');
}

$('skill-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const s = data?.type === 'free-chatbot-skill' ? data.skill : null;
    if (!s || typeof s.name !== 'string' || !s.name.trim()) throw new Error('bad file');
    openSkillEditor(null, {
      emoji: String(s.emoji || '✨'), name: s.name.slice(0, 60), description: String(s.description || '').slice(0, 200),
      instructions: String(s.instructions || '').slice(0, 4000), model: typeof s.model === 'string' ? s.model : null,
      tools: Array.isArray(s.tools) ? s.tools.filter((x) => AI_TOOLS.some((tool) => tool.id === x)) : [],
    });
  } catch {
    flash(t('skill_import_bad'));
  }
});

document.addEventListener('langchange', () => { renderSkillsTab(); renderSkillChips(); });
