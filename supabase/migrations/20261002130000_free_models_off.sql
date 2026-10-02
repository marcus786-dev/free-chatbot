-- "Remove all models": a row here switches off every free model for that user, including ones OpenRouter
-- adds later. Models the admin assigns afterwards (user_models) still work.
create table public.user_free_models_off (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  added_at  timestamptz not null default now()
);
alter table public.user_free_models_off enable row level security;
revoke all on public.user_free_models_off from anon, authenticated;
grant select on public.user_free_models_off to authenticated;

create policy "Users read own free-models switch" on public.user_free_models_off for select to authenticated
  using ((select auth.uid()) = user_id);
