import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

// Admin panel API. Every request must come from a signed-in user whose app_metadata has
// is_admin = true. app_metadata is set in the database and users can't change their own.
//
// Users can delete chats and hide messages (by regenerating or editing), but that only sets
// deleted_at / hidden_at. The admin still reads everything, with those messages marked.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// OpenRouter model ids like "google/gemma-4-31b-it:free" or "anthropic/claude-sonnet-4.5".
// The admin may assign any model OpenRouter lists, paid ones included.
const MODEL_ID = /^[a-z0-9~._-]+\/[a-z0-9._:-]+$/i;
// Extra abilities the admin can switch on per user. Web search costs money, so it has a daily limit.
const FEATURES = ["web_search"] as const;
const DEFAULT_DAILY_LIMIT = 20;
const MAX_DAILY_LIMIT = 1000;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fail(status: number, message: string) {
  return json(status, { error: { code: status, message } });
}

function serviceClient(): SupabaseClient {
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try {
    key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? key;
  } catch {
    // fall back to the legacy service role key
  }
  return createClient(Deno.env.get("SUPABASE_URL")!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const isAdmin = (u: User | null | undefined) => u?.app_metadata?.is_admin === true;

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function listAllUsers(db: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

// Every model id OpenRouter currently offers, so typos can't be assigned.
async function openRouterModelIds(): Promise<Set<string>> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`Couldn't load OpenRouter's model list (HTTP ${res.status}).`);
  const { data } = await res.json();
  return new Set((Array.isArray(data) ? data : []).map((m) => m?.id).filter((id) => typeof id === "string"));
}

async function dashboard(db: SupabaseClient) {
  const today = startOfTodayUtc();
  const [users, stats, todayCount, blocked, settings, models, features, searches] = await Promise.all([
    listAllUsers(db),
    db.rpc("admin_user_stats"),
    db.from("chat_messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", today),
    db.from("blocked_users").select("user_id"),
    db.from("app_settings").select("signups_closed_at").maybeSingle(),
    db.from("user_models").select("user_id, model").order("model"),
    db.from("user_features").select("user_id, feature, daily_limit"),
    db.from("web_search_log").select("user_id").gte("created_at", today).limit(10000),
  ]);
  for (const r of [stats, todayCount, blocked, settings, models, features, searches]) if (r.error) throw r.error;

  const statsById = new Map(
    (stats.data as { user_id: string; messages: number; last_message_at: string | null }[]).map((s) => [s.user_id, s]),
  );
  const blockedIds = new Set((blocked.data ?? []).map((b: { user_id: string }) => b.user_id));
  const modelsById = new Map<string, string[]>();
  for (const m of (models.data ?? []) as { user_id: string; model: string }[]) {
    modelsById.set(m.user_id, [...(modelsById.get(m.user_id) ?? []), m.model]);
  }
  const webLimitById = new Map<string, number>();
  for (const f of (features.data ?? []) as { user_id: string; feature: string; daily_limit: number }[]) {
    if (f.feature === "web_search") webLimitById.set(f.user_id, f.daily_limit);
  }
  const webUsedById = new Map<string, number>();
  for (const r of (searches.data ?? []) as { user_id: string }[]) {
    webUsedById.set(r.user_id, (webUsedById.get(r.user_id) ?? 0) + 1);
  }
  const closedAt: string | null = settings.data?.signups_closed_at ?? null;

  const rows = users
    .map((u) => {
      const s = statsById.get(u.id);
      return {
        id: u.id,
        email: u.email ?? "(no email)",
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
        confirmed: Boolean(u.email_confirmed_at),
        isAdmin: isAdmin(u),
        messages: Number(s?.messages ?? 0),
        lastMessageAt: s?.last_message_at ?? null,
        blocked: blockedIds.has(u.id),
        waiting: !isAdmin(u) && closedAt !== null && new Date(u.created_at) > new Date(closedAt),
        models: modelsById.get(u.id) ?? [],
        webSearch: webLimitById.has(u.id)
          ? { enabled: true, dailyLimit: webLimitById.get(u.id)!, usedToday: webUsedById.get(u.id) ?? 0 }
          : { enabled: false, dailyLimit: DEFAULT_DAILY_LIMIT, usedToday: webUsedById.get(u.id) ?? 0 },
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    overview: {
      users: rows.length,
      messagesToday: todayCount.count ?? 0,
      activeToday: rows.filter((r) => r.lastMessageAt && r.lastMessageAt >= today).length,
      signupsClosedAt: closedAt,
      webSearchesToday: (searches.data ?? []).length,
    },
    users: rows,
  };
}

async function sessions(db: SupabaseClient, userId: string) {
  const [messagesRes, sessionsRes] = await Promise.all([
    db
      .from("chat_messages")
      .select("session_id, role, content, created_at, hidden_at, feedback")
      .eq("user_id", userId)
      .order("id")
      .limit(5000),
    db.from("chat_sessions").select("id, title, pinned, deleted_at").eq("user_id", userId),
  ]);
  if (messagesRes.error) throw messagesRes.error;
  if (sessionsRes.error) throw sessionsRes.error;

  const meta = new Map(
    (sessionsRes.data ?? []).map((s: { id: string; title: string | null; deleted_at: string | null }) => [s.id, s]),
  );
  const bySession = new Map<string, {
    sessionId: string;
    title: string | null;
    startedAt: string;
    lastAt: string;
    messages: number;
    hidden: number;
    up: number;
    down: number;
    deletedAt: string | null;
    preview: string;
  }>();
  for (const m of messagesRes.data) {
    let s = bySession.get(m.session_id);
    if (!s) {
      const info = meta.get(m.session_id);
      s = {
        sessionId: m.session_id,
        title: info?.title ?? null,
        startedAt: m.created_at,
        lastAt: m.created_at,
        messages: 0,
        hidden: 0,
        up: 0,
        down: 0,
        deletedAt: info?.deleted_at ?? null,
        preview: "",
      };
      bySession.set(m.session_id, s);
    }
    s.lastAt = m.created_at;
    s.messages++;
    if (m.hidden_at) s.hidden++;
    if (m.feedback === 1) s.up++;
    if (m.feedback === -1) s.down++;
    if (!s.preview && m.role === "user") s.preview = m.content.slice(0, 140);
  }
  return { sessions: [...bySession.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)) };
}

async function transcript(db: SupabaseClient, userId: string, sessionId: string) {
  const [messagesRes, sessionRes] = await Promise.all([
    db
      .from("chat_messages")
      .select("role, content, model, created_at, hidden_at, feedback, meta")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .order("id"),
    db.from("chat_sessions").select("title, deleted_at, skill").eq("user_id", userId).eq("id", sessionId).maybeSingle(),
  ]);
  if (messagesRes.error) throw messagesRes.error;
  if (sessionRes.error) throw sessionRes.error;
  return { messages: messagesRes.data, session: sessionRes.data };
}

// Block/unblock/delete must never target the caller or another admin.
async function checkTarget(db: SupabaseClient, caller: User, userId: string): Promise<string | null> {
  if (userId === caller.id) return "You can't do that to your own account.";
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) return "That user doesn't exist.";
  if (isAdmin(data.user)) return "Admins can't be blocked or deleted here.";
  return null;
}

// Supabase errors are plain objects with a message, not Error instances.
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "Method not allowed.");

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const db = serviceClient();
  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth?.user) return fail(401, "Please log in again.");
  if (!isAdmin(auth.user)) return fail(403, "This is only for the admin.");
  const caller = auth.user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Request body must be JSON.");
  }

  const userId = typeof body.userId === "string" && UUID.test(body.userId) ? body.userId : null;
  const sessionId = typeof body.sessionId === "string" && UUID.test(body.sessionId) ? body.sessionId : null;
  const model = typeof body.model === "string" ? body.model.trim() : "";

  try {
    switch (body.action) {
      case "dashboard":
        return json(200, await dashboard(db));

      case "sessions":
        if (!userId) return fail(400, "userId is required.");
        return json(200, await sessions(db, userId));

      case "transcript":
        if (!userId || !sessionId) return fail(400, "userId and sessionId are required.");
        return json(200, await transcript(db, userId, sessionId));

      case "add_model": {
        if (!userId) return fail(400, "userId is required.");
        if (!MODEL_ID.test(model)) {
          return fail(400, "That doesn't look like a model id. Use the OpenRouter form, like anthropic/claude-sonnet-4.5 or google/gemma-4-31b-it:free.");
        }
        if (!(await openRouterModelIds()).has(model)) return fail(400, `OpenRouter doesn't offer ${model} right now.`);
        const { error } = await db.from("user_models").upsert({ user_id: userId, model });
        if (error) throw error;
        return json(200, { ok: true });
      }

      case "remove_model": {
        if (!userId || !model) return fail(400, "userId and model are required.");
        const { error } = await db.from("user_models").delete().eq("user_id", userId).eq("model", model);
        if (error) throw error;
        return json(200, { ok: true });
      }

      // Switch a feature on for a user (or change its daily limit).
      case "grant_feature": {
        if (!userId) return fail(400, "userId is required.");
        const feature = body.feature;
        if (!(FEATURES as readonly unknown[]).includes(feature)) return fail(400, "Unknown feature.");
        const limit = body.dailyLimit === undefined ? DEFAULT_DAILY_LIMIT : Number(body.dailyLimit);
        if (!Number.isInteger(limit) || limit < 0 || limit > MAX_DAILY_LIMIT) {
          return fail(400, `The daily limit must be a whole number from 0 to ${MAX_DAILY_LIMIT}.`);
        }
        const { data: target, error: targetError } = await db.auth.admin.getUserById(userId);
        if (targetError || !target.user) return fail(400, "That user doesn't exist.");
        const { error } = await db.from("user_features").upsert({ user_id: userId, feature, daily_limit: limit });
        if (error) throw error;
        return json(200, { ok: true });
      }

      case "revoke_feature": {
        if (!userId) return fail(400, "userId is required.");
        if (!(FEATURES as readonly unknown[]).includes(body.feature)) return fail(400, "Unknown feature.");
        const { error } = await db.from("user_features").delete().eq("user_id", userId).eq("feature", body.feature as string);
        if (error) throw error;
        return json(200, { ok: true });
      }

      case "block":
      case "unblock":
      case "delete": {
        if (!userId) return fail(400, "userId is required.");
        const problem = await checkTarget(db, caller, userId);
        if (problem) return fail(400, problem);
        const { error } =
          body.action === "block"
            ? await db.from("blocked_users").upsert({ user_id: userId })
            : body.action === "unblock"
            ? await db.from("blocked_users").delete().eq("user_id", userId)
            : await db.auth.admin.deleteUser(userId); // chats, blocks, models, settings and skills go with it (on delete cascade)
        if (error) throw error;
        return json(200, { ok: true });
      }

      case "set_signups": {
        if (typeof body.open !== "boolean") return fail(400, "open must be true or false.");
        const { error } = await db
          .from("app_settings")
          .update({ signups_closed_at: body.open ? null : new Date().toISOString() })
          .eq("id", true);
        if (error) throw error;
        return json(200, { ok: true });
      }

      default:
        return fail(400, "Unknown action.");
    }
  } catch (err) {
    return fail(500, errorText(err));
  }
});
