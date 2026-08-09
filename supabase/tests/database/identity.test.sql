begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'kit_codes', 'kit code table exists');
select has_table('public', 'lesson_progress', 'progress table exists');
select has_table('public', 'compile_jobs', 'compile job table exists');
select has_table('public', 'admin_audit_log', 'audit table exists');
select has_column(
  'public',
  'lesson_progress',
  'revision',
  'progress has an optimistic revision token'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'profiles has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.kit_codes'::regclass),
  'kit codes has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.lesson_progress'::regclass),
  'lesson progress has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.compile_jobs'::regclass),
  'compile jobs has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.admin_audit_log'::regclass),
  'audit log has RLS enabled'
);

select has_function(
  'public',
  'claim_kit_code',
  array['uuid', 'text'],
  'atomic kit claim exists'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_kit_code(uuid,text)',
    'execute'
  ),
  'browser role cannot execute the digest claim RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_kit_code(uuid,text)',
    'execute'
  ),
  'service role can execute the digest claim RPC'
);
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'display_name', 'update'),
  'authenticated users may update display names'
);
select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'),
  'authenticated users cannot update roles'
);
select ok(
  not has_table_privilege('authenticated', 'public.kit_codes', 'select'),
  'authenticated users cannot read kit inventory'
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
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'a@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Alpha"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'b@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Beta"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

select is(
  (
    select count(*)
    from public.profiles
    where id in (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    )
  ),
  2::bigint,
  'signup trigger creates profiles'
);

update public.profiles
set
  access_source = 'grandfathered',
  access_granted_at = '2026-08-06T00:00:00Z'
where id in (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
);

insert into public.compile_jobs (
  id,
  user_id,
  lesson_id,
  lesson_version,
  source_hash,
  state,
  artifact_hash,
  duration_ms,
  started_at,
  finished_at
)
values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'first-spark',
  1,
  pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to('void setup() {}', 'UTF8'), 'sha256'),
    'hex'
  ),
  'succeeded',
  repeat('b', 64),
  100,
  now(),
  now()
);

insert into public.hardware_upload_evidence (
  id,
  user_id,
  compile_job_id,
  lesson_id,
  lesson_version,
  source_hash,
  artifact_hash,
  bytes_written
)
values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'first-spark',
  1,
  pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to('void setup() {}', 'UTF8'), 'sha256'),
    'hex'
  ),
  repeat('b', 64),
  128
);

insert into public.lesson_progress (
  user_id,
  lesson_id,
  lesson_version,
  status,
  current_step,
  percentage,
  code_snapshot,
  completion_evidence_id,
  completed_at
)
values
  (
    '11111111-1111-4111-8111-111111111111',
    'first-spark',
    1,
    'completed',
    'complete',
    100,
    'void setup() {}',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    now()
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'first-spark',
    1,
    'not_started',
    'intro',
    0,
    null,
    null,
    null
  );

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
set local role authenticated;

select is((select count(*) from public.profiles), 1::bigint, 'learner sees only own profile');
select is(
  (select count(*) from public.lesson_progress),
  1::bigint,
  'learner sees only own progress'
);

update public.profiles
set display_name = 'Alpha Updated'
where id = '11111111-1111-4111-8111-111111111111';

reset role;
select is(
  (
    select display_name
    from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'
  ),
  'Alpha Updated',
  'own display-name update succeeds'
);

set local role authenticated;
select throws_ok(
  $$
    update public.profiles
    set role = 'admin'
    where id = '11111111-1111-4111-8111-111111111111'
  $$,
  '42501',
  null,
  'role column cannot be self-promoted'
);
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id, lesson_id, lesson_version, status, current_step, percentage
    )
    values (
      '22222222-2222-4222-8222-222222222222',
      'morse-name',
      1,
      'not_started',
      'intro',
      0
    )
  $$,
  '42501',
  null,
  'learner cannot insert progress for another user'
);

reset role;
update public.profiles
set
  access_source = null,
  access_granted_at = null
where id = '22222222-2222-4222-8222-222222222222';

select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id, lesson_id, lesson_version, status, current_step, percentage
    )
    values (
      '22222222-2222-4222-8222-222222222222',
      'morse-name',
      1,
      'not_started',
      'intro',
      0
    )
  $$,
  '42501',
  null,
  'an unactivated learner cannot create progress'
);

reset role;
update public.profiles
set
  access_source = null,
  access_granted_at = null
where id = '11111111-1111-4111-8111-111111111111';

insert into public.kit_codes (code_hash, batch)
values (repeat('a', 64), 'rls-test');

select is(
  public.claim_kit_code(
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64)
  ) ->> 'result',
  'claimed',
  'issued kit code is claimed atomically'
);
select is(
  (
    select access_source::text
    from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'
  ),
  'code',
  'successful claim grants code access on the profile'
);
select is(
  public.claim_kit_code(
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64)
  ) ->> 'result',
  'claimed',
  'original claimant retry is idempotent'
);
select is(
  public.claim_kit_code(
    '22222222-2222-4222-8222-222222222222',
    repeat('a', 64)
  ) ->> 'result',
  'invalid',
  'another learner cannot redeem a consumed code'
);

select throws_ok(
  $$
    update public.lesson_progress
    set status = 'in_progress', percentage = 50, revision = revision + 1
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'first-spark'
      and lesson_version = 1
  $$,
  '23514',
  'completed lesson progress cannot be reopened',
  'completed progress is terminal'
);

insert into public.lesson_progress (
  user_id, lesson_id, lesson_version, status, current_step, percentage
)
values (
  '11111111-1111-4111-8111-111111111111',
  'morse-name',
  1,
  'in_progress',
  'edit-code',
  60
);

select throws_ok(
  $$
    update public.lesson_progress
    set percentage = 40, revision = revision + 1
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'morse-name'
      and lesson_version = 1
  $$,
  '23514',
  'lesson progress percentage cannot decrease',
  'autosave cannot regress progress percentage'
);

select is(
  (
    select revision
    from public.lesson_progress
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'morse-name'
      and lesson_version = 1
  ),
  1::bigint,
  'new progress starts at revision one'
);

update public.lesson_progress
set current_step = 'validate-code', percentage = 70, revision = 2
where user_id = '11111111-1111-4111-8111-111111111111'
  and lesson_id = 'morse-name'
  and lesson_version = 1;

update public.lesson_progress
set current_step = 'compile-sketch', percentage = 80
where user_id = '11111111-1111-4111-8111-111111111111'
  and lesson_id = 'morse-name'
  and lesson_version = 1;

select is(
  (
    select revision
    from public.lesson_progress
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'morse-name'
      and lesson_version = 1
  ),
  3::bigint,
  'pre-revision writes advance automatically during the phased rollout'
);

select throws_ok(
  $$
    update public.lesson_progress
    set current_step = 'connect-board', percentage = 90, revision = 2
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'morse-name'
      and lesson_version = 1
  $$,
  '40001',
  'lesson progress revision must advance by one',
  'explicit stale progress revisions fail instead of overwriting a newer save'
);

insert into public.admin_audit_log (actor_id, action, target_type)
values (
  '22222222-2222-4222-8222-222222222222',
  'kit.lookup',
  'kit'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  $$
    select count(*) from public.admin_audit_log
  $$,
  '42501',
  null,
  'learner has no direct audit-table access'
);

reset role;
update public.profiles
set role = 'admin'
where id = '22222222-2222-4222-8222-222222222222';

set local role authenticated;
select throws_ok(
  $$
    select count(*) from public.admin_audit_log
  $$,
  '42501',
  null,
  'admin must use the bounded service-only audit RPC'
);

reset role;
delete from auth.users
where id = '11111111-1111-4111-8111-111111111111';

select is(
  (
    select count(*)
    from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'
  ),
  0::bigint,
  'account deletion cascades profile cleanup'
);
select is(
  (
    select count(*)
    from public.lesson_progress
    where user_id = '11111111-1111-4111-8111-111111111111'
  ),
  0::bigint,
  'account deletion cascades progress cleanup'
);
select is(
  (select state::text from public.kit_codes where code_hash = repeat('a', 64)),
  'revoked',
  'deleted account leaves its kit consumed'
);
select is(
  (select claimed_by from public.kit_codes where code_hash = repeat('a', 64)),
  null::uuid,
  'deleted account de-identifies the consumed kit'
);
select is(
  public.claim_kit_code(
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64)
  ) ->> 'result',
  'invalid',
  'deleted user cannot reclaim access with a stale identity'
);

select * from finish();
rollback;
