-- Expand first: the deployed Worker now writes progress with service credentials,
-- while authenticated INSERT/UPDATE grants and owner policies remain available
-- to the previous release until the post-deploy canary has proved the new path.
grant select, insert, update
on table public.lesson_progress
to service_role;

revoke delete
on table public.lesson_progress
from service_role;

comment on table public.lesson_progress is
  'Owner-readable lesson history. During rollout, authenticated owner writes remain compatible until the postgres-only boundary finalizer contracts mutations to the validated Worker service path.';

create function public.firelight_finalize_progress_write_boundary()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  mutation_policy record;
  mutation_policy_count bigint;
begin
  -- Serialize the contract step with all progress readers and writers. This
  -- prevents a browser mutation from straddling the privilege/policy change.
  lock table public.lesson_progress in access exclusive mode;

  revoke insert, update, delete
  on table public.lesson_progress
  from public, anon, authenticated;

  for mutation_policy in
    select policy_row.polname
    from pg_catalog.pg_policy as policy_row
    where policy_row.polrelid = 'public.lesson_progress'::pg_catalog.regclass
      and policy_row.polcmd in ('*', 'a', 'w', 'd')
  loop
    execute pg_catalog.format(
      'drop policy %I on public.lesson_progress',
      mutation_policy.polname
    );
  end loop;

  select pg_catalog.count(*)
  into mutation_policy_count
  from pg_catalog.pg_policy as policy_row
  where policy_row.polrelid = 'public.lesson_progress'::pg_catalog.regclass
    and policy_row.polcmd in ('*', 'a', 'w', 'd');

  if pg_catalog.has_table_privilege(
      'anon',
      'public.lesson_progress',
      'insert'
    )
    or pg_catalog.has_table_privilege(
      'anon',
      'public.lesson_progress',
      'update'
    )
    or pg_catalog.has_table_privilege(
      'anon',
      'public.lesson_progress',
      'delete'
    )
    or not pg_catalog.has_table_privilege(
      'authenticated',
      'public.lesson_progress',
      'select'
    )
    or pg_catalog.has_table_privilege(
      'authenticated',
      'public.lesson_progress',
      'insert'
    )
    or pg_catalog.has_table_privilege(
      'authenticated',
      'public.lesson_progress',
      'update'
    )
    or pg_catalog.has_table_privilege(
      'authenticated',
      'public.lesson_progress',
      'delete'
    )
    or not pg_catalog.has_table_privilege(
      'service_role',
      'public.lesson_progress',
      'select'
    )
    or not pg_catalog.has_table_privilege(
      'service_role',
      'public.lesson_progress',
      'insert'
    )
    or not pg_catalog.has_table_privilege(
      'service_role',
      'public.lesson_progress',
      'update'
    )
    or pg_catalog.has_table_privilege(
      'service_role',
      'public.lesson_progress',
      'delete'
    )
    or mutation_policy_count <> 0
  then
    raise exception 'lesson progress write boundary did not reach its canonical state'
      using errcode = '55000';
  end if;

  execute pg_catalog.format(
    'comment on table public.lesson_progress is %L',
    'Owner-readable lesson history; inserts and updates are service-only after Worker curriculum and entitlement validation.'
  );

  return pg_catalog.jsonb_build_object(
    'status', 'finalized',
    'anon_insert', false,
    'anon_update', false,
    'anon_delete', false,
    'authenticated_select', true,
    'authenticated_insert', false,
    'authenticated_update', false,
    'authenticated_delete', false,
    'service_select', true,
    'service_insert', true,
    'service_update', true,
    'service_delete', false,
    'mutation_policy_count', 0
  );
end;
$$;

alter function public.firelight_finalize_progress_write_boundary() owner to postgres;

revoke all
on function public.firelight_finalize_progress_write_boundary()
from public, anon, authenticated, service_role;

comment on function public.firelight_finalize_progress_write_boundary() is
  'Idempotent postgres-only rollout finalizer: locks progress, removes API-role mutation grants/policies, validates the Worker-only boundary, and returns its canonical state.';
