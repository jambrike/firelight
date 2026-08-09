begin;

create extension if not exists pgtap with schema extensions;

select plan(32);

-- Hosted release acceptance runs again after the rollout has permanently
-- contracted browser writes. Recreate the compatibility boundary inside this
-- transaction so the expand/contract assertions remain repeatable; rollback
-- restores the real hosted boundary when the test completes.
grant select, insert, update
on table public.lesson_progress
to authenticated;

drop policy if exists lesson_progress_insert_own on public.lesson_progress;
create policy lesson_progress_insert_own
on public.lesson_progress for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select public.firelight_has_current_access())
);

drop policy if exists lesson_progress_update_own on public.lesson_progress;
create policy lesson_progress_update_own
on public.lesson_progress for update
to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and (select public.firelight_has_current_access())
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.lesson_progress'::regclass),
  'lesson progress remains protected by RLS'
);
select ok(
  has_table_privilege('authenticated', 'public.lesson_progress', 'select')
  and has_table_privilege('authenticated', 'public.lesson_progress', 'insert')
  and has_table_privilege('authenticated', 'public.lesson_progress', 'update')
  and not has_table_privilege('authenticated', 'public.lesson_progress', 'delete'),
  'expand state retains the previous authenticated read/insert/update boundary'
);
select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'lesson_progress'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ),
  2::bigint,
  'expand state retains authenticated insert/update policies'
);
select ok(
  has_table_privilege('service_role', 'public.lesson_progress', 'select')
  and has_table_privilege('service_role', 'public.lesson_progress', 'insert')
  and has_table_privilege('service_role', 'public.lesson_progress', 'update'),
  'expand state grants the Worker service read/insert/update access'
);
select ok(
  not has_table_privilege('service_role', 'public.lesson_progress', 'delete'),
  'service progress access is append/update-only'
);
select ok(
  (
    select prosecdef and pg_get_userbyid(proowner) = 'postgres'
    from pg_proc
    where oid = 'public.firelight_finalize_progress_write_boundary()'::regprocedure
  ),
  'the boundary finalizer is postgres-owned and security definer'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.firelight_finalize_progress_write_boundary()',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.firelight_finalize_progress_write_boundary()',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.firelight_finalize_progress_write_boundary()',
    'execute'
  ),
  'no API role can execute the boundary finalizer'
);

-- Deliberate privilege/policy drift proves the finalizer contracts the actual
-- catalog state, including PostgreSQL's '*' representation for FOR ALL.
grant insert, update, delete
on table public.lesson_progress
to public, anon;

create policy lesson_progress_drift_all
on public.lesson_progress for all
to anon
using (true)
with check (true);

select ok(
  has_table_privilege('anon', 'public.lesson_progress', 'insert')
  and has_table_privilege('anon', 'public.lesson_progress', 'update')
  and has_table_privilege('anon', 'public.lesson_progress', 'delete')
  and (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'lesson_progress'
      and cmd = 'ALL'
  ) = 1,
  'the test injects PUBLIC/anon grants and a FOR ALL policy as contraction drift'
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
    'progress-alpha@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Progress Alpha"}'::jsonb,
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
    'progress-beta@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Progress Beta"}'::jsonb,
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
where id = '11111111-1111-4111-8111-111111111111';

insert into public.kit_codes (
  code_hash,
  batch,
  state,
  claimed_by,
  claimed_at
)
values (
  repeat('b', 64),
  'progress-boundary-test',
  'claimed',
  '22222222-2222-4222-8222-222222222222',
  now()
);

update public.profiles
set
  access_source = 'code',
  access_granted_at = now()
where id = '22222222-2222-4222-8222-222222222222';

select ok(
  public.firelight_has_active_access('22222222-2222-4222-8222-222222222222'),
  'the compatibility-path learner starts with an active entitlement'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
set local role authenticated;
select lives_ok(
  $$
    insert into public.lesson_progress (
      user_id,
      lesson_id,
      lesson_version,
      revision,
      status,
      current_step,
      percentage
    )
    values (
      '22222222-2222-4222-8222-222222222222',
      'first-spark',
      1,
      1,
      'in_progress',
      'compile-sketch',
      50
    )
  $$,
  'the previous authenticated write path remains valid before finalization'
);
reset role;

update public.kit_codes
set
  state = 'revoked',
  claimed_by = null,
  revoked_at = now()
where code_hash = repeat('b', 64);

select ok(
  not public.firelight_has_active_access('22222222-2222-4222-8222-222222222222'),
  'the compatibility-path learner is no longer entitled after revocation'
);

select is(
  public.firelight_finalize_progress_write_boundary(),
  '{
    "status": "finalized",
    "anon_insert": false,
    "anon_update": false,
    "anon_delete": false,
    "authenticated_select": true,
    "authenticated_insert": false,
    "authenticated_update": false,
    "authenticated_delete": false,
    "service_select": true,
    "service_insert": true,
    "service_update": true,
    "service_delete": false,
    "mutation_policy_count": 0
  }'::jsonb,
  'postgres contracts progress writes to the canonical Worker-only boundary'
);
select is(
  public.firelight_finalize_progress_write_boundary(),
  '{
    "status": "finalized",
    "anon_insert": false,
    "anon_update": false,
    "anon_delete": false,
    "authenticated_select": true,
    "authenticated_insert": false,
    "authenticated_update": false,
    "authenticated_delete": false,
    "service_select": true,
    "service_insert": true,
    "service_update": true,
    "service_delete": false,
    "mutation_policy_count": 0
  }'::jsonb,
  'the boundary finalizer is idempotent'
);

select ok(
  not has_table_privilege('anon', 'public.lesson_progress', 'insert')
  and not has_table_privilege('anon', 'public.lesson_progress', 'update')
  and not has_table_privilege('anon', 'public.lesson_progress', 'delete'),
  'contracted anonymous access has no mutation privilege even after drift'
);
select ok(
  has_table_privilege('authenticated', 'public.lesson_progress', 'select')
  and not has_table_privilege('authenticated', 'public.lesson_progress', 'insert')
  and not has_table_privilege('authenticated', 'public.lesson_progress', 'update')
  and not has_table_privilege('authenticated', 'public.lesson_progress', 'delete'),
  'contracted authenticated access is owner-readable and never mutable'
);
select ok(
  has_table_privilege('service_role', 'public.lesson_progress', 'select')
  and has_table_privilege('service_role', 'public.lesson_progress', 'insert')
  and has_table_privilege('service_role', 'public.lesson_progress', 'update')
  and not has_table_privilege('service_role', 'public.lesson_progress', 'delete'),
  'contracted service access is read/insert/update-only'
);
select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'lesson_progress'
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  ),
  0::bigint,
  'no browser mutation policies remain after contraction'
);
select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'lesson_progress'
      and policyname = 'lesson_progress_select_own'
      and cmd = 'SELECT'
  ),
  1::bigint,
  'owner-only progress SELECT policy remains after contraction'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
set local role authenticated;

select is(
  (select count(*) from public.lesson_progress),
  0::bigint,
  'owner SELECT does not expose another learner progress'
);
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id, lesson_id, lesson_version, status, current_step, percentage
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'first-spark',
      1,
      'in_progress',
      'fabricated-step',
      10
    )
  $$,
  '42501',
  null,
  'a fabricated checkpoint cannot bypass the Worker'
);
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id, lesson_id, lesson_version, status, current_step, percentage
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'first-spark',
      1,
      'in_progress',
      'edit-code',
      99
    )
  $$,
  '42501',
  null,
  'a fabricated percentage cannot bypass the Worker'
);
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id, lesson_id, lesson_version, status, current_step, percentage
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'first-spark',
      999,
      'in_progress',
      'edit-code',
      20
    )
  $$,
  '42501',
  null,
  'a fabricated lesson version cannot bypass the Worker'
);
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id, lesson_id, lesson_version, status, current_step, percentage
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'morse-name',
      1,
      'in_progress',
      'meet-the-build',
      0
    )
  $$,
  '42501',
  null,
  'locked-lesson progress cannot bypass prerequisite validation'
);
select throws_ok(
  $$
    update public.lesson_progress
    set current_step = 'fabricated-step', percentage = 99
    where user_id = '11111111-1111-4111-8111-111111111111'
  $$,
  '42501',
  null,
  'authenticated learners cannot update progress directly'
);
select throws_ok(
  $$
    delete from public.lesson_progress
    where user_id = '11111111-1111-4111-8111-111111111111'
  $$,
  '42501',
  null,
  'authenticated learners cannot delete progress directly'
);

reset role;
set local role service_role;

select lives_ok(
  $$
    insert into public.lesson_progress (
      user_id,
      lesson_id,
      lesson_version,
      revision,
      status,
      current_step,
      percentage
    )
    values (
      '11111111-1111-4111-8111-111111111111',
      'first-spark',
      1,
      1,
      'in_progress',
      'meet-the-build',
      0
    )
  $$,
  'the Worker service can insert progress for an actively entitled learner'
);
select lives_ok(
  $$
    update public.lesson_progress
    set
      revision = 2,
      current_step = 'edit-code',
      percentage = 20
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'first-spark'
      and lesson_version = 1
  $$,
  'the Worker service can update progress for an actively entitled learner'
);

reset role;
select is(
  (
    select revision
    from public.lesson_progress
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'first-spark'
      and lesson_version = 1
  ),
  2::bigint,
  'service role persists the Worker-validated revision'
);
select is(
  (
    select current_step
    from public.lesson_progress
    where user_id = '11111111-1111-4111-8111-111111111111'
      and lesson_id = 'first-spark'
      and lesson_version = 1
  ),
  'edit-code',
  'service role persists the Worker-validated checkpoint'
);

set local role service_role;
select throws_ok(
  $$
    insert into public.lesson_progress (
      user_id,
      lesson_id,
      lesson_version,
      revision,
      status,
      current_step,
      percentage
    )
    values (
      '22222222-2222-4222-8222-222222222222',
      'morse-name',
      1,
      1,
      'in_progress',
      'meet-the-build',
      0
    )
  $$,
  '42501',
  null,
  'the entitlement trigger denies a service insert after kit revocation'
);
select throws_ok(
  $$
    update public.lesson_progress
    set
      revision = 2,
      current_step = 'upload-sketch',
      percentage = 75
    where user_id = '22222222-2222-4222-8222-222222222222'
      and lesson_id = 'first-spark'
      and lesson_version = 1
  $$,
  '42501',
  null,
  'the entitlement trigger denies a service update after kit revocation'
);
reset role;

select is(
  (
    select revision::text || ':' || current_step
    from public.lesson_progress
    where user_id = '22222222-2222-4222-8222-222222222222'
      and lesson_id = 'first-spark'
      and lesson_version = 1
  ),
  '1:compile-sketch',
  'revoked service writes leave the existing progress row unchanged'
);

select * from finish();
rollback;
