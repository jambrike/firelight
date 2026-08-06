create extension if not exists pgcrypto with schema extensions;

create type public.profile_role as enum ('learner', 'admin');
create type public.kit_code_state as enum ('issued', 'claimed', 'revoked');
create type public.kit_activation_kind as enum ('code', 'grandfathered');
create type public.lesson_progress_status as enum ('not_started', 'in_progress', 'completed');
create type public.compile_job_state as enum ('queued', 'running', 'succeeded', 'failed');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Builder'
    check (display_name = btrim(display_name))
    check (char_length(display_name) between 1 and 40),
  role public.profile_role not null default 'learner',
  access_source public.kit_activation_kind,
  access_granted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (access_source is null and access_granted_at is null)
    or (access_source is not null and access_granted_at is not null)
  )
);

create table public.kit_codes (
  id uuid primary key default gen_random_uuid(),
  hash_version smallint not null default 1 check (hash_version > 0),
  code_hash text not null
    check (code_hash ~ '^[0-9a-f]{64}$'),
  batch text not null
    check (batch = btrim(batch))
    check (char_length(batch) between 1 and 80),
  kind public.kit_activation_kind not null default 'code',
  state public.kit_code_state not null default 'issued',
  claimed_by uuid references public.profiles (id) on delete set null,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (state = 'issued' and claimed_by is null and claimed_at is null and revoked_at is null)
    or (state = 'claimed' and claimed_by is not null and claimed_at is not null and revoked_at is null)
    or (state = 'revoked' and claimed_by is null and revoked_at is not null)
  ),
  check (kind = 'code' or state in ('claimed', 'revoked'))
);

create unique index kit_codes_hash_version_hash_key
  on public.kit_codes (hash_version, code_hash);

create unique index kit_codes_one_active_per_user
  on public.kit_codes (claimed_by)
  where state = 'claimed';

create index kit_codes_claimed_by_idx on public.kit_codes (claimed_by)
  where claimed_by is not null;

create table public.lesson_progress (
  user_id uuid not null references public.profiles (id) on delete cascade,
  lesson_id text not null
    check (lesson_id in (
      'first-spark',
      'morse-name',
      'button-reaction',
      'distance-scout',
      'servo-gate',
      'trail-rover'
    )),
  lesson_version integer not null check (lesson_version > 0),
  status public.lesson_progress_status not null default 'not_started',
  current_step text not null default 'intro'
    check (current_step = btrim(current_step))
    check (char_length(current_step) between 1 and 100),
  percentage smallint not null default 0 check (percentage between 0 and 100),
  code_snapshot text check (code_snapshot is null or octet_length(code_snapshot) <= 65536),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, lesson_id, lesson_version),
  check (
    (status = 'not_started' and percentage = 0 and completed_at is null)
    or (status = 'in_progress' and percentage between 0 and 99 and completed_at is null)
    or (status = 'completed' and percentage = 100 and completed_at is not null)
  )
);

create index lesson_progress_user_updated_idx
  on public.lesson_progress (user_id, updated_at desc);

create table public.compile_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  lesson_id text not null
    check (lesson_id in (
      'first-spark',
      'morse-name',
      'button-reaction',
      'distance-scout',
      'servo-gate',
      'trail-rover'
    )),
  board_target text not null default 'arduino:avr:nano:cpu=atmega328old'
    check (board_target = 'arduino:avr:nano:cpu=atmega328old'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  state public.compile_job_state not null default 'queued',
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  safe_error_code text check (
    safe_error_code is null
    or (safe_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
  ),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index compile_jobs_user_created_idx
  on public.compile_jobs (user_id, created_at desc);

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  target_type text not null check (target_type ~ '^[a-z][a-z0-9_.-]{1,39}$'),
  target_id text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

create function public.firelight_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function public.firelight_normalize_lesson_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'completed' and new.status <> 'completed' then
      raise exception 'completed lesson progress cannot be reopened'
        using errcode = '23514';
    end if;

    if new.percentage < old.percentage then
      raise exception 'lesson progress percentage cannot decrease'
        using errcode = '23514';
    end if;
  end if;

  if new.status = 'completed' then
    if tg_op = 'UPDATE' and old.status = 'completed' then
      new.completed_at = old.completed_at;
    else
      new.completed_at = now();
    end if;
  else
    new.completed_at = null;
  end if;

  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.firelight_set_updated_at();

create trigger lesson_progress_set_updated_at
before update on public.lesson_progress
for each row execute function public.firelight_set_updated_at();

create trigger lesson_progress_normalize_completion
before insert or update on public.lesson_progress
for each row execute function public.firelight_normalize_lesson_progress();

create function public.firelight_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
begin
  requested_name := btrim(coalesce(
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'name',
    ''
  ));

  if char_length(requested_name) not between 1 and 40 then
    requested_name := 'Builder';
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, requested_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger firelight_on_auth_user_created
after insert on auth.users
for each row execute function public.firelight_handle_new_user();

-- The auth table is locked by the preceding trigger DDL until this migration
-- commits. Only users that predate the migration are selected here; signups
-- after the migration use the trigger default and must claim a real kit.
insert into public.profiles (
  id,
  display_name,
  access_source,
  access_granted_at
)
select
  users.id,
  case
    when char_length(btrim(coalesce(
      users.raw_user_meta_data ->> 'display_name',
      users.raw_user_meta_data ->> 'name',
      ''
    ))) between 1 and 40
      then btrim(coalesce(
        users.raw_user_meta_data ->> 'display_name',
        users.raw_user_meta_data ->> 'name'
      ))
    else 'Builder'
  end,
  'grandfathered',
  now()
from auth.users as users
on conflict (id) do nothing;

create function public.firelight_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

create function public.claim_kit_code(p_user_id uuid, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  learner_profile public.profiles%rowtype;
  active_code public.kit_codes%rowtype;
  requested_code public.kit_codes%rowtype;
begin
  if p_user_id is null or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('result', 'invalid');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 0)
  );

  select *
  into learner_profile
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;

  if learner_profile.access_source = 'grandfathered' then
    return jsonb_build_object(
      'result', 'already_active',
      'activation', jsonb_build_object(
        'id', learner_profile.id,
        'batch', 'legacy-pilot',
        'kind', 'grandfathered',
        'claimedAt', learner_profile.access_granted_at
      )
    );
  end if;

  select *
  into active_code
  from public.kit_codes
  where claimed_by = p_user_id
    and state = 'claimed'
  limit 1;

  if found then
    return jsonb_build_object(
      'result', case
        when active_code.code_hash = p_code_hash then 'claimed'
        else 'already_active'
      end,
      'activation', jsonb_build_object(
        'id', active_code.id,
        'batch', active_code.batch,
        'kind', active_code.kind,
        'claimedAt', active_code.claimed_at
      )
    );
  end if;

  select *
  into requested_code
  from public.kit_codes
  where hash_version = 1
    and code_hash = p_code_hash
    and kind = 'code'
  for update;

  if not found or requested_code.state <> 'issued' then
    return jsonb_build_object('result', 'invalid');
  end if;

  update public.kit_codes
  set
    state = 'claimed',
    claimed_by = p_user_id,
    claimed_at = now()
  where id = requested_code.id
  returning * into requested_code;

  update public.profiles
  set
    access_source = 'code',
    access_granted_at = requested_code.claimed_at
  where id = p_user_id;

  insert into public.admin_audit_log (
    actor_id,
    action,
    target_type,
    target_id
  )
  values (
    p_user_id,
    'kit.claim',
    'kit',
    requested_code.id::text
  );

  return jsonb_build_object(
    'result', 'claimed',
    'activation', jsonb_build_object(
      'id', requested_code.id,
      'batch', requested_code.batch,
      'kind', requested_code.kind,
      'claimedAt', requested_code.claimed_at
    )
  );
end;
$$;

create function public.firelight_prepare_auth_user_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.kit_codes
  set
    state = 'revoked',
    claimed_by = null,
    revoked_at = now()
  where claimed_by = old.id
    and state = 'claimed';

  return old;
end;
$$;

create trigger before_auth_user_deleted
before delete on auth.users
for each row execute function public.firelight_prepare_auth_user_deletion();

alter table public.profiles enable row level security;
alter table public.kit_codes enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.compile_jobs enable row level security;
alter table public.admin_audit_log enable row level security;

create policy profiles_select_own_or_admin
on public.profiles for select
to authenticated
using (id = (select auth.uid()) or (select public.firelight_is_admin()));

create policy profiles_update_own
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy lesson_progress_select_own_or_admin
on public.lesson_progress for select
to authenticated
using (user_id = (select auth.uid()) or (select public.firelight_is_admin()));

create policy lesson_progress_insert_own
on public.lesson_progress for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.access_source is not null
  )
);

create policy lesson_progress_update_own
on public.lesson_progress for update
to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.access_source is not null
  )
);

create policy lesson_progress_delete_own
on public.lesson_progress for delete
to authenticated
using (user_id = (select auth.uid()));

create policy compile_jobs_select_own_or_admin
on public.compile_jobs for select
to authenticated
using (user_id = (select auth.uid()) or (select public.firelight_is_admin()));

create policy admin_audit_log_select_admin
on public.admin_audit_log for select
to authenticated
using ((select public.firelight_is_admin()));

revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.kit_codes from public, anon, authenticated;
revoke all on table public.lesson_progress from public, anon, authenticated;
revoke all on table public.compile_jobs from public, anon, authenticated;
revoke all on table public.admin_audit_log from public, anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;
grant select, insert, update, delete on table public.lesson_progress to authenticated;
grant select on table public.compile_jobs to authenticated;
grant select on table public.admin_audit_log to authenticated;

revoke all on function public.firelight_set_updated_at() from public, anon, authenticated;
revoke all on function public.firelight_normalize_lesson_progress() from public, anon, authenticated;
revoke all on function public.firelight_handle_new_user() from public, anon, authenticated;
revoke all on function public.firelight_prepare_auth_user_deletion() from public, anon, authenticated;
revoke all on function public.firelight_is_admin() from public, anon;
revoke all on function public.claim_kit_code(uuid, text) from public, anon, authenticated;
grant execute on function public.firelight_is_admin() to authenticated;
grant execute on function public.claim_kit_code(uuid, text) to service_role;

comment on column public.kit_codes.code_hash is
  'Lowercase HMAC-SHA-256 hex of canonical Crockford code with a server-only pepper; plaintext is never stored.';
comment on function public.claim_kit_code(uuid, text) is
  'Service-only atomic claim after the Worker authenticates the learner; idempotent for the original claimant.';
comment on function public.firelight_prepare_auth_user_deletion() is
  'Revokes claimed kit state before auth.users deletion cascades learner-owned application data.';
