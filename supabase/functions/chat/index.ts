import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

// Proxies chat requests to OpenRouter for signed-in users only.
// The OpenRouter key lives in the OPENROUTER_API_KEY secret and never reaches the browser.
// Every user can use the models whose id ends in ":free". The admin can also assign extra models
// to a user (user_models), paid ones included; those come on top of the free ones.
// model "auto" judges how hard the latest message is. Easy ones (short chit-chat, quick facts, simple
// sums) go to a free model first; hard ones (code, long or multi-part questions, analysis) go to the
// user's assigned models first. Either way it falls back to the other group when a model is busy or
// down. Assigning a paid model to a user is the admin's choice to let Auto bill the account for that
// user's hard questions; users with no assigned models only ever get free models.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const AUTO = "auto";
const AUTO_MAX_ATTEMPTS = 4;
const MODEL_LIST_TTL_MS = 10 * 60_000;
const MAX_CONTEXT_CHARS = 100_000;

const NOT_CHAT = /(safety|guard|moderation)/i;
const CODING_ONLY = /(code|coder)/i;
const MIN_AUTO_SIZE_B = 8;
const ACCOUNT_LIMIT = /free-models-per|per[- ]day/i;

// Signals that a message needs a stronger model. Any one hard word, code, or a long message is enough.
const HARD_WORDS = new RegExp(
  "\\b(debug|refactor|optimi[sz]e|algorithm|architecture|prove|proof|derive|analy[sz]e|analysis|compare|contrast|" +
    "essay|step[- ]by[- ]step|in detail|detailed|implement|trade-?offs?|regex|sql|integral|equation|theorem|" +
    "write (?:a|an|the|me a) (?:function|program|script|story|essay|report|class|component)|" +
    "explain why|forklar|analyser|sammenlign|detaljeret|skriv en)\\b",
  "i",
);
const CODE_HINT = /```|\bfunction\s*\w*\s*\(|\bclass\s+\w+\s*[:({]|=>|\bdef\s+\w+\(|#include|\bSELECT\b[\s\S]*\bFROM\b|<\/?[a-z][^>]*>|[{};]\s*$/im;
const LONG_MESSAGE = 400;
const LONG_CONTEXT = 6_000;

type ChatMessage = { role: "user" | "assistant"; content: string };
type Attempt =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; status: number; message: string };

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function httpStatus(code: unknown): number {
  const n = Number(code);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : 502;
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

// Blocked users, and accounts created while sign-ups are closed, can't chat. Admins always can.
async function accessProblem(db: SupabaseClient, user: User): Promise<{ status: number; message: string } | null> {
  if (user.app_metadata?.is_admin === true) return null;
  const [blocked, settings] = await Promise.all([
    db.from("blocked_users").select("user_id").eq("user_id", user.id).maybeSingle(),
    db.from("app_settings").select("signups_closed_at").maybeSingle(),
  ]);
  if (blocked.error || settings.error) {
    return { status: 503, message: "Couldn't check your account right now. Try again in a moment." };
  }
  if (blocked.data) return { status: 403, message: "Your account has been blocked by the admin." };
  const closedAt = settings.data?.signups_closed_at;
  if (closedAt && new Date(user.created_at) > new Date(closedAt)) {
    return { status: 403, message: "Sign-ups are closed right now, so new accounts can't chat yet." };
  }
  return null;
}

function isMessage(m: unknown): m is ChatMessage {
  if (typeof m !== "object" || m === null) return false;
  const { role, content } = m as Record<string, unknown>;
  return (role === "user" || role === "assistant") && typeof content === "string";
}

function trimToFit(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    total += messages[i].content.length;
    if (total > MAX_CONTEXT_CHARS && kept.length > 0) break;
    kept.unshift({ role: messages[i].role, content: messages[i].content });
  }
  return kept;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Cheap, deterministic difficulty guess from the latest message (no extra model call, no latency).
function difficulty(messages: ChatMessage[]): "easy" | "hard" {
  const text = messages[messages.length - 1].content.trim();
  const earlier = messages.slice(0, -1).reduce((n, m) => n + m.content.length, 0);
  let score = 0;
  if (text.length > LONG_MESSAGE) score += 2;
  else if (text.length > LONG_MESSAGE / 2) score += 1;
  if (CODE_HINT.test(text)) score += 2;
  if (HARD_WORDS.test(text)) score += 2;
  if ((text.match(/\?/g) ?? []).length > 1) score += 1;
  if (text.split("\n").length > 6) score += 1;
  if (earlier > LONG_CONTEXT) score += 1;
  return score >= 2 ? "hard" : "easy";
}

let modelCache: { ids: string[]; at: number } | null = null;

async function autoPool(): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_LIST_TTL_MS) return modelCache.ids;
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  const ids = (Array.isArray(data) ? data : [])
    .filter((m) => typeof m?.id === "string" && m.id.endsWith(":free"))
    .filter((m) => {
      const out = m.architecture?.output_modalities;
      return !Array.isArray(out) || out.includes("text");
    })
    .map((m) => m.id as string)
    .filter((id) => !NOT_CHAT.test(id) && !CODING_ONLY.test(id))
    .filter((id) => {
      const size = id.match(/(\d+(?:\.\d+)?)b(?![a-z])/i);
      return !size || Number(size[1]) >= MIN_AUTO_SIZE_B;
    });
  modelCache = { ids, at: Date.now() };
  return ids;
}

async function tryModel(apiKey: string, model: string, messages: ChatMessage[], signal: AbortSignal): Promise<Attempt> {
  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Chat bot" },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
  } catch (err) {
    return { ok: false, status: 502, message: `Couldn't reach OpenRouter: ${err instanceof Error ? err.message : err}` };
  }

  if (!upstream.ok || !upstream.body) {
    let message = upstream.statusText || `OpenRouter returned ${upstream.status}.`;
    try {
      const body = await upstream.json();
      message = body?.error?.message ?? message;
    } catch {
      // not JSON
    }
    return { ok: false, status: httpStatus(upstream.status), message };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const seen: Uint8Array[] = [];
  let pending = "";

  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (err) {
      return { ok: false, status: 502, message: `${model} stopped responding: ${err instanceof Error ? err.message : err}` };
    }
    if (result.done) return { ok: false, status: 502, message: `${model} ended without replying.` };

    seen.push(result.value);
    pending += decoder.decode(result.value, { stream: true });
    const lastNewline = pending.lastIndexOf("\n");
    if (lastNewline === -1) continue;
    const lines = pending.slice(0, lastNewline).split("\n");
    pending = pending.slice(lastNewline + 1);

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        reader.cancel().catch(() => {});
        return { ok: false, status: 502, message: `${model} sent an empty reply.` };
      }
      let chunk: { error?: { code?: unknown; message?: string } };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk?.error) {
        reader.cancel().catch(() => {});
        return { ok: false, status: httpStatus(chunk.error.code), message: chunk.error.message ?? `${model} failed.` };
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const bytes of seen) controller.enqueue(bytes);
        },
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (err) {
            controller.error(err);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { ok: true, stream };
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed.");

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const db = serviceClient();
  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData?.user) return errorResponse(401, "Please log in again.");
  const user = userData.user;
  const denied = await accessProblem(db, user);
  if (denied) return errorResponse(denied.status, denied.message);

  let body: { model?: unknown; prefer?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Request body must be JSON.");
  }

  const { model, prefer, messages } = body;
  if (typeof model !== "string" || !model) return errorResponse(400, "model is required.");
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isMessage)) {
    return errorResponse(400, "messages must be a non-empty list of {role, content}.");
  }

  // Free models are open to everyone; anything else must be assigned to this user by the admin.
  if (model !== AUTO && !model.endsWith(":free")) {
    const { data: assignedRow, error: assignedError } = await db
      .from("user_models")
      .select("model")
      .eq("user_id", user.id)
      .eq("model", model)
      .maybeSingle();
    if (assignedError) return errorResponse(503, "Couldn't check your models right now. Try again in a moment.");
    if (!assignedRow) return errorResponse(403, "That model isn't enabled for your account.");
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return errorResponse(500, "Server is missing OPENROUTER_API_KEY.");

  let candidates = [model];
  if (model === AUTO) {
    // Models the admin assigned to this user, plus the shared free pool; difficulty decides which goes first.
    const { data: assignedRows, error: assignedError } = await db
      .from("user_models")
      .select("model")
      .eq("user_id", user.id);
    if (assignedError) return errorResponse(503, "Couldn't check your models right now. Try again in a moment.");
    const assigned = [...new Set((assignedRows ?? []).map((r) => r.model as string))];

    let pool: string[] = [];
    try {
      pool = await autoPool();
    } catch {
      if (!assigned.length) return errorResponse(502, "Couldn't get the list of free models from OpenRouter.");
    }
    if (!pool.length && !assigned.length) return errorResponse(503, "OpenRouter lists no free chat models right now.");

    // Keep the model used earlier in the conversation first within its own group.
    const pinned = (list: string[]) =>
      typeof prefer === "string" && list.includes(prefer) ? [prefer, ...list.filter((id) => id !== prefer)] : list;
    const mine = pinned(shuffle(assigned));
    const free = pinned(shuffle(pool)).slice(0, AUTO_MAX_ATTEMPTS);
    const hard = difficulty(messages) === "hard";
    candidates = [...new Set(hard ? [...mine, ...free] : [...free, ...mine])];
  }

  const trimmed = trimToFit(messages);
  let failure = { status: 502, message: "No model answered." };
  const queue = [...candidates];
  while (queue.length) {
    const candidate = queue.shift()!;
    const attempt = await tryModel(apiKey, candidate, trimmed, req.signal);
    if (attempt.ok) {
      return new Response(attempt.stream, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }
    failure = attempt;
    if (req.signal.aborted) break;
    if (attempt.status === 401 || attempt.status === 402) break;
    if (ACCOUNT_LIMIT.test(attempt.message)) {
      // The shared free quota is used up: skip the remaining free models, but assigned ones may still work.
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].endsWith(":free")) queue.splice(i, 1);
    }
  }

  if (failure.status === 401) {
    return errorResponse(502, "OpenRouter rejected the server's API key. Check the OPENROUTER_API_KEY secret.");
  }
  return errorResponse(failure.status, failure.message);
});
