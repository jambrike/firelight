begin;

create extension if not exists pgtap with schema extensions;

select plan(117);

select has_function(
  'public',
  'firelight_admin_create_kit_batch',
  array['uuid', 'text', 'uuid[]', 'text[]'],
  'admin kit batch RPC exists'
);
select has_function(
  'public',
  'firelight_admin_revoke_kit',
  array['uuid', 'uuid', 'text'],
  'admin kit revocation RPC exists'
);
select has_function(
  'public',
  'firelight_admin_list_kits',
  array['uuid', 'text', 'text', 'integer', 'integer'],
  'paginated kit inventory RPC exists'
);
select has_function(
  'public',
  'firelight_admin_list_learners',
  array['uuid', 'text', 'integer', 'integer'],
  'paginated learner lookup RPC exists'
);
select has_function(
  'public',
  'firelight_admin_list_progress',
  array['uuid', 'uuid', 'integer', 'integer'],
  'paginated learner progress RPC exists'
);
select has_function(
  'public',
  'firelight_admin_list_compile_jobs',
  array['uuid', 'text', 'text', 'integer', 'integer'],
  'paginated compile diagnostics RPC exists'
);
select has_function(
  'public',
  'firelight_admin_list_audit',
  array['uuid', 'text', 'integer', 'integer'],
  'paginated audit history RPC exists'
);
select has_function(
  'public',
  'firelight_has_recent_session',
  array['uuid', 'uuid', 'integer'],
  'exact-session freshness RPC exists'
);

select ok(
  position(
    'pg_catalog.hashtextextended(''compile:'' || previous_claimant::text, 0)'
    in pg_get_functiondef(
      'public.firelight_admin_revoke_kit(uuid,uuid,text)'::regprocedure
    )
  ) > 0,
  'kit revocation shares the per-learner compile creation lock'
);

select has_table('auth', 'sessions', 'Supabase Auth exposes its session table');
select has_column('auth', 'sessions', 'id', 'auth sessions have an exact session id');
select has_column('auth', 'sessions', 'user_id', 'auth sessions bind sessions to users');
select has_column('auth', 'sessions', 'created_at', 'auth sessions record creation time');

select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.admin_audit_log'::regclass
      and conname = 'admin_audit_log_metadata_size'
      and contype = 'c'
  ),
  'audit metadata has a database size constraint'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.admin_audit_log'::regclass
      and conname = 'admin_audit_log_metadata_excludes_sensitive_payloads'
      and contype = 'c'
  ),
  'audit metadata rejects source and code payload keys'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_display_name_supported_characters'
      and contype = 'c'
      and convalidated
  ),
  'profile display names have a validated control-character constraint'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'lesson_progress'
      and policyname = 'lesson_progress_select_own'
  ),
  'raw progress snapshots are restricted to their learner outside the admin RPC'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'compile_jobs'
      and policyname = 'compile_jobs_select_own'
  ),
  'compile diagnostics are restricted to their learner outside the admin RPC'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_select_own'
      and cmd = 'SELECT'
      and qual not like '%firelight_is_admin%'
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_select_own_or_admin'
  ),
  'direct profile reads are owner-only outside the support RPC'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'hardware_upload_evidence'
      and policyname = 'hardware_upload_evidence_select_own'
      and cmd = 'SELECT'
      and qual not like '%firelight_is_admin%'
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'hardware_upload_evidence'
      and policyname = 'hardware_upload_evidence_select_own_or_admin'
  ),
  'direct upload-evidence reads are owner-only outside the service boundary'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'admin_audit_log'
      and cmd = 'SELECT'
  ),
  'the audit table has no direct browser select policy'
);
select ok(
  has_table_privilege('authenticated', 'public.profiles', 'select'),
  'authenticated learners retain direct access to their owner-filtered profile'
);
select ok(
  has_table_privilege(
    'authenticated',
    'public.hardware_upload_evidence',
    'select'
  ),
  'authenticated learners retain owner-filtered upload-evidence access'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.admin_audit_log',
    'select'
  ),
  'authenticated browser sessions have no direct audit-table grant'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_admin_create_kit_batch(uuid,text,uuid[],text[])',
    'execute'
  ),
  'authenticated clients cannot create kit batches directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_admin_revoke_kit(uuid,uuid,text)',
    'execute'
  ),
  'authenticated clients cannot revoke kits directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_admin_list_kits(uuid,text,text,integer,integer)',
    'execute'
  ),
  'authenticated clients cannot inspect kit inventory directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_admin_list_learners(uuid,text,integer,integer)',
    'execute'
  ),
  'authenticated clients cannot use support lookup directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_admin_list_progress(uuid,uuid,integer,integer)',
    'execute'
  ),
  'authenticated clients cannot inspect other progress through the RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_admin_list_compile_jobs(uuid,text,text,integer,integer)',
    'execute'
  ),
  'authenticated clients cannot inspect support diagnostics directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_admin_list_audit(uuid,text,integer,integer)',
    'execute'
  ),
  'authenticated clients cannot use the audit RPC directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_has_recent_session(uuid,uuid,integer)',
    'execute'
  ),
  'authenticated clients cannot ask the database to bless deletion freshness'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_admin_create_kit_batch(uuid,text,uuid[],text[])',
    'execute'
  ),
  'service role can call the kit batch RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_admin_revoke_kit(uuid,uuid,text)',
    'execute'
  ),
  'service role can call the kit revocation RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_admin_list_kits(uuid,text,text,integer,integer)',
    'execute'
  ),
  'service role can call the kit inventory RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_admin_list_learners(uuid,text,integer,integer)',
    'execute'
  ),
  'service role can call the learner lookup RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_admin_list_progress(uuid,uuid,integer,integer)',
    'execute'
  ),
  'service role can call the progress RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_admin_list_compile_jobs(uuid,text,text,integer,integer)',
    'execute'
  ),
  'service role can call the diagnostics RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_admin_list_audit(uuid,text,integer,integer)',
    'execute'
  ),
  'service role can call the audit RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_has_recent_session(uuid,uuid,integer)',
    'execute'
  ),
  'service role can call the exact-session freshness RPC'
);

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'),
  'profile roles remain protected from browser updates'
);
select ok(
  not has_table_privilege('authenticated', 'public.kit_codes', 'select'),
  'kit hashes remain unreadable to authenticated clients'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change,
  email_change_token_new
)
values (
  '00000000-0000-0000-0000-000000000000',
  '60000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'unsafe-signup@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('display_name', 'Unsafe' || chr(1) || 'Name'),
  now(),
  now(),
  '',
  '',
  '',
  ''
);

select is(
  (
    select display_name
    from public.profiles
    where id = '60000000-0000-4000-8000-000000000001'
  ),
  'Builder',
  'signup normalizes an unsupported display name before admin projection'
);

delete from auth.users
where id = '60000000-0000-4000-8000-000000000001';

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change,
  email_change_token_new
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '61111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'admin@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Camp Admin"}'::jsonb,
    now() - interval '4 days',
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '62222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'support.one@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Support One"}'::jsonb,
    now() - interval '3 days',
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '63333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'support.two@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Support Two"}'::jsonb,
    now() - interval '2 days',
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '64444444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'outsider@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Ordinary Learner"}'::jsonb,
    now() - interval '1 day',
    now(),
    '',
    '',
    '',
    ''
  );

update public.profiles
set role = 'admin'
where id = '61111111-1111-4111-8111-111111111111';

update public.profiles
set created_at = case id
  when '61111111-1111-4111-8111-111111111111'::uuid then now() - interval '4 days'
  when '62222222-2222-4222-8222-222222222222'::uuid then now() - interval '3 days'
  when '63333333-3333-4333-8333-333333333333'::uuid then now() - interval '2 days'
  else now() - interval '1 day'
end;

select set_config(
  'request.jwt.claims',
  '{"sub":"64444444-4444-4444-8444-444444444444","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  $$
    update public.profiles
    set role = 'admin'
    where id = '64444444-4444-4444-8444-444444444444'
  $$,
  '42501',
  'a learner cannot self-promote even though the row is their own'
);
select throws_ok(
  $$
    update public.profiles
    set display_name = E'Ordinary\tLearner'
    where id = '64444444-4444-4444-8444-444444444444'
  $$,
  '23514',
  'profile updates reject tabs in alignment with the API parser'
);
select throws_ok(
  $$
    update public.profiles
    set display_name = 'Unsafe' || chr(1) || 'Name'
    where id = '64444444-4444-4444-8444-444444444444'
  $$,
  '23514',
  'profile updates reject unsupported C0 control characters'
);
select throws_ok(
  $$
    update public.profiles
    set display_name = 'Unsafe' || chr(127) || 'Name'
    where id = '64444444-4444-4444-8444-444444444444'
  $$,
  '23514',
  'profile updates reject the DEL control character'
);
reset role;

-- This newer learner deliberately collides with the exact UUID query through
-- display-name substring matching. The exact profile id must still rank first.
update public.profiles
set display_name = '62222222-2222-4222-8222-222222222222'
where id = '64444444-4444-4444-8444-444444444444';

create temporary table admin_rpc_results (
  name text primary key,
  payload jsonb not null
);

insert into admin_rpc_results (name, payload)
values (
  'batch',
  public.firelight_admin_create_kit_batch(
    '61111111-1111-4111-8111-111111111111',
    'pilot-august',
    array[
      '71111111-1111-4111-8111-111111111111'::uuid,
      '72222222-2222-4222-8222-222222222222'::uuid,
      '73333333-3333-4333-8333-333333333333'::uuid
    ],
    array[repeat('a', 64), repeat('b', 64), repeat('c', 64)]
  )
);

select is(
  (select payload ->> 'result' from admin_rpc_results where name = 'batch'),
  'created',
  'an admin actor creates a kit batch atomically'
);
select is(
  (select (payload ->> 'count')::integer from admin_rpc_results where name = 'batch'),
  3,
  'batch response reports the number of hashes inserted'
);
select is(
  (select count(*) from public.kit_codes where batch = 'pilot-august'),
  3::bigint,
  'all supplied HMAC hashes are stored'
);
select is(
  (
    select code_hash
    from public.kit_codes
    where id = '72222222-2222-4222-8222-222222222222'
  ),
  repeat('b', 64),
  'each one-time plaintext export id maps to its exact stored HMAC'
);
select ok(
  position(
    repeat('a', 64)
    in (select payload::text from admin_rpc_results where name = 'batch')
  ) = 0,
  'batch response never returns a code hash'
);
select is(
  (
    select metadata ->> 'count'
    from public.admin_audit_log
    where action = 'kit.batch_create'
      and target_id = 'pilot-august'
  ),
  '3',
  'batch creation appends bounded aggregate-only audit metadata'
);
select ok(
  (
    select pg_catalog.octet_length(metadata::text) <= 4096
    from public.admin_audit_log
    where action = 'kit.batch_create'
      and target_id = 'pilot-august'
  ),
  'batch audit metadata stays within the database bound'
);

select throws_ok(
  $$
    select public.firelight_admin_create_kit_batch(
      '61111111-1111-4111-8111-111111111111',
      'duplicate-input',
      array[
        '74444444-4444-4444-8444-444444444444'::uuid,
        '75555555-5555-4555-8555-555555555555'::uuid
      ],
      array[repeat('d', 64), repeat('d', 64)]
    )
  $$,
  '22023',
  'duplicate hashes inside one batch are rejected'
);
select throws_ok(
  $$
    select public.firelight_admin_create_kit_batch(
      '61111111-1111-4111-8111-111111111111',
      'invalid-hash',
      array['76666666-6666-4666-8666-666666666666'::uuid],
      array[repeat('A', 64)]
    )
  $$,
  '22023',
  'non-canonical hashes are rejected before storage'
);
select throws_ok(
  $$
    select public.firelight_admin_create_kit_batch(
      '61111111-1111-4111-8111-111111111111',
      'oversized-batch',
      array(
        select gen_random_uuid()
        from generate_series(1, 101)
      ),
      array(
        select lpad(to_hex(series.value), 64, '0')
        from generate_series(1, 101) as series(value)
      )
    )
  $$,
  '22023',
  'kit batches are capped at one hundred hashes'
);
select throws_ok(
  $$
    select public.firelight_admin_create_kit_batch(
      '61111111-1111-4111-8111-111111111111',
      'existing-hash',
      array[
        '77777777-7777-4777-8777-777777777777'::uuid,
        '78888888-8888-4888-8888-888888888888'::uuid
      ],
      array[repeat('d', 64), repeat('a', 64)]
    )
  $$,
  '23505',
  'an already stored hash aborts the whole batch'
);
select is(
  (select count(*) from public.kit_codes where code_hash = repeat('d', 64)),
  0::bigint,
  'a conflicting hash rolls back every otherwise-new hash in its batch'
);
select throws_ok(
  $$
    select public.firelight_admin_create_kit_batch(
      '61111111-1111-4111-8111-111111111111',
      'mismatched-pairs',
      array['79999999-9999-4999-8999-999999999999'::uuid],
      array[repeat('d', 64), repeat('e', 64)]
    )
  $$,
  '22023',
  'every generated kit id must have exactly one HMAC'
);
select throws_ok(
  $$
    select public.firelight_admin_create_kit_batch(
      '61111111-1111-4111-8111-111111111111',
      'duplicate-ids',
      array[
        '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
        '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
      ],
      array[repeat('d', 64), repeat('e', 64)]
    )
  $$,
  '22023',
  'one batch cannot alias two plaintext codes to the same revocation id'
);
select throws_ok(
  $$
    select public.firelight_admin_create_kit_batch(
      '64444444-4444-4444-8444-444444444444',
      'forbidden-batch',
      array['7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid],
      array[repeat('d', 64)]
    )
  $$,
  '42501',
  'a service call cannot substitute a non-admin actor for batch creation'
);
select throws_ok(
  $$
    select public.firelight_admin_list_learners(
      '64444444-4444-4444-8444-444444444444',
      null,
      20,
      0
    )
  $$,
  '42501',
  'a service call cannot substitute a non-admin actor for support lookup'
);

select is(
  public.claim_kit_code(
    '62222222-2222-4222-8222-222222222222',
    repeat('a', 64)
  ) ->> 'result',
  'claimed',
  'the learner can claim one HMAC-created kit'
);

insert into public.lesson_progress (
  user_id,
  lesson_id,
  lesson_version,
  status,
  current_step,
  percentage,
  code_snapshot
)
values
  (
    '62222222-2222-4222-8222-222222222222',
    'first-spark',
    1,
    'in_progress',
    'compile-sketch',
    70,
    'RAW-SKETCH-ONE-MUST-NOT-RETURN'
  ),
  (
    '62222222-2222-4222-8222-222222222222',
    'morse-name',
    1,
    'in_progress',
    'edit-code',
    40,
    'RAW-SKETCH-TWO-MUST-NOT-RETURN'
  );

select is(
  public.firelight_begin_compile_job(
    '62222222-2222-4222-8222-222222222222',
    'first-spark',
    1,
    repeat('d', 64),
    'arduino:avr:nano:cpu=atmega328old'
  ) ->> 'result',
  'started',
  'a claimed kit can start an active compile before revocation'
);

insert into admin_rpc_results (name, payload)
select
  'revocation',
  public.firelight_admin_revoke_kit(
    '61111111-1111-4111-8111-111111111111',
    code.id,
    'support'
  )
from public.kit_codes as code
where code.code_hash = repeat('a', 64);

select is(
  (select payload ->> 'result' from admin_rpc_results where name = 'revocation'),
  'revoked',
  'an admin revokes a claimed kit'
);
select is(
  (select (payload ->> 'accessRevoked')::boolean from admin_rpc_results where name = 'revocation'),
  true,
  'revocation reports that authoritative learner access was removed'
);
select is(
  (select (payload ->> 'failedActiveCompileJobs')::integer from admin_rpc_results where name = 'revocation'),
  1,
  'revocation reports the active compile it failed'
);
select is(
  (
    select state::text
    from public.kit_codes
    where code_hash = repeat('a', 64)
  ),
  'revoked',
  'the kit inventory records the terminal revoked state'
);
select ok(
  (
    select access_source is null and access_granted_at is null
    from public.profiles
    where id = '62222222-2222-4222-8222-222222222222'
  ),
  'the existing entitlement trigger clears code-derived profile access'
);
select ok(
  not public.firelight_has_active_access('62222222-2222-4222-8222-222222222222'),
  'the authoritative entitlement helper rejects the revoked learner'
);
select is(
  (
    select state::text || ':' || safe_error_code
    from public.compile_jobs
    where user_id = '62222222-2222-4222-8222-222222222222'
  ),
  'failed:ACCESS_REVOKED',
  'revocation fails the in-flight compile inside the same transaction'
);
select is(
  (
    select count(*)
    from public.admin_audit_log
    where action = 'kit.revoke'
      and target_id = (
        select id::text
        from public.kit_codes
        where code_hash = repeat('a', 64)
      )
  ),
  1::bigint,
  'the first revocation writes one audit entry'
);
select is(
  (
    select metadata ->> 'reason'
    from public.admin_audit_log
    where action = 'kit.revoke'
      and target_id = (
        select id::text
        from public.kit_codes
        where code_hash = repeat('a', 64)
      )
  ),
  'support',
  'revocation audit records only the bounded reason category'
);

insert into admin_rpc_results (name, payload)
select
  'repeat-revocation',
  public.firelight_admin_revoke_kit(
    '61111111-1111-4111-8111-111111111111',
    code.id,
    'support'
  )
from public.kit_codes as code
where code.code_hash = repeat('a', 64);

select is(
  (select payload ->> 'result' from admin_rpc_results where name = 'repeat-revocation'),
  'already_revoked',
  'a revocation retry is idempotent'
);
select is(
  (
    select count(*)
    from public.admin_audit_log
    where action = 'kit.revoke'
      and target_id = (
        select id::text
        from public.kit_codes
        where code_hash = repeat('a', 64)
      )
  ),
  1::bigint,
  'an idempotent retry does not duplicate the transition audit'
);
select is(
  public.firelight_admin_revoke_kit(
    '61111111-1111-4111-8111-111111111111',
    '6fffffff-ffff-4fff-8fff-ffffffffffff',
    'support'
  ) ->> 'result',
  'not_found',
  'a missing kit returns the stable not-found result'
);
select throws_ok(
  $$
    select public.firelight_admin_revoke_kit(
      '61111111-1111-4111-8111-111111111111',
      (
        select id
        from public.kit_codes
        where code_hash = repeat('b', 64)
      ),
      'free-form reason containing details'
    )
  $$,
  '22023',
  'revocation accepts only the bounded reason categories'
);
select is(
  public.firelight_admin_revoke_kit(
    '61111111-1111-4111-8111-111111111111',
    (
      select id
      from public.kit_codes
      where code_hash = repeat('c', 64)
    ),
    'security'
  ) ->> 'result',
  'revoked',
  'an unclaimed issued kit can also be revoked'
);

insert into public.compile_jobs (
  user_id,
  lesson_id,
  lesson_version,
  source_hash,
  state,
  duration_ms,
  safe_error_code,
  diagnostic_summary,
  started_at,
  finished_at
)
values (
  '63333333-3333-4333-8333-333333333333',
  'distance-scout',
  1,
  repeat('e', 64),
  'failed',
  125,
  'COMPILE_FAILED',
  repeat('z', 4000),
  now(),
  now()
);

insert into admin_rpc_results (name, payload)
values
  (
    'kits-page',
    public.firelight_admin_list_kits(
      '61111111-1111-4111-8111-111111111111',
      'pilot-august',
      null,
      1,
      0
    )
  ),
  (
    'learners-page',
    public.firelight_admin_list_learners(
      '61111111-1111-4111-8111-111111111111',
      null,
      1,
      0
    )
  ),
  (
    'learner-search',
    public.firelight_admin_list_learners(
      '61111111-1111-4111-8111-111111111111',
      'SUPPORT.ONE@EXAMPLE.TEST',
      20,
      0
    )
  ),
  (
    'progress-page',
    public.firelight_admin_list_progress(
      '61111111-1111-4111-8111-111111111111',
      '62222222-2222-4222-8222-222222222222',
      1,
      0
    )
  ),
  (
    'compile-page',
    public.firelight_admin_list_compile_jobs(
      '61111111-1111-4111-8111-111111111111',
      'failed',
      'COMPILE_FAILED',
      20,
      0
    )
  ),
  (
    'audit-page',
    public.firelight_admin_list_audit(
      '61111111-1111-4111-8111-111111111111',
      'kit.revoke',
      1,
      0
    )
  );

select is(
  (select jsonb_array_length(payload -> 'items') from admin_rpc_results where name = 'kits-page'),
  1,
  'kit inventory enforces the requested page size'
);
select is(
  (select (payload ->> 'hasMore')::boolean from admin_rpc_results where name = 'kits-page'),
  true,
  'kit inventory reports another page'
);
select ok(
  (
    select
      (payload -> 'items' -> 0) ? 'createdAt'
      and not ((payload -> 'items' -> 0) ? 'codeHash')
      and not ((payload -> 'items' -> 0) ? 'hashVersion')
      and position(repeat('b', 64) in payload::text) = 0
    from admin_rpc_results
    where name = 'kits-page'
  ),
  'kit inventory uses camelCase support fields and never exposes hashes'
);
select is(
  jsonb_array_length(
    public.firelight_admin_list_kits(
      '61111111-1111-4111-8111-111111111111',
      null,
      'revoked',
      20,
      0
    ) -> 'items'
  ),
  2,
  'kit inventory state filtering is exact'
);
select throws_ok(
  $$
    select public.firelight_admin_list_kits(
      '61111111-1111-4111-8111-111111111111',
      null,
      'deleted',
      20,
      0
    )
  $$,
  '22023',
  'invalid kit states are rejected'
);
select throws_ok(
  $$
    select public.firelight_admin_list_kits(
      '61111111-1111-4111-8111-111111111111',
      null,
      null,
      51,
      0
    )
  $$,
  '22023',
  'admin pages cannot exceed fifty records'
);
select throws_ok(
  $$
    select public.firelight_admin_list_kits(
      '61111111-1111-4111-8111-111111111111',
      null,
      null,
      20,
      10001
    )
  $$,
  '22023',
  'admin offsets are capped to avoid unbounded scans'
);

select is(
  (select (payload ->> 'hasMore')::boolean from admin_rpc_results where name = 'learners-page'),
  true,
  'learner lookup is paginated independently from administrators'
);
select is(
  (select jsonb_array_length(payload -> 'items') from admin_rpc_results where name = 'learner-search'),
  1,
  'learner lookup searches normalized email safely'
);
select is(
  (
    select payload -> 'items' -> 0 ->> 'displayName'
    from admin_rpc_results
    where name = 'learner-search'
  ),
  'Support One',
  'learner lookup returns the expected camelCase support projection'
);
select is(
  (
    select payload -> 'items' -> 0 ->> 'progressRecords'
    from admin_rpc_results
    where name = 'learner-search'
  ),
  '2',
  'learner lookup returns aggregate progress counts without snapshots'
);
select is(
  public.firelight_admin_list_learners(
    '61111111-1111-4111-8111-111111111111',
    '62222222-2222-4222-8222-222222222222',
    1,
    0
  ) -> 'items' -> 0 ->> 'id',
  '62222222-2222-4222-8222-222222222222',
  'an exact learner UUID outranks newer substring matches deterministically'
);
select ok(
  position(
    'admin@example.test'
    in public.firelight_admin_list_learners(
      '61111111-1111-4111-8111-111111111111',
      null,
      20,
      0
    )::text
  ) = 0,
  'learner lookup excludes administrator profiles'
);

select is(
  (select jsonb_array_length(payload -> 'items') from admin_rpc_results where name = 'progress-page'),
  1,
  'learner progress respects its page size'
);
select is(
  (select (payload ->> 'hasMore')::boolean from admin_rpc_results where name = 'progress-page'),
  true,
  'learner progress reports another page'
);
select ok(
  (
    select
      (payload -> 'items' -> 0) ? 'lessonId'
      and (payload -> 'items' -> 0) ? 'currentStep'
      and not ((payload -> 'items' -> 0) ? 'codeSnapshot')
      and position('RAW-SKETCH' in payload::text) = 0
    from admin_rpc_results
    where name = 'progress-page'
  ),
  'admin progress never returns raw learner code snapshots'
);

select is(
  (select jsonb_array_length(payload -> 'items') from admin_rpc_results where name = 'compile-page'),
  1,
  'compile diagnostics apply state and safe error filters'
);
select is(
  (
    select char_length(payload -> 'items' -> 0 ->> 'diagnosticSummary')
    from admin_rpc_results
    where name = 'compile-page'
  ),
  1000,
  'returned compiler diagnostics are capped to one thousand characters'
);
select ok(
  (
    select
      not ((payload -> 'items' -> 0) ? 'sourceHash')
      and not ((payload -> 'items' -> 0) ? 'artifactHash')
      and position(repeat('e', 64) in payload::text) = 0
    from admin_rpc_results
    where name = 'compile-page'
  ),
  'compile diagnostics never return source or artifact hashes'
);
select throws_ok(
  $$
    select public.firelight_admin_list_compile_jobs(
      '61111111-1111-4111-8111-111111111111',
      null,
      'not-safe',
      20,
      0
    )
  $$,
  '22023',
  'compile diagnostic filters accept only safe error codes'
);

select is(
  (select jsonb_array_length(payload -> 'items') from admin_rpc_results where name = 'audit-page'),
  1,
  'audit history respects its page size'
);
select is(
  (select (payload ->> 'hasMore')::boolean from admin_rpc_results where name = 'audit-page'),
  true,
  'audit history reports another matching revocation entry'
);
select ok(
  (
    select
      (payload -> 'items' -> 0) ? 'actorId'
      and (payload -> 'items' -> 0) ? 'targetType'
      and pg_catalog.octet_length(
        (payload -> 'items' -> 0 -> 'metadata')::text
      ) <= 4096
      and position(repeat('a', 64) in payload::text) = 0
    from admin_rpc_results
    where name = 'audit-page'
  ),
  'audit history is camelCase, bounded, and contains no code hashes'
);

select throws_ok(
  $$
    insert into public.admin_audit_log (
      actor_id,
      action,
      target_type,
      metadata
    )
    values (
      '61111111-1111-4111-8111-111111111111',
      'support.oversized',
      'support',
      jsonb_build_object('note', repeat('x', 4096))
    )
  $$,
  '23514',
  'oversized audit metadata is rejected for every writer'
);
select throws_ok(
  $$
    insert into public.admin_audit_log (
      actor_id,
      action,
      target_type,
      metadata
    )
    values (
      '61111111-1111-4111-8111-111111111111',
      'support.sensitive',
      'support',
      jsonb_build_object('sourceCode', 'raw sketch')
    )
  $$,
  '23514',
  'audit writers cannot add raw source payload fields'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"61111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  $$
    select public.firelight_admin_list_learners(
      '61111111-1111-4111-8111-111111111111',
      null,
      20,
      0
    )
  $$,
  '42501',
  'even an authenticated admin must use the Worker service boundary'
);
select is(
  (select count(*) from public.lesson_progress),
  0::bigint,
  'authenticated admins cannot bypass the safe progress projection'
);
select is(
  (select count(*) from public.compile_jobs),
  0::bigint,
  'authenticated admins cannot bypass bounded compile diagnostics'
);
select is(
  (select count(*) from public.profiles),
  1::bigint,
  'authenticated admins can directly read only their own profile'
);
select throws_ok(
  $$
    select count(*) from public.admin_audit_log
  $$,
  '42501',
  'authenticated admins cannot read the audit table outside the bounded RPC'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"62222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.lesson_progress),
  2::bigint,
  'learners retain read access to their own progress rows'
);
select is(
  (select count(*) from public.compile_jobs),
  1::bigint,
  'learners retain read access to their own compile diagnostics'
);
reset role;

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at
)
values
  (
    '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '62222222-2222-4222-8222-222222222222',
    statement_timestamp() - interval '60 seconds',
    statement_timestamp()
  ),
  (
    '6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '62222222-2222-4222-8222-222222222222',
    statement_timestamp() - interval '901 seconds',
    statement_timestamp()
  );

select ok(
  public.firelight_has_recent_session(
    '62222222-2222-4222-8222-222222222222',
    '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    900
  ),
  'an exact session created inside the bounded window is recent'
);
select ok(
  not public.firelight_has_recent_session(
    '63333333-3333-4333-8333-333333333333',
    '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    900
  ),
  'a recent session cannot be replayed for another user'
);
select ok(
  not public.firelight_has_recent_session(
    '62222222-2222-4222-8222-222222222222',
    '6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    900
  ),
  'a session outside the creation-time window is stale'
);
select ok(
  not public.firelight_has_recent_session(
    '62222222-2222-4222-8222-222222222222',
    '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    901
  ),
  'the freshness RPC refuses windows above nine hundred seconds'
);
select ok(
  public.firelight_has_recent_session(
    '62222222-2222-4222-8222-222222222222',
    '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  'the default freshness window is nine hundred seconds'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"62222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  $$
    select public.firelight_has_recent_session(
      '62222222-2222-4222-8222-222222222222',
      '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      900
    )
  $$,
  '42501',
  'a browser cannot call the deletion freshness guard directly'
);
reset role;

select * from finish();
rollback;
