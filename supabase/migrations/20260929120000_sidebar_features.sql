-- Sidebar features: chat sessions, soft delete, per-user settings, custom skills, feature grants.
-- Users never hard-delete chat data: deleting / regenerating only sets deleted_at / hidden_at,
-- so the admin can still read everything (and see it marked as deleted).

-- ---------------------------------------------------------------- chat_sessions
create table public.chat_sessions (
  id          uuid primary key,                       -- same value as chat_messages.session_id
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text,
  pinned      boolean not null default false,
  skill       text,                                   -- 'builtin:<key>' or a skills.id uuid
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index chat_sessions_user_updated_idx on public.chat_sessions (user_id, updated_at desc);

alter table public.chat_sessions enable row level security;
revoke all on public.chat_sessions from anon, authenticated;
grant select, insert, update on public.chat_sessions to authenticated;

create policy "Users read own sessions"   on public.chat_sessions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users insert own sessions" on public.chat_sessions for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own sessions" on public.chat_sessions for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- chat_messages
alter table public.chat_messages
  add column hidden_at timestamptz,
  add column feedback  smallint check (feedback in (-1, 1)),
  add column meta      jsonb;

create index chat_messages_session_idx on public.chat_messages (session_id, id);

-- Users may only change hidden_at and feedback, never the text.
revoke update on public.chat_messages from anon, authenticated;
grant update (hidden_at, feedback) on public.chat_messages to authenticated;

create policy "Users update own messages" on public.chat_messages for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Keep chat_sessions right even when an old cached copy of the page is still in use.
create or replace function public.touch_chat_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.chat_sessions (id, user_id, title, created_at, updated_at)
  values (
    new.session_id,
    new.user_id,
    case when new.role = 'user' then left(regexp_replace(new.content, '\s+', ' ', 'g'), 80) end,
    new.created_at,
    new.created_at
  )
  on conflict (id) do update
    set updated_at = greatest(public.chat_sessions.updated_at, excluded.updated_at),
        title      = coalesce(public.chat_sessions.title, excluded.title);
  return new;
end $$;
revoke execute on function public.touch_chat_session() from public, anon, authenticated;

create trigger chat_messages_touch_session
  after insert on public.chat_messages
  for each row execute function public.touch_chat_session();

-- Backfill sessions from the messages that already exist.
insert into public.chat_sessions (id, user_id, title, created_at, updated_at)
select m.session_id,
       m.user_id,
       (select left(regexp_replace(f.content, '\s+', ' ', 'g'), 80)
          from public.chat_messages f
         where f.session_id = m.session_id and f.role = 'user'
         order by f.id limit 1),
       min(m.created_at),
       max(m.created_at)
  from public.chat_messages m
 where m.user_id is not null
 group by m.session_id, m.user_id
on conflict (id) do nothing;

-- ---------------------------------------------------------------- user_settings
create table public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.user_settings enable row level security;
revoke all on public.user_settings from anon, authenticated;
grant select, insert, update on public.user_settings to authenticated;

create policy "Users read own settings"   on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users insert own settings" on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own settings" on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- skills
create table public.skills (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  emoji         text not null default '✨',
  description   text not null default '',
  instructions  text not null default '' check (char_length(instructions) <= 4000),
  model         text,
  tools         text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index skills_user_idx on public.skills (user_id);
alter table public.skills enable row level security;
revoke all on public.skills from anon, authenticated;
grant select, insert, update, delete on public.skills to authenticated;

create policy "Users read own skills"   on public.skills for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users insert own skills" on public.skills for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own skills" on public.skills for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own skills" on public.skills for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- user_features (admin grants)
create table public.user_features (
  user_id      uuid not null references auth.users (id) on delete cascade,
  feature      text not null check (feature in ('web_search')),
  daily_limit  integer not null default 20 check (daily_limit >= 0),
  added_at     timestamptz not null default now(),
  primary key (user_id, feature)
);
alter table public.user_features enable row level security;
revoke all on public.user_features from anon, authenticated;
grant select on public.user_features to authenticated;

create policy "Users read own features" on public.user_features for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- web_search_log (service role only)
create table public.web_search_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index web_search_log_user_day_idx on public.web_search_log (user_id, created_at);
alter table public.web_search_log enable row level security;
revoke all on public.web_search_log from anon, authenticated;
