begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

select has_table(
  'public',
  'hardware_upload_evidence',
  'browser upload evidence table exists'
);
select has_column(
  'public',
  'compile_jobs',
  'artifact_hash',
  'compile jobs bind a succeeded artifact hash'
);
select has_column(
  'public',
  'lesson_progress',
  'completion_evidence_id',
  'lesson completion references upload evidence'
);
select ok(
  not has_column('public', 'compile_jobs', 'source'),
  'compile jobs never store raw learner source'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.hardware_upload_evidence'::regclass),
  'upload evidence has RLS enabled'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firelight_begin_compile_job(uuid,text,integer,text,text)',
    'execute'
  ),
  'browser role cannot create compile jobs directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.firelight_begin_compile_job(uuid,text,integer,text,text)',
    'execute'
  ),
  'service role can execute the atomic compile gate'
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
    '31111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'compile@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Compiler"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '32222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'hour@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Hourly"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '33333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'day@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Daily"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '34444444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'revoked@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Revoked"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

update public.profiles
set
  access_source = 'grandfathered',
  access_granted_at = now()
where id in (
  '31111111-1111-4111-8111-111111111111',
  '32222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
);

insert into public.kit_codes (
  code_hash,
  batch,
  state,
  claimed_by,
  claimed_at
)
values (
  repeat('f', 64),
  'revocation-test',
  'claimed',
  '34444444-4444-4444-8444-444444444444',
  now()
);
update public.profiles
set
  access_source = 'code',
  access_granted_at = now()
where id = '34444444-4444-4444-8444-444444444444';

select ok(
  public.firelight_has_active_access('34444444-4444-4444-8444-444444444444'),
  'a code-derived profile is entitled only while its claimed kit remains active'
);

select is(
  public.firelight_begin_compile_job(
    '34444444-4444-4444-8444-444444444444',
    'first-spark',
    1,
    repeat('7', 64),
    'arduino:avr:nano:cpu=atmega328old'
  ) ->> 'result',
  'started',
  'the live code claim can start compilation'
);

insert into public.compile_jobs (
  user_id,
  lesson_id,
  lesson_version,
  source_hash,
  state,
  duration_ms,
  artifact_hash,
  started_at,
  finished_at
)
values (
  '34444444-4444-4444-8444-444444444444',
  'morse-name',
  1,
  repeat('8', 64),
  'succeeded',
  100,
  repeat('9', 64),
  now(),
  now()
);

select set_config(
  'request.jwt.claims',
  '{"sub":"34444444-4444-4444-8444-444444444444","role":"authenticated"}',
  true
);
set local role authenticated;
select lives_ok(
  $$
    insert into public.lesson_progress (
      user_id,
      lesson_id,
      lesson_version,
      status,
      current_step,
      percentage
    )
    values (
      '34444444-4444-4444-8444-444444444444',
      'first-spark',
      1,
      'in_progress',
      'compile-sketch',
      50
    )
  $$,
  'an authenticated learner with an active claim can pass RLS and the evidence trigger'
);
reset role;

update public.kit_codes
set
  state = 'revoked',
  claimed_by = null,
  revoked_at = now()
where code_hash = repeat('f', 64);

select ok(
  (
    select access_source is null and access_granted_at is null
    from public.profiles
    where id = '34444444-4444-4444-8444-444444444444'
  ),
  'revoking a kit atomically clears its code-derived profile access'
);
select ok(
  not public.firelight_has_active_access('34444444-4444-4444-8444-444444444444'),
  'the authoritative entitlement helper denies revoked claims'
);
select is(
  public.firelight_finish_compile_job(
    '34444444-4444-4444-8444-444444444444',
    (
      select id
      from public.compile_jobs
      where user_id = '34444444-4444-4444-8444-444444444444'
        and lesson_id = 'first-spark'
    ),
    'succeeded',
    250,
    null,
    repeat('a', 64),
    'Compilation completed.'
  ) ->> 'result',
  'not_entitled',
  'revocation wins a race with terminal compile recording'
);
select is(
  (
    select state::text || ':' || safe_error_code
    from public.compile_jobs
    where user_id = '34444444-4444-4444-8444-444444444444'
      and lesson_id = 'first-spark'
  ),
  'failed:ACCESS_REVOKED',
  'an in-flight compile is failed instead of exposing a post-revocation artifact'
);
select is(
  public.firelight_record_upload_evidence(
    '34444444-4444-4444-8444-444444444444',
    (
      select id
      from public.compile_jobs
      where user_id = '34444444-4444-4444-8444-444444444444'
        and lesson_id = 'morse-name'
    ),
    repeat('9', 64),
    128
  ) ->> 'result',
  'not_entitled',
  'revoked access cannot record upload evidence for an earlier artifact'
);
select is(
  public.firelight_begin_compile_job(
    '34444444-4444-4444-8444-444444444444',
    'first-spark',
    1,
    repeat('7', 64),
    'arduino:avr:nano:cpu=atmega328old'
  ) ->> 'result',
  'not_entitled',
  'revoked access cannot start another compile'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"34444444-4444-4444-8444-444444444444","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  $$
    update public.lesson_progress
    set current_step = 'upload-sketch'
    where user_id = '34444444-4444-4444-8444-444444444444'
      and lesson_id = 'first-spark'
  $$,
  '42501',
  'revoked learners cannot update progress through RLS or the entitlement trigger'
);
reset role;

select is(
  public.firelight_begin_compile_job(
    '31111111-1111-4111-8111-111111111111',
    'first-spark',
    1,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to('void setup() {}', 'UTF8'), 'sha256'),
      'hex'
    ),
    'arduino:avr:nano:cpu=atmega328old'
  ) ->> 'result',
  'started',
  'an entitled learner starts a bounded compile job'
);
select is(
  public.firelight_begin_compile_job(
    '31111111-1111-4111-8111-111111111111',
    'first-spark',
    1,
    repeat('a', 64),
    'arduino:avr:nano:cpu=atmega328old'
  ) ->> 'result',
  'active',
  'one active compile is allowed per learner'
);
select is(
  (
    select count(*)
    from public.compile_jobs
    where user_id = '31111111-1111-4111-8111-111111111111'
      and state in ('queued', 'running')
  ),
  1::bigint,
  'the active-job conflict does not create another row'
);
select is(
  public.firelight_finish_compile_job(
    '31111111-1111-4111-8111-111111111111',
    (
      select id
      from public.compile_jobs
      where user_id = '31111111-1111-4111-8111-111111111111'
    ),
    'succeeded',
    250,
    null,
    repeat('b', 64),
    'Compilation completed.'
  ) ->> 'result',
  'finished',
  'a running compile transitions to succeeded'
);
select is(
  public.firelight_record_upload_evidence(
    '31111111-1111-4111-8111-111111111111',
    (
      select id
      from public.compile_jobs
      where user_id = '31111111-1111-4111-8111-111111111111'
    ),
    repeat('b', 64),
    128
  ) ->> 'result',
  'recorded',
  'browser-reported upload success is tied to the succeeded artifact'
);
select is(
  (
    public.firelight_record_upload_evidence(
      '31111111-1111-4111-8111-111111111111',
      (
        select id
        from public.compile_jobs
        where user_id = '31111111-1111-4111-8111-111111111111'
      ),
      repeat('b', 64),
      128
    ) -> 'evidence' ->> 'id'
  ),
  (
    select id::text
    from public.hardware_upload_evidence
    where user_id = '31111111-1111-4111-8111-111111111111'
  ),
  'upload evidence registration is idempotent for one compile job'
);
select is(
  public.firelight_record_upload_evidence(
    '32222222-2222-4222-8222-222222222222',
    (
      select id
      from public.compile_jobs
      where user_id = '31111111-1111-4111-8111-111111111111'
    ),
    repeat('b', 64),
    128
  ) ->> 'result',
  'invalid',
  'another learner cannot attest someone else''s compile job'
);
select is(
  public.firelight_record_upload_evidence(
    '31111111-1111-4111-8111-111111111111',
    (
      select id
      from public.compile_jobs
      where user_id = '31111111-1111-4111-8111-111111111111'
    ),
    repeat('b', 64),
    30721
  ) ->> 'result',
  'invalid',
  'upload evidence cannot exceed the Nano application flash boundary'
);

select lives_ok(
  $$
    insert into public.lesson_progress (
      user_id,
      lesson_id,
      lesson_version,
      status,
      current_step,
      percentage,
      code_snapshot,
      completion_evidence_id
    )
    values (
      '31111111-1111-4111-8111-111111111111',
      'first-spark',
      1,
      'completed',
      'finish-lesson',
      100,
      'void setup() {}',
      (
        select id
        from public.hardware_upload_evidence
        where user_id = '31111111-1111-4111-8111-111111111111'
      )
    )
  $$,
  'matching compile and upload evidence permits terminal progress'
);
select throws_ok(
  $$
    update public.lesson_progress
    set code_snapshot = 'void setup() { /* changed */ }'
    where user_id = '31111111-1111-4111-8111-111111111111'
      and lesson_id = 'first-spark'
  $$,
  '23514',
  'completed lesson progress cannot be changed',
  'an evidenced terminal sketch cannot be changed through direct REST access'
);
select throws_ok(
  $$
    update public.lesson_progress
    set lesson_id = 'morse-name'
    where user_id = '31111111-1111-4111-8111-111111111111'
      and lesson_id = 'first-spark'
  $$,
  '23514',
  'completed lesson progress cannot be changed',
  'evidence cannot be transplanted to another lesson'
);

alter table public.lesson_progress
  disable trigger lesson_progress_require_completion_evidence;
insert into public.lesson_progress (
  user_id,
  lesson_id,
  lesson_version,
  status,
  current_step,
  percentage,
  code_snapshot
)
values (
  '32222222-2222-4222-8222-222222222222',
  'first-spark',
  1,
  'completed',
  'legacy-finish',
  100,
  'legacy sketch'
);
alter table public.lesson_progress
  enable trigger lesson_progress_require_completion_evidence;

select lives_ok(
  $$
    update public.lesson_progress
    set revision = revision + 1
    where user_id = '32222222-2222-4222-8222-222222222222'
      and lesson_id = 'first-spark'
  $$,
  'a grandfathered terminal row remains revision-compatible'
);
select throws_ok(
  $$
    update public.lesson_progress
    set code_snapshot = 'repurposed legacy sketch'
    where user_id = '32222222-2222-4222-8222-222222222222'
      and lesson_id = 'first-spark'
  $$,
  '23514',
  'completed lesson progress cannot be changed',
  'a grandfathered terminal row cannot be repurposed'
);
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id,
      lesson_id,
      lesson_version,
      status,
      current_step,
      percentage,
      code_snapshot
    )
    values (
      '31111111-1111-4111-8111-111111111111',
      'morse-name',
      1,
      'completed',
      'finish-lesson',
      100,
      'void setup() {}'
    )
  $$,
  '23514',
  'completed lesson progress requires compile and upload evidence',
  'terminal progress fails without upload evidence'
);
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id,
      lesson_id,
      lesson_version,
      status,
      current_step,
      percentage,
      completion_evidence_id
    )
    values (
      '31111111-1111-4111-8111-111111111111',
      'morse-name',
      1,
      'in_progress',
      'edit-code',
      20,
      (
        select id
        from public.hardware_upload_evidence
        where user_id = '31111111-1111-4111-8111-111111111111'
      )
    )
  $$,
  '23514',
  'upload evidence is only valid for completed progress',
  'non-terminal progress cannot smuggle completion evidence'
);

insert into public.compile_jobs (
  user_id,
  lesson_id,
  lesson_version,
  source_hash,
  state,
  safe_error_code,
  duration_ms,
  started_at,
  finished_at
)
select
  '32222222-2222-4222-8222-222222222222',
  'first-spark',
  1,
  repeat('c', 64),
  'failed',
  'COMPILE_FAILED',
  10,
  now(),
  now()
from generate_series(1, 20);

select is(
  public.firelight_begin_compile_job(
    '32222222-2222-4222-8222-222222222222',
    'first-spark',
    1,
    repeat('c', 64),
    'arduino:avr:nano:cpu=atmega328old'
  ) ->> 'scope',
  'hour',
  'the rolling hourly limit rejects attempt 21'
);

insert into public.compile_jobs (
  user_id,
  lesson_id,
  lesson_version,
  source_hash,
  state,
  safe_error_code,
  duration_ms,
  created_at,
  started_at,
  finished_at
)
select
  '33333333-3333-4333-8333-333333333333',
  'first-spark',
  1,
  repeat('d', 64),
  'failed',
  'COMPILE_FAILED',
  10,
  now() - interval '2 hours',
  now() - interval '2 hours',
  now() - interval '2 hours'
from generate_series(1, 100);

select is(
  public.firelight_begin_compile_job(
    '33333333-3333-4333-8333-333333333333',
    'first-spark',
    1,
    repeat('d', 64),
    'arduino:avr:nano:cpu=atmega328old'
  ) ->> 'scope',
  'day',
  'the rolling daily limit rejects attempt 101'
);
select throws_ok(
  $$
    insert into public.compile_jobs (
      user_id,
      lesson_id,
      lesson_version,
      source_hash,
      state,
      safe_error_code,
      duration_ms,
      diagnostic_summary,
      started_at,
      finished_at
    )
    values (
      '32222222-2222-4222-8222-222222222222',
      'first-spark',
      1,
      repeat('e', 64),
      'failed',
      'COMPILE_FAILED',
      10,
      repeat('x', 8193),
      now(),
      now()
    )
  $$,
  '23514',
  'bounded diagnostic summaries reject oversized data'
);
select is(
  public.firelight_begin_compile_job(
    '31111111-1111-4111-8111-111111111111',
    'first-spark',
    1,
    repeat('a', 64),
    'arduino:avr:nano:cpu=atmega328old-wrong'
  ) ->> 'result',
  'invalid',
  'unsupported board targets are rejected by the database boundary'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"31111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.hardware_upload_evidence),
  1::bigint,
  'learner sees only their own upload evidence'
);
select throws_ok(
  $$
    insert into public.hardware_upload_evidence (
      user_id,
      compile_job_id,
      lesson_id,
      lesson_version,
      source_hash,
      artifact_hash,
      bytes_written
    )
    select
      user_id,
      id,
      lesson_id,
      lesson_version,
      source_hash,
      artifact_hash,
      1
    from public.compile_jobs
    where user_id = '31111111-1111-4111-8111-111111111111'
  $$,
  '42501',
  'browser role cannot write upload evidence directly'
);
select throws_ok(
  $$
    delete from public.lesson_progress
    where user_id = '31111111-1111-4111-8111-111111111111'
      and lesson_id = 'first-spark'
      and status = 'completed'
  $$,
  '42501',
  'an authenticated learner cannot delete evidenced terminal progress'
);

reset role;
update public.profiles
set role = 'admin'
where id = '32222222-2222-4222-8222-222222222222';

select set_config(
  'request.jwt.claims',
  '{"sub":"32222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.hardware_upload_evidence),
  0::bigint,
  'an authenticated admin cannot read another learner upload hashes directly'
);
reset role;

select * from finish();
rollback;
