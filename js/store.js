// Every Supabase call lives here, so the other files never talk to the database directly.
// All tables are protected by row-level security: a user only ever sees their own rows.
// Nothing here deletes chat data. "Deleting" sets deleted_at / hidden_at, and the admin can still read it.

const SUPABASE_URL = 'https://qkqwvhtwcmkbjtmelkfi.supabase.co';
// Publishable key: safe to ship in the page. The OpenRouter key lives only in the Edge Function.
const SUPABASE_KEY = 'sb_publishable_uf9SDtY2gHE-0RS1dUATKw_ed2LMSDT';

const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

const Store = {
  // ----- sessions -----
  sessions() {
    return sb.from('chat_sessions')
      .select('id, title, pinned, skill, created_at, updated_at')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(500)
      .then(unwrap);
  },
  upsertSession(row) {
    return sb.from('chat_sessions').upsert(row).then(unwrap);
  },
  updateSession(id, patch) {
    return sb.from('chat_sessions').update(patch).eq('id', id).then(unwrap);
  },
  // Soft delete: the chat leaves the user's lists, but the rows stay readable for the admin.
  async deleteSession(id) {
    const now = new Date().toISOString();
    unwrap(await sb.from('chat_sessions').update({ deleted_at: now }).eq('id', id));
    unwrap(await sb.from('chat_messages').update({ hidden_at: now }).eq('session_id', id).is('hidden_at', null));
  },
  async deleteAllChats() {
    const now = new Date().toISOString();
    unwrap(await sb.from('chat_sessions').update({ deleted_at: now }).is('deleted_at', null));
    unwrap(await sb.from('chat_messages').update({ hidden_at: now }).is('hidden_at', null));
  },

  // ----- messages -----
  messages(sid) {
    return sb.from('chat_messages')
      .select('id, role, content, model, feedback, meta, created_at')
      .eq('session_id', sid)
      .is('hidden_at', null)
      .order('id')
      .then(unwrap);
  },
  // Text search over the user's own visible messages (row-level security does the scoping).
  searchMessages(query) {
    const pattern = '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return sb.from('chat_messages')
      .select('session_id, role, content, id')
      .is('hidden_at', null)
      .ilike('content', pattern)
      .order('id', { ascending: false })
      .limit(80)
      .then(unwrap);
  },
  // Every visible message, oldest first (for "export all chats").
  async allMessages() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const page = unwrap(await sb.from('chat_messages')
        .select('id, session_id, role, content, model, created_at')
        .is('hidden_at', null)
        .order('id')
        .range(from, from + 999));
      out.push(...page);
      if (page.length < 1000) return out;
    }
  },
  insertMessages(rows) {
    return sb.from('chat_messages').insert(rows).select('id, role').then(unwrap);
  },
  async hideMessages(ids) {
    if (!ids.length) return;
    unwrap(await sb.from('chat_messages').update({ hidden_at: new Date().toISOString() }).in('id', ids));
  },
  setFeedback(id, value) {
    return sb.from('chat_messages').update({ feedback: value }).eq('id', id).then(unwrap);
  },

  // ----- settings -----
  async getSettings() {
    const row = unwrap(await sb.from('user_settings').select('settings').maybeSingle());
    return row?.settings ?? null;
  },
  saveSettings(userId, settings) {
    return sb.from('user_settings')
      .upsert({ user_id: userId, settings, updated_at: new Date().toISOString() })
      .then(unwrap);
  },

  // ----- skills -----
  skills() {
    return sb.from('skills').select('*').order('created_at').then(unwrap);
  },
  saveSkill(skill) {
    return sb.from('skills').upsert({ ...skill, updated_at: new Date().toISOString() }).select().single().then(unwrap);
  },
  deleteSkill(id) {
    return sb.from('skills').delete().eq('id', id).then(unwrap);
  },

  // ----- other -----
  assignedModels() {
    return sb.from('user_models').select('model').then(unwrap);
  },
  removedFreeModels() {
    return sb.from('user_blocked_models').select('model').then(unwrap);
  },
  freeModelsOff() {
    return sb.from('user_free_models_off').select('user_id').then(unwrap);
  },
  features() {
    return sb.from('user_features').select('feature, daily_limit').then(unwrap);
  },
  appSettings() {
    return sb.from('app_settings').select('signups_closed_at').maybeSingle().then(unwrap);
  },
};
