-- Milestone 6 support/admin boundary.
--
-- Every RPC in this migration is service-role-only and also verifies that the
-- supplied actor is a current Firelight administrator. This lets the Worker
-- keep its server credential private while the database remains authoritative
-- about who is allowed to perform or inspect support operations.

-- Older profiles predate the strict Worker response parser. Normalize any
-- unsupported C0/DEL control characters before making the same boundary
-- permanent in PostgreSQL. PostgreSQL text cannot contain NUL, so the pattern
-- begins at U+0001 and otherwise matches the application validator exactly.
update public.profiles
set display_name = 'Builder'
where display_name ~ E'[\\x01-\\x1F\\x7F]';

alter table public.profiles
  add constraint profiles_display_name_supported_characters
  check (
    display_name !~ E'[\\x01-\\x1F\\x7F]'
  )
  not valid;

alter table public.profiles
  validate constraint profiles_display_name_supported_characters;

create or replace function public.firelight_handle_new_user()
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

  if char_length(requested_name) not between 1 and 40
    or requested_name ~ E'[\\x01-\\x1F\\x7F]'
  then
    requested_name := 'Builder';
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, requested_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

alter table public.admin_audit_log
  add constraint admin_audit_log_metadata_size
  check (pg_catalog.octet_length(metadata::text) <= 4096)
  not valid;

alter table public.admin_audit_log
  validate constraint admin_audit_log_metadata_size;

alter table public.admin_audit_log
  add constraint admin_audit_log_metadata_excludes_sensitive_payloads
  check (
    not (
      metadata ?| array[
        'code',
        'codeHash',
        'code_hash',
        'plaintext',
        'rawCode',
        'raw_code',
        'source',
        'sourceCode',
        'source_code'
      ]
    )
  )
  not valid;

alter table public.admin_audit_log
  validate constraint admin_audit_log_metadata_excludes_sensitive_payloads;

alter table public.admin_audit_log
  add constraint admin_audit_log_target_id_size
  check (target_id is null or char_length(target_id) <= 160)
  not valid;

alter table public.admin_audit_log
  validate constraint admin_audit_log_target_id_size;

create index profiles_admin_created_idx
  on public.profiles (created_at desc, id desc);

create index kit_codes_admin_created_idx
  on public.kit_codes (created_at desc, id desc);

create index kit_codes_admin_state_created_idx
  on public.kit_codes (state, created_at desc, id desc);

create index compile_jobs_admin_created_idx
  on public.compile_jobs (created_at desc, id desc);

create index compile_jobs_admin_state_created_idx
  on public.compile_jobs (state, created_at desc, id desc);

create index compile_jobs_admin_error_created_idx
  on public.compile_jobs (safe_error_code, created_at desc, id desc)
  where safe_error_code is not null;

create index admin_audit_log_action_created_idx
  on public.admin_audit_log (action, created_at desc, id desc);

create function public.firelight_require_admin_actor(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor_id is null or not exists (
    select 1
    from public.profiles as profile
    where profile.id = p_actor_id
      and profile.role = 'admin'
  ) then
    raise exception 'administrator privileges are required'
      using errcode = '42501';
  end if;
end;
$$;

create function public.firelight_validate_admin_page(
  p_limit integer,
  p_offset integer
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'page limit must be between 1 and 50'
      using errcode = '22023';
  end if;

  if p_offset is null or p_offset not between 0 and 10000 then
    raise exception 'page offset must be between 0 and 10000'
      using errcode = '22023';
  end if;
end;
$$;

create function public.firelight_admin_create_kit_batch(
  p_actor_id uuid,
  p_batch text,
  p_code_ids uuid[],
  p_code_hashes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_count integer;
  created_timestamp timestamptz := now();
begin
  perform public.firelight_require_admin_actor(p_actor_id);

  if p_batch is null
    or p_batch <> btrim(p_batch)
    or char_length(p_batch) not between 1 and 80
  then
    raise exception 'kit batch name must contain 1 to 80 trimmed characters'
      using errcode = '22023';
  end if;

  if p_code_ids is null
    or p_code_hashes is null
    or cardinality(p_code_ids) not between 1 and 100
    or cardinality(p_code_ids) <> cardinality(p_code_hashes)
  then
    raise exception 'kit batches must contain between 1 and 100 id/hash pairs'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(p_code_ids) as supplied(code_id)
    where supplied.code_id is null
  ) then
    raise exception 'kit batches require a database id for every hash'
      using errcode = '22023';
  end if;

  if (
    select count(distinct supplied.code_id)
    from unnest(p_code_ids) as supplied(code_id)
  ) <> cardinality(p_code_ids) then
    raise exception 'kit batches cannot contain duplicate ids'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(p_code_hashes) as supplied(code_hash)
    where supplied.code_hash is null
      or supplied.code_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'kit batches accept only lowercase HMAC-SHA-256 hashes'
      using errcode = '22023';
  end if;

  if (
    select count(distinct supplied.code_hash)
    from unnest(p_code_hashes) as supplied(code_hash)
  ) <> cardinality(p_code_hashes) then
    raise exception 'kit batches cannot contain duplicate hashes'
      using errcode = '22023';
  end if;

  insert into public.kit_codes (
    id,
    hash_version,
    code_hash,
    batch,
    kind,
    state,
    created_at
  )
  select
    supplied.code_id,
    1,
    supplied.code_hash,
    p_batch,
    'code',
    'issued',
    created_timestamp
  from unnest(p_code_ids, p_code_hashes) as supplied(code_id, code_hash);

  get diagnostics created_count = row_count;

  insert into public.admin_audit_log (
    actor_id,
    action,
    target_type,
    target_id,
    metadata
  )
  values (
    p_actor_id,
    'kit.batch_create',
    'kit_batch',
    p_batch,
    jsonb_build_object(
      'count', created_count,
      'hashVersion', 1
    )
  );

  return jsonb_build_object(
    'result', 'created',
    'batch', p_batch,
    'count', created_count,
    'createdAt', created_timestamp
  );
exception
  when unique_violation then
    raise exception 'one or more kit identifiers or hashes already exist'
      using errcode = '23505';
end;
$$;

create function public.firelight_admin_revoke_kit(
  p_actor_id uuid,
  p_kit_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_kit public.kit_codes%rowtype;
  previous_claimant uuid;
  previous_state text;
  revoked_timestamp timestamptz := now();
  failed_active_jobs integer := 0;
  access_revoked boolean := false;
begin
  perform public.firelight_require_admin_actor(p_actor_id);

  if p_kit_id is null then
    raise exception 'kit id is required'
      using errcode = '22023';
  end if;

  if p_reason is null
    or p_reason <> btrim(p_reason)
    or p_reason not in ('lost', 'damaged', 'support', 'security', 'other')
  then
    raise exception 'kit revocation reason is invalid'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('kit-revoke:' || p_kit_id::text, 0)
  );

  select *
  into requested_kit
  from public.kit_codes as code
  where code.id = p_kit_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if requested_kit.state = 'revoked' then
    return jsonb_build_object(
      'result', 'already_revoked',
      'id', requested_kit.id,
      'accessRevoked', false,
      'failedActiveCompileJobs', 0,
      'revokedAt', requested_kit.revoked_at
    );
  end if;

  previous_claimant := requested_kit.claimed_by;
  previous_state := requested_kit.state::text;

  -- Serialize the entitlement transition with compile-job creation for this
  -- learner. Once this lock is held, an older begin request has either committed
  -- a visible active job that the UPDATE below will fail, or a newer begin waits
  -- until it can observe the revoked entitlement.
  if previous_claimant is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('compile:' || previous_claimant::text, 0)
    );
  end if;

  update public.kit_codes
  set
    state = 'revoked',
    claimed_by = null,
    revoked_at = revoked_timestamp
  where id = requested_kit.id;

  if previous_claimant is not null then
    update public.compile_jobs
    set
      state = 'failed',
      duration_ms = least(
        60000::numeric,
        greatest(
          0::numeric,
          floor(
            extract(
              epoch from (revoked_timestamp - coalesce(started_at, created_at))
            ) * 1000
          )
        )
      )::integer,
      safe_error_code = 'ACCESS_REVOKED',
      artifact_hash = null,
      diagnostic_summary = 'Kit access was revoked before compilation completed.',
      finished_at = revoked_timestamp
    where user_id = previous_claimant
      and state in ('queued', 'running');

    get diagnostics failed_active_jobs = row_count;
    access_revoked := not public.firelight_has_active_access(previous_claimant);
  end if;

  insert into public.admin_audit_log (
    actor_id,
    action,
    target_type,
    target_id,
    metadata
  )
  values (
    p_actor_id,
    'kit.revoke',
    'kit',
    requested_kit.id::text,
    jsonb_build_object(
      'reason', p_reason,
      'previousState', previous_state,
      'accessRevoked', access_revoked,
      'failedActiveCompileJobs', failed_active_jobs
    )
  );

  return jsonb_build_object(
    'result', 'revoked',
    'id', requested_kit.id,
    'accessRevoked', access_revoked,
    'failedActiveCompileJobs', failed_active_jobs,
    'revokedAt', revoked_timestamp
  );
end;
$$;

create function public.firelight_admin_list_kits(
  p_actor_id uuid,
  p_query text,
  p_state text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_query text := lower(btrim(coalesce(p_query, '')));
  normalized_state text := nullif(lower(btrim(coalesce(p_state, ''))), '');
  page_items jsonb;
  has_more boolean;
begin
  perform public.firelight_require_admin_actor(p_actor_id);
  perform public.firelight_validate_admin_page(p_limit, p_offset);

  if char_length(normalized_query) > 120 then
    raise exception 'kit query cannot exceed 120 characters'
      using errcode = '22023';
  end if;

  if normalized_state is not null
    and normalized_state not in ('issued', 'claimed', 'revoked')
  then
    raise exception 'kit state filter is invalid'
      using errcode = '22023';
  end if;

  with page as (
    select
      code.id,
      code.batch,
      code.state,
      code.claimed_by,
      code.claimed_at,
      code.revoked_at,
      code.created_at
    from public.kit_codes as code
    left join public.profiles as claimant
      on claimant.id = code.claimed_by
    left join auth.users as claimant_user
      on claimant_user.id = code.claimed_by
    where (
      normalized_query = ''
      or position(normalized_query in lower(code.batch)) > 0
      or code.id::text = normalized_query
      or position(normalized_query in lower(coalesce(claimant.display_name, ''))) > 0
      or position(normalized_query in lower(coalesce(claimant_user.email, ''))) > 0
    )
      and (normalized_state is null or code.state::text = normalized_state)
    order by code.created_at desc, code.id desc
    limit p_limit + 1
    offset p_offset
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', bounded.id,
            'batch', bounded.batch,
            'state', bounded.state,
            'claimedBy', bounded.claimed_by,
            'claimedAt', bounded.claimed_at,
            'revokedAt', bounded.revoked_at,
            'createdAt', bounded.created_at
          )
          order by bounded.created_at desc, bounded.id desc
        )
        from (
          select *
          from page
          order by created_at desc, id desc
          limit p_limit
        ) as bounded
      ),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from page)
  into page_items, has_more;

  return jsonb_build_object('items', page_items, 'hasMore', has_more);
end;
$$;

create function public.firelight_admin_list_learners(
  p_actor_id uuid,
  p_query text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_query text := lower(btrim(coalesce(p_query, '')));
  page_items jsonb;
  has_more boolean;
begin
  perform public.firelight_require_admin_actor(p_actor_id);
  perform public.firelight_validate_admin_page(p_limit, p_offset);

  if char_length(normalized_query) > 120 then
    raise exception 'learner query cannot exceed 120 characters'
      using errcode = '22023';
  end if;

  with page as (
    select
      profile.id,
      coalesce(auth_user.email, '') as email,
      profile.display_name,
      profile.role,
      profile.access_source,
      case
        when profile.id::text = normalized_query then 0
        else 1
      end as match_rank,
      case
        when profile.access_source = 'grandfathered' then 'legacy-pilot'
        when profile.access_source = 'code' then active_code.batch
        else null
      end as activation_batch,
      coalesce(progress.completed_lessons, 0) as completed_lessons,
      coalesce(progress.progress_records, 0) as progress_records,
      profile.created_at,
      profile.updated_at
    from public.profiles as profile
    join auth.users as auth_user
      on auth_user.id = profile.id
    left join lateral (
      select code.batch
      from public.kit_codes as code
      where code.claimed_by = profile.id
        and code.state = 'claimed'
        and code.revoked_at is null
      order by code.claimed_at desc, code.id desc
      limit 1
    ) as active_code on true
    left join lateral (
      select
        count(*) filter (where progress_row.status = 'completed')::integer
          as completed_lessons,
        count(*)::integer as progress_records
      from public.lesson_progress as progress_row
      where progress_row.user_id = profile.id
    ) as progress on true
    where profile.role = 'learner'
      and (
        normalized_query = ''
        or position(normalized_query in lower(profile.display_name)) > 0
        or position(normalized_query in lower(coalesce(auth_user.email, ''))) > 0
        or profile.id::text = normalized_query
      )
    order by match_rank, profile.created_at desc, profile.id desc
    limit p_limit + 1
    offset p_offset
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', bounded.id,
            'email', bounded.email,
            'displayName', bounded.display_name,
            'role', bounded.role,
            'accessSource', bounded.access_source,
            'activationBatch', bounded.activation_batch,
            'completedLessons', bounded.completed_lessons,
            'progressRecords', bounded.progress_records,
            'createdAt', bounded.created_at,
            'updatedAt', bounded.updated_at
          )
          order by bounded.match_rank, bounded.created_at desc, bounded.id desc
        )
        from (
          select *
          from page
          order by match_rank, created_at desc, id desc
          limit p_limit
        ) as bounded
      ),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from page)
  into page_items, has_more;

  return jsonb_build_object('items', page_items, 'hasMore', has_more);
end;
$$;

create function public.firelight_admin_list_progress(
  p_actor_id uuid,
  p_user_id uuid,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  page_items jsonb;
  has_more boolean;
begin
  perform public.firelight_require_admin_actor(p_actor_id);
  perform public.firelight_validate_admin_page(p_limit, p_offset);

  if p_user_id is null then
    raise exception 'learner id is required'
      using errcode = '22023';
  end if;

  with page as (
    select
      progress.lesson_id,
      progress.lesson_version,
      progress.status,
      progress.current_step,
      progress.percentage,
      progress.completed_at,
      progress.updated_at
    from public.lesson_progress as progress
    where progress.user_id = p_user_id
    order by progress.updated_at desc, progress.lesson_id, progress.lesson_version desc
    limit p_limit + 1
    offset p_offset
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'lessonId', bounded.lesson_id,
            'lessonVersion', bounded.lesson_version,
            'status', bounded.status,
            'currentStep', bounded.current_step,
            'percentage', bounded.percentage,
            'completedAt', bounded.completed_at,
            'updatedAt', bounded.updated_at
          )
          order by bounded.updated_at desc, bounded.lesson_id,
            bounded.lesson_version desc
        )
        from (
          select *
          from page
          order by updated_at desc, lesson_id, lesson_version desc
          limit p_limit
        ) as bounded
      ),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from page)
  into page_items, has_more;

  return jsonb_build_object('items', page_items, 'hasMore', has_more);
end;
$$;

create function public.firelight_admin_list_compile_jobs(
  p_actor_id uuid,
  p_state text,
  p_error_code text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_state text := nullif(lower(btrim(coalesce(p_state, ''))), '');
  normalized_error text := nullif(btrim(coalesce(p_error_code, '')), '');
  page_items jsonb;
  has_more boolean;
begin
  perform public.firelight_require_admin_actor(p_actor_id);
  perform public.firelight_validate_admin_page(p_limit, p_offset);

  if normalized_state is not null
    and normalized_state not in ('queued', 'running', 'succeeded', 'failed')
  then
    raise exception 'compile state filter is invalid'
      using errcode = '22023';
  end if;

  if normalized_error is not null
    and normalized_error !~ '^[A-Z][A-Z0-9_]{0,63}$'
  then
    raise exception 'compile error filter is invalid'
      using errcode = '22023';
  end if;

  with page as (
    select
      job.id,
      job.user_id,
      job.lesson_id,
      job.lesson_version,
      job.state,
      job.duration_ms,
      job.safe_error_code,
      left(job.diagnostic_summary, 1000) as diagnostic_summary,
      job.created_at,
      job.finished_at
    from public.compile_jobs as job
    where (normalized_state is null or job.state::text = normalized_state)
      and (normalized_error is null or job.safe_error_code = normalized_error)
    order by job.created_at desc, job.id desc
    limit p_limit + 1
    offset p_offset
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', bounded.id,
            'userId', bounded.user_id,
            'lessonId', bounded.lesson_id,
            'lessonVersion', bounded.lesson_version,
            'state', bounded.state,
            'durationMs', bounded.duration_ms,
            'safeErrorCode', bounded.safe_error_code,
            'diagnosticSummary', bounded.diagnostic_summary,
            'createdAt', bounded.created_at,
            'finishedAt', bounded.finished_at
          )
          order by bounded.created_at desc, bounded.id desc
        )
        from (
          select *
          from page
          order by created_at desc, id desc
          limit p_limit
        ) as bounded
      ),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from page)
  into page_items, has_more;

  return jsonb_build_object('items', page_items, 'hasMore', has_more);
end;
$$;

create function public.firelight_admin_list_audit(
  p_actor_id uuid,
  p_action text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_action text := nullif(lower(btrim(coalesce(p_action, ''))), '');
  page_items jsonb;
  has_more boolean;
begin
  perform public.firelight_require_admin_actor(p_actor_id);
  perform public.firelight_validate_admin_page(p_limit, p_offset);

  if normalized_action is not null
    and normalized_action !~ '^[a-z][a-z0-9_.-]{1,79}$'
  then
    raise exception 'audit action filter is invalid'
      using errcode = '22023';
  end if;

  with page as (
    select
      audit.id,
      audit.actor_id,
      audit.action,
      audit.target_type,
      audit.target_id,
      audit.metadata,
      audit.created_at
    from public.admin_audit_log as audit
    where normalized_action is null or audit.action = normalized_action
    order by audit.created_at desc, audit.id desc
    limit p_limit + 1
    offset p_offset
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', bounded.id,
            'actorId', bounded.actor_id,
            'action', bounded.action,
            'targetType', bounded.target_type,
            'targetId', bounded.target_id,
            'metadata', bounded.metadata,
            'createdAt', bounded.created_at
          )
          order by bounded.created_at desc, bounded.id desc
        )
        from (
          select *
          from page
          order by created_at desc, id desc
          limit p_limit
        ) as bounded
      ),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from page)
  into page_items, has_more;

  return jsonb_build_object('items', page_items, 'hasMore', has_more);
end;
$$;

create function public.firelight_has_recent_session(
  p_user_id uuid,
  p_session_id uuid,
  p_max_age_seconds integer default 900
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_user_id is not null
    and p_session_id is not null
    and p_max_age_seconds between 1 and 900
    and exists (
      select 1
      from auth.sessions as session
      where session.id = p_session_id
        and session.user_id = p_user_id
        and session.created_at between
          pg_catalog.statement_timestamp()
            - pg_catalog.make_interval(secs => p_max_age_seconds)
          and pg_catalog.statement_timestamp()
    );
$$;

-- Admins must use the bounded support RPCs for support data. Direct browser
-- reads remain owner-only so an administrator session cannot bypass the safe
-- projections or inspect raw learner/source/artifact fields. The security
-- definer RPC owner performs only the explicitly projected admin reads above.
drop policy profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own
on public.profiles for select
to authenticated
using (id = (select auth.uid()));

drop policy lesson_progress_select_own_or_admin on public.lesson_progress;
create policy lesson_progress_select_own
on public.lesson_progress for select
to authenticated
using (user_id = (select auth.uid()));

drop policy compile_jobs_select_own_or_admin on public.compile_jobs;
create policy compile_jobs_select_own
on public.compile_jobs for select
to authenticated
using (user_id = (select auth.uid()));

drop policy hardware_upload_evidence_select_own_or_admin
  on public.hardware_upload_evidence;
create policy hardware_upload_evidence_select_own
on public.hardware_upload_evidence for select
to authenticated
using (user_id = (select auth.uid()));

drop policy admin_audit_log_select_admin on public.admin_audit_log;
revoke select on table public.admin_audit_log from authenticated;

revoke all on function public.firelight_require_admin_actor(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.firelight_validate_admin_page(integer, integer)
  from public, anon, authenticated, service_role;

revoke all on function public.firelight_admin_create_kit_batch(uuid, text, uuid[], text[])
  from public, anon, authenticated;
revoke all on function public.firelight_admin_revoke_kit(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.firelight_admin_list_kits(uuid, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.firelight_admin_list_learners(uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.firelight_admin_list_progress(uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.firelight_admin_list_compile_jobs(uuid, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.firelight_admin_list_audit(uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.firelight_has_recent_session(uuid, uuid, integer)
  from public, anon, authenticated;

grant execute on function public.firelight_admin_create_kit_batch(uuid, text, uuid[], text[])
  to service_role;
grant execute on function public.firelight_admin_revoke_kit(uuid, uuid, text)
  to service_role;
grant execute on function public.firelight_admin_list_kits(uuid, text, text, integer, integer)
  to service_role;
grant execute on function public.firelight_admin_list_learners(uuid, text, integer, integer)
  to service_role;
grant execute on function public.firelight_admin_list_progress(uuid, uuid, integer, integer)
  to service_role;
grant execute on function public.firelight_admin_list_compile_jobs(uuid, text, text, integer, integer)
  to service_role;
grant execute on function public.firelight_admin_list_audit(uuid, text, integer, integer)
  to service_role;
grant execute on function public.firelight_has_recent_session(uuid, uuid, integer)
  to service_role;

comment on function public.firelight_admin_create_kit_batch(uuid, text, uuid[], text[]) is
  'Service-only admin RPC. Atomically stores 1-100 caller-supplied revocation IDs with HMAC hashes and audits only the batch name, count, and hash version.';
comment on function public.firelight_admin_revoke_kit(uuid, uuid, text) is
  'Service-only admin RPC. Idempotently revokes a kit, clears authoritative code access, fails active compile jobs, and audits the first transition.';
comment on function public.firelight_admin_list_kits(uuid, text, text, integer, integer) is
  'Service-only admin RPC returning bounded kit inventory without code hashes or plaintext codes.';
comment on function public.firelight_admin_list_learners(uuid, text, integer, integer) is
  'Service-only admin RPC returning a bounded learner and email support projection.';
comment on function public.firelight_admin_list_progress(uuid, uuid, integer, integer) is
  'Service-only admin RPC returning progress metadata without learner code snapshots.';
comment on function public.firelight_admin_list_compile_jobs(uuid, text, text, integer, integer) is
  'Service-only admin RPC returning bounded sanitized diagnostics without source or artifact hashes.';
comment on function public.firelight_admin_list_audit(uuid, text, integer, integer) is
  'Service-only admin RPC returning bounded audit metadata.';
comment on function public.firelight_has_recent_session(uuid, uuid, integer) is
  'Service-only account-deletion guard bound to one exact auth.sessions row and its creation time; the maximum accepted freshness window is 900 seconds.';
