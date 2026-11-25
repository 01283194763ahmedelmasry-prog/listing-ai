-- Run once in Supabase SQL editor.
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  free_used int not null default 0,
  plan text,                -- 'monthly' | 'yearly' | null
  plan_until timestamptz
);
alter table profiles enable row level security;
create policy "read own profile" on profiles for select using (auth.uid() = id);
-- no insert/update policies: only the server (service role) writes.

create or replace function handle_new_user() returns trigger language plpgsql security definer as $$
begin insert into profiles (id, email) values (new.id, new.email) on conflict do nothing; return new; end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Atomically spend one free try. Returns remaining tries, or -1 if none left. Subscribers are not charged.
create or replace function consume_try(uid uuid, free_limit int) returns int language plpgsql security definer as $$
declare p profiles;
begin
  select * into p from profiles where id = uid for update;
  if p.plan is not null and p.plan_until > now() then return 9999; end if;
  if p.free_used >= free_limit then return -1; end if;
  update profiles set free_used = free_used + 1 where id = uid;
  return free_limit - p.free_used - 1;
end $$;
create or replace function refund_try(uid uuid) returns void language sql security definer as $$
  update profiles set free_used = greatest(0, free_used - 1) where id = uid $$;
revoke execute on function consume_try, refund_try from public, anon, authenticated;

-- API access is not auto-granted on this project: grant explicitly.
grant usage on schema public to service_role, authenticated;
grant all on profiles to service_role;
grant select on profiles to authenticated;
grant execute on function consume_try(uuid, int), refund_try(uuid) to service_role;


-- Public aggregate page-view counter. Counts page loads, not unique visitors.
create table if not exists site_stats (
  id boolean primary key default true check (id),
  visits bigint not null default 0
);
insert into site_stats (id, visits) values (true, 0) on conflict (id) do nothing;
alter table site_stats enable row level security;
revoke all on site_stats from public, anon, authenticated;
grant all on site_stats to service_role;
create or replace function increment_visit() returns bigint language plpgsql security definer as $$
declare total bigint;
begin
  update site_stats set visits = visits + 1 where id = true returning visits into total;
  return total;
end $$;
revoke execute on function increment_visit() from public, anon, authenticated;
grant execute on function increment_visit() to service_role;

