alter table public.lesson_progress
  add column revision bigint not null default 1
  check (revision > 0);

create function public.firelight_enforce_lesson_progress_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- During the phased Worker rollout, the preceding release does not send a
  -- revision. PostgreSQL presents that as an unchanged value, so advance it
  -- here. The revision-aware Worker sends old + 1 explicitly and is accepted
  -- by the same trigger without a write outage between deployments.
  if new.revision = old.revision then
    new.revision := old.revision + 1;
  elsif new.revision <> old.revision + 1 then
    raise exception 'lesson progress revision must advance by one'
      using errcode = '40001';
  end if;

  return new;
end;
$$;

create trigger lesson_progress_enforce_revision
before update on public.lesson_progress
for each row execute function public.firelight_enforce_lesson_progress_revision();

revoke all on function public.firelight_enforce_lesson_progress_revision()
  from public, anon, authenticated;

comment on column public.lesson_progress.revision is
  'Monotonic optimistic-concurrency token supplied by the lesson autosave client.';
