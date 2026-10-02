-- Free models the admin has taken away from a user. Everyone gets every ":free" model by default;
-- a row here removes one of them for that user only (in the model list, when picked directly, and in Auto).
create table public.user_blocked_models (
  user_id   uuid not null references auth.users (id) on delete cascade,
  model     text not null check (model like '%:free'),
  added_at  timestamptz not null default now(),
  primary key (user_id, model)
);
alter table public.user_blocked_models enable row level security;
revoke all on public.user_blocked_models from anon, authenticated;
grant select on public.user_blocked_models to authenticated;

create policy "Users read own blocked models" on public.user_blocked_models for select to authenticated
  using ((select auth.uid()) = user_id);
