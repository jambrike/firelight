alter table public.compile_jobs
  add column lesson_version integer not null default 1
    check (lesson_version > 0),
  add column artifact_hash text
    check (artifact_hash is null or artifact_hash ~ '^[0-9a-f]{64}$'),
  add column diagnostic_summary text not null default ''
    check (octet_length(diagnostic_summary) <= 8192);

-- Older or interrupted deployments may have left more than one active row.
-- Keep the newest row live and fail older work before installing the invariant.
with ranked_active_jobs as (
  select
    id,
    row_number() over (
      partition by user_id
      order by created_at desc, id desc
    ) as active_rank
  from public.compile_jobs
  where state in ('queued', 'running')
)
update public.compile_jobs as jobs
set
  state = 'failed',
  safe_error_code = 'SUPERSEDED_ACTIVE_JOB',
  finished_at = now()
from ranked_active_jobs
where jobs.id = ranked_active_jobs.id
  and ranked_active_jobs.active_rank > 1;

create unique index compile_jobs_one_active_per_user
  on public.compile_jobs (user_id)
  where state in ('queued', 'running');

create table public.hardware_upload_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  compile_job_id uuid not null unique references public.compile_jobs (id) on delete cascade,
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
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  artifact_hash text not null check (artifact_hash ~ '^[0-9a-f]{64}$'),
  bytes_written integer not null check (bytes_written between 1 and 30720),
  attestation_kind text not null default 'browser-web-serial-v1'
    check (attestation_kind = 'browser-web-serial-v1'),
  recorded_at timestamptz not null default now()
);

create index hardware_upload_evidence_user_lesson_idx
  on public.hardware_upload_evidence (user_id, lesson_id, lesson_version, recorded_at desc);

alter table public.lesson_progress
  add column completion_evidence_id uuid
    references public.hardware_upload_evidence (id) on delete restrict;

create unique index lesson_progress_one_completion_per_upload
  on public.lesson_progress (completion_evidence_id)
  where completion_evidence_id is not null;

create function public.firelight_has_active_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = p_user_id
      and (
        profile.access_source = 'grandfathered'
        or (
          profile.access_source = 'code'
          and exists (
            select 1
            from public.kit_codes as code
            where code.claimed_by = profile.id
              and code.kind = 'code'
              and code.state = 'claimed'
              and code.revoked_at is null
          )
        )
      )
  );
$$;

create function public.firelight_has_current_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.firelight_has_active_access((select auth.uid()));
$$;

create function public.firelight_sync_revoked_kit_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_claimant uuid;
begin
  if old.state <> 'claimed' or old.claimed_by is null then
    return null;
  end if;

  if tg_op = 'UPDATE'
    and new.state = 'claimed'
    and new.claimed_by = old.claimed_by
    and new.revoked_at is null
  then
    return null;
  end if;

  previous_claimant := old.claimed_by;
  update public.profiles as profile
  set
    access_source = null,
    access_granted_at = null
  where profile.id = previous_claimant
    and profile.access_source = 'code'
    and not exists (
      select 1
      from public.kit_codes as code
      where code.claimed_by = previous_claimant
        and code.kind = 'code'
        and code.state = 'claimed'
        and code.revoked_at is null
    );

  return null;
end;
$$;

create trigger kit_codes_sync_revoked_access
after update or delete on public.kit_codes
for each row execute function public.firelight_sync_revoked_kit_access();

create function public.firelight_begin_compile_job(
  p_user_id uuid,
  p_lesson_id text,
  p_lesson_version integer,
  p_source_hash text,
  p_board_target text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_job public.compile_jobs%rowtype;
  recent_hour integer;
  recent_day integer;
begin
  if p_user_id is null
    or p_lesson_id is null
    or p_lesson_version is null
    or p_lesson_version < 1
    or p_source_hash is null
    or p_source_hash !~ '^[0-9a-f]{64}$'
    or p_board_target <> 'arduino:avr:nano:cpu=atmega328old'
  then
    return jsonb_build_object('result', 'invalid');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('compile:' || p_user_id::text, 0)
  );

  if not public.firelight_has_active_access(p_user_id) then
    return jsonb_build_object('result', 'not_entitled');
  end if;

  -- A dead Worker must not lock a learner out forever. A 90-second lease is
  -- longer than the bounded compiler request plus terminal bookkeeping.
  update public.compile_jobs
  set
    state = 'failed',
    duration_ms = least(
      60000,
      greatest(0, floor(extract(epoch from (clock_timestamp() - started_at)) * 1000)::integer)
    ),
    safe_error_code = 'ACTIVE_JOB_EXPIRED',
    diagnostic_summary = 'The compiler job lease expired before it finished.',
    finished_at = now()
  where user_id = p_user_id
    and state in ('queued', 'running')
    and coalesce(started_at, created_at) < now() - interval '90 seconds';

  if exists (
    select 1
    from public.compile_jobs
    where user_id = p_user_id
      and state in ('queued', 'running')
  ) then
    return jsonb_build_object('result', 'active');
  end if;

  select count(*)::integer
  into recent_hour
  from public.compile_jobs
  where user_id = p_user_id
    and created_at >= now() - interval '1 hour';

  if recent_hour >= 20 then
    return jsonb_build_object(
      'result', 'rate_limited',
      'scope', 'hour',
      'retryAfterSeconds', 3600
    );
  end if;

  select count(*)::integer
  into recent_day
  from public.compile_jobs
  where user_id = p_user_id
    and created_at >= now() - interval '24 hours';

  if recent_day >= 100 then
    return jsonb_build_object(
      'result', 'rate_limited',
      'scope', 'day',
      'retryAfterSeconds', 86400
    );
  end if;

  insert into public.compile_jobs (
    user_id,
    lesson_id,
    lesson_version,
    board_target,
    source_hash,
    state,
    started_at
  )
  values (
    p_user_id,
    p_lesson_id,
    p_lesson_version,
    p_board_target,
    p_source_hash,
    'running',
    now()
  )
  returning * into new_job;

  return jsonb_build_object(
    'result', 'started',
    'jobId', new_job.id
  );
exception
  when check_violation or foreign_key_violation then
    return jsonb_build_object('result', 'invalid');
end;
$$;

create function public.firelight_finish_compile_job(
  p_user_id uuid,
  p_job_id uuid,
  p_terminal_state text,
  p_duration_ms integer,
  p_safe_error_code text,
  p_artifact_hash text,
  p_diagnostic_summary text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_job public.compile_jobs%rowtype;
begin
  if p_user_id is null
    or p_job_id is null
    or p_terminal_state not in ('succeeded', 'failed')
    or p_duration_ms is null
    or p_duration_ms not between 0 and 60000
    or p_diagnostic_summary is null
    or octet_length(p_diagnostic_summary) > 8192
    or (
      p_terminal_state = 'succeeded'
      and (
        p_artifact_hash is null
        or p_artifact_hash !~ '^[0-9a-f]{64}$'
        or p_safe_error_code is not null
      )
    )
    or (
      p_terminal_state = 'failed'
      and (
        p_artifact_hash is not null
        or p_safe_error_code is null
        or p_safe_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
      )
    )
  then
    return jsonb_build_object('result', 'invalid');
  end if;

  select *
  into existing_job
  from public.compile_jobs
  where id = p_job_id
    and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;

  if not public.firelight_has_active_access(p_user_id) then
    if existing_job.state in ('queued', 'running') then
      update public.compile_jobs
      set
        state = 'failed',
        duration_ms = p_duration_ms,
        safe_error_code = 'ACCESS_REVOKED',
        artifact_hash = null,
        diagnostic_summary = 'Kit access was revoked before compilation completed.',
        finished_at = now()
      where id = existing_job.id;
    end if;
    return jsonb_build_object('result', 'not_entitled');
  end if;

  if existing_job.state in ('succeeded', 'failed') then
    if existing_job.state::text = p_terminal_state
      and existing_job.duration_ms = p_duration_ms
      and existing_job.safe_error_code is not distinct from p_safe_error_code
      and existing_job.artifact_hash is not distinct from p_artifact_hash
      and existing_job.diagnostic_summary = p_diagnostic_summary
    then
      return jsonb_build_object('result', 'finished', 'jobId', existing_job.id);
    end if;
    return jsonb_build_object('result', 'conflict');
  end if;

  update public.compile_jobs
  set
    state = p_terminal_state::public.compile_job_state,
    duration_ms = p_duration_ms,
    safe_error_code = p_safe_error_code,
    artifact_hash = p_artifact_hash,
    diagnostic_summary = p_diagnostic_summary,
    finished_at = now()
  where id = existing_job.id;

  return jsonb_build_object('result', 'finished', 'jobId', existing_job.id);
end;
$$;

create function public.firelight_record_upload_evidence(
  p_user_id uuid,
  p_compile_job_id uuid,
  p_artifact_hash text,
  p_bytes_written integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  compiled_job public.compile_jobs%rowtype;
  evidence public.hardware_upload_evidence%rowtype;
begin
  if p_user_id is null
    or p_compile_job_id is null
    or p_artifact_hash is null
    or p_artifact_hash !~ '^[0-9a-f]{64}$'
    or p_bytes_written is null
    or p_bytes_written not between 1 and 30720
  then
    return jsonb_build_object('result', 'invalid');
  end if;

  select *
  into compiled_job
  from public.compile_jobs
  where id = p_compile_job_id
    and user_id = p_user_id
    and state = 'succeeded'
    and artifact_hash = p_artifact_hash
  for update;

  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;

  if not public.firelight_has_active_access(p_user_id) then
    return jsonb_build_object('result', 'not_entitled');
  end if;

  insert into public.hardware_upload_evidence (
    user_id,
    compile_job_id,
    lesson_id,
    lesson_version,
    source_hash,
    artifact_hash,
    bytes_written
  )
  values (
    compiled_job.user_id,
    compiled_job.id,
    compiled_job.lesson_id,
    compiled_job.lesson_version,
    compiled_job.source_hash,
    compiled_job.artifact_hash,
    p_bytes_written
  )
  on conflict (compile_job_id) do nothing;

  select *
  into evidence
  from public.hardware_upload_evidence
  where compile_job_id = compiled_job.id;

  return jsonb_build_object(
    'result', 'recorded',
    'evidence', jsonb_build_object(
      'id', evidence.id,
      'compileJobId', evidence.compile_job_id,
      'lessonId', evidence.lesson_id,
      'lessonVersion', evidence.lesson_version,
      'sourceHash', evidence.source_hash,
      'artifactHash', evidence.artifact_hash,
      'bytesWritten', evidence.bytes_written,
      'recordedAt', evidence.recorded_at,
      'attestation', evidence.attestation_kind
    )
  );
end;
$$;

create function public.firelight_require_completion_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.firelight_has_active_access(new.user_id) then
    raise exception 'active kit access is required to record progress'
      using errcode = '42501';
  end if;

  if new.status <> 'completed' then
    if new.completion_evidence_id is not null then
      raise exception 'upload evidence is only valid for completed progress'
        using errcode = '23514';
    end if;
    return new;
  end if;

  -- Terminal checkpoints are immutable apart from revision/update timestamps.
  -- This prevents a learner with direct REST access from moving one valid
  -- evidence reference to another lesson or changing the evidenced sketch.
  if tg_op = 'UPDATE' and old.status = 'completed' then
    if row(
      new.user_id,
      new.lesson_id,
      new.lesson_version,
      new.status,
      new.current_step,
      new.percentage,
      new.code_snapshot,
      new.completion_evidence_id,
      new.created_at
    ) is distinct from row(
      old.user_id,
      old.lesson_id,
      old.lesson_version,
      old.status,
      old.current_step,
      old.percentage,
      old.code_snapshot,
      old.completion_evidence_id,
      old.created_at
    ) then
      raise exception 'completed lesson progress cannot be changed'
        using errcode = '23514';
    end if;

    -- Completed rows created before this migration have no evidence. Keep
    -- them readable and revision-compatible, but never let them be repurposed.
    if old.completion_evidence_id is null then
      return new;
    end if;
  end if;

  if new.completion_evidence_id is null or new.code_snapshot is null then
    raise exception 'completed lesson progress requires compile and upload evidence'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.hardware_upload_evidence as evidence
    where evidence.id = new.completion_evidence_id
      and evidence.user_id = new.user_id
      and evidence.lesson_id = new.lesson_id
      and evidence.lesson_version = new.lesson_version
      and evidence.source_hash = pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(new.code_snapshot, 'UTF8'), 'sha256'),
        'hex'
      )
  ) then
    raise exception 'completion evidence does not match this learner and sketch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger lesson_progress_require_completion_evidence
before insert or update on public.lesson_progress
for each row execute function public.firelight_require_completion_evidence();

alter table public.hardware_upload_evidence enable row level security;

drop policy lesson_progress_insert_own on public.lesson_progress;
create policy lesson_progress_insert_own
on public.lesson_progress for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select public.firelight_has_current_access())
);

drop policy lesson_progress_update_own on public.lesson_progress;
create policy lesson_progress_update_own
on public.lesson_progress for update
to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and (select public.firelight_has_current_access())
);

-- Progress history is append/update-only. Account deletion still cascades from
-- auth.users, but a browser session cannot erase an evidenced terminal row.
drop policy lesson_progress_delete_own on public.lesson_progress;
revoke delete on table public.lesson_progress from authenticated;

create policy hardware_upload_evidence_select_own_or_admin
on public.hardware_upload_evidence for select
to authenticated
using (user_id = (select auth.uid()) or (select public.firelight_is_admin()));

revoke all on table public.hardware_upload_evidence from public, anon, authenticated;
grant select on table public.hardware_upload_evidence to authenticated;

revoke all on function public.firelight_begin_compile_job(uuid, text, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.firelight_finish_compile_job(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated;
revoke all on function public.firelight_record_upload_evidence(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.firelight_require_completion_evidence()
  from public, anon, authenticated;
revoke all on function public.firelight_has_active_access(uuid)
  from public, anon, authenticated;
revoke all on function public.firelight_has_current_access()
  from public, anon, authenticated;
revoke all on function public.firelight_sync_revoked_kit_access()
  from public, anon, authenticated;

grant execute on function public.firelight_begin_compile_job(uuid, text, integer, text, text)
  to service_role;
grant execute on function public.firelight_finish_compile_job(uuid, uuid, text, integer, text, text, text)
  to service_role;
grant execute on function public.firelight_record_upload_evidence(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.firelight_has_active_access(uuid)
  to service_role;
grant execute on function public.firelight_has_current_access()
  to authenticated;

comment on table public.hardware_upload_evidence is
  'Authenticated browser report recorded only after Web Serial returns upload success; this is not cryptographic proof from the physical board.';
comment on column public.compile_jobs.source_hash is
  'SHA-256 of the submitted sketch. Raw learner source is never stored in compile_jobs.';
comment on column public.compile_jobs.diagnostic_summary is
  'Bounded, sanitized compiler diagnostics. It must never contain raw sketch source.';
comment on function public.firelight_begin_compile_job(uuid, text, integer, text, text) is
  'Service-only atomic entitlement, concurrency, and rolling-rate gate for compilation.';
comment on function public.firelight_record_upload_evidence(uuid, uuid, text, integer) is
  'Service-only registration of browser-reported Web Serial success tied to a succeeded compile artifact.';
comment on function public.firelight_has_active_access(uuid) is
  'Authoritative entitlement check: grandfathered access or a presently claimed, unrevoked kit code.';
comment on function public.firelight_sync_revoked_kit_access() is
  'Atomically clears code-derived profile access when its final active kit claim is revoked, reassigned, or deleted.';
