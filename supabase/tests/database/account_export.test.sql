begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.kit_codes'::regclass),
  'kit activation export remains protected by RLS'
);
select ok(
  has_column_privilege('authenticated', 'public.kit_codes', 'id', 'select')
  and has_column_privilege('authenticated', 'public.kit_codes', 'batch', 'select')
  and has_column_privilege('authenticated', 'public.kit_codes', 'kind', 'select')
  and has_column_privilege('authenticated', 'public.kit_codes', 'claimed_at', 'select'),
  'learner role can read only the safe activation projection'
);
select ok(
  not has_column_privilege('authenticated', 'public.kit_codes', 'hash_version', 'select')
  and not has_column_privilege('authenticated', 'public.kit_codes', 'code_hash', 'select')
  and not has_column_privilege('authenticated', 'public.kit_codes', 'state', 'select')
  and not has_column_privilege('authenticated', 'public.kit_codes', 'claimed_by', 'select')
  and not has_column_privilege('authenticated', 'public.kit_codes', 'revoked_at', 'select')
  and not has_column_privilege('authenticated', 'public.kit_codes', 'created_at', 'select'),
  'kit HMAC, inventory, claimant, and revocation fields remain unreadable'
);
select ok(
  not has_table_privilege('authenticated', 'public.kit_codes', 'select'),
  'safe export columns do not grant learner access to the complete kit table'
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
    'export-a@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Export Alpha"}'::jsonb,
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
    'export-b@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Export Beta"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

insert into public.kit_codes (
  id,
  code_hash,
  batch,
  state,
  claimed_by,
  claimed_at
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repeat('a', 64),
    'export-alpha',
    'claimed',
    '11111111-1111-4111-8111-111111111111',
    now()
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    repeat('b', 64),
    'export-beta',
    'claimed',
    '22222222-2222-4222-8222-222222222222',
    now()
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    repeat('c', 64),
    'unclaimed-inventory',
    'issued',
    null,
    null
  );

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
set local role authenticated;

select is(
  (select count(id) from public.kit_codes),
  1::bigint,
  'learner sees only their claimed activation'
);
select is(
  (select id from public.kit_codes),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'safe activation belongs to the JWT subject'
);
select throws_ok(
  $$select code_hash from public.kit_codes$$,
  '42501',
  'learner cannot select the kit HMAC even for their own activation'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
set local role authenticated;

select is(
  (select id from public.kit_codes),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
  'changing the JWT subject changes the single visible activation'
);

reset role;
select * from finish();
rollback;
