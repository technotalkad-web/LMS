-- 0098_record_protection.sql — P0 record protection (ADR 0003 §3, items 8–11;
-- ADR 0004 item 3 DDL). Hand-apply in the SQL editor, staging first, then
-- production in the P1 sitting (ADR 0007 step 5). Idempotent: safe to re-run.
--
-- PRECONDITION (gate SQL, must return 0 rows; the DO block below refuses to
-- continue otherwise):
--
--   select storage_prefix, count(*) from public.course_versions
--   group by 1 having count(*) > 1;
--
-- Where it returns rows, repoint the duplicates first (ADR 0007 step 3,
-- ops/release-v1.3.0-repoint.md) and record each one in ops/INCIDENT_LEDGER.md.
--
-- What it does:
--   1. course_versions.storage_prefix is unique: no two versions can ever
--      share a folder again (the step-0 incident class).
--   2. Repeats 0032_course_versions_unique_per_package.sql under the same
--      guards, so a replay from 0098 alone ends with the per-package version
--      constraint and without the legacy per-course one.
--   3. Write-once versions: a 'ready' version's storage_prefix, launch_url and
--      manifest_type can no longer change (course_version_frozen). The
--      uploading → ready transition may still set them; storage_driver is not
--      frozen (the R2 copy script flips it after verification).
--   4. Delete guard: a course or a course version that holds learner attempts
--      cannot be deleted (learner_history_exists). Exempt: requests carrying
--      the service_role JWT claim (CI purge cascade, seed-demo, the uploading
--      sweeper, the package route). Direct SQL-editor deletes carry no claim
--      and are refused, which is intended. "Learner attempt" until 0099:
--      any attempt whose user does not currently hold super_owner, admin or
--      data_analyst in the attempt's organisation; a missing membership counts
--      as a learner, so former members' history still blocks.
--   5. ADR 0004: package_validations gains verdict 'blocked' (cross-course
--      collision) and the super_owner override columns.
--
-- Creates no table or view (no new Data API grants); function execute grants
-- follow docs/MIGRATIONS.md and the BLUEPRINT Conventions paragraph.

begin;

-- ---------------------------------------------------------------------------
-- 1. Unique storage prefix
-- ---------------------------------------------------------------------------
do $$
declare
  dupes integer;
begin
  select count(*) into dupes
  from (
    select storage_prefix
    from public.course_versions
    group by storage_prefix
    having count(*) > 1
  ) d;
  if dupes > 0 then
    raise exception '0098 refused: % storage_prefix value(s) are shared by more than one course_versions row. Run the gate SQL, repoint the duplicates (ADR 0007 step 3) and apply again.', dupes;
  end if;
end
$$;

create unique index if not exists course_versions_storage_prefix_key
  on public.course_versions (storage_prefix);

-- ---------------------------------------------------------------------------
-- 2. 0032 repeated (per-package version numbers)
-- ---------------------------------------------------------------------------
alter table public.course_versions
  drop constraint if exists course_versions_course_id_version_number_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'course_versions_package_id_version_number_key'
      and conrelid = 'public.course_versions'::regclass
  ) then
    alter table public.course_versions
      add constraint course_versions_package_id_version_number_key
      unique (package_id, version_number);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Write-once at version level
-- ---------------------------------------------------------------------------
create or replace function public.course_versions_freeze_ready()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.upload_status = 'ready' and (
       new.storage_prefix is distinct from old.storage_prefix
    or new.launch_url     is distinct from old.launch_url
    or new.manifest_type  is distinct from old.manifest_type
  ) then
    raise exception 'course_version_frozen'
      using detail = format(
              'course_versions %s is ready: storage_prefix, launch_url and manifest_type are write-once.',
              old.id
            ),
            hint = 'Upload a new version and make it current instead.';
  end if;
  return new;
end
$$;

revoke execute on function public.course_versions_freeze_ready() from public, anon, authenticated;
grant execute on function public.course_versions_freeze_ready() to service_role;

drop trigger if exists course_versions_freeze_ready on public.course_versions;
create trigger course_versions_freeze_ready
  before update on public.course_versions
  for each row execute function public.course_versions_freeze_ready();

-- ---------------------------------------------------------------------------
-- 4. Delete guard (learner history is never deleted)
-- ---------------------------------------------------------------------------
-- The exemption is the PostgREST role claim (auth.role() semantics, written
-- out so it never depends on the auth schema's helper). The claim is
-- transaction-local and survives security definer execution and FK
-- cascades; current_user would be the function or table owner there, so it
-- is never used for this check. nullif() matters: casting an empty setting
-- to jsonb throws.

create or replace function public.guard_learner_history_course_versions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  learner_attempts bigint;
begin
  if claim_role = 'service_role' then
    return old;
  end if;
  select count(*) into learner_attempts
  from public.course_attempts a
  where a.course_version_id = old.id
    and not exists (
      select 1
      from public.organization_members m
      where m.organization_id = a.organization_id
        and m.user_id = a.user_id
        and m.role::text in ('super_owner', 'admin', 'data_analyst')
    );
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'course_versions %s holds %s learner attempt(s). Deactivate the package or make another version current instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10).';
  end if;
  return old;
end
$$;

create or replace function public.guard_learner_history_courses()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  learner_attempts bigint;
begin
  if claim_role = 'service_role' then
    return old;
  end if;
  select count(*) into learner_attempts
  from public.course_attempts a
  join public.course_versions v on v.id = a.course_version_id
  where v.course_id = old.id
    and not exists (
      select 1
      from public.organization_members m
      where m.organization_id = a.organization_id
        and m.user_id = a.user_id
        and m.role::text in ('super_owner', 'admin', 'data_analyst')
    );
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'courses %s holds %s learner attempt(s). Deactivate the course instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10).';
  end if;
  return old;
end
$$;

revoke execute on function public.guard_learner_history_course_versions() from public, anon, authenticated;
grant execute on function public.guard_learner_history_course_versions() to service_role;
revoke execute on function public.guard_learner_history_courses() from public, anon, authenticated;
grant execute on function public.guard_learner_history_courses() to service_role;

drop trigger if exists course_versions_guard_learner_history on public.course_versions;
create trigger course_versions_guard_learner_history
  before delete on public.course_versions
  for each row execute function public.guard_learner_history_course_versions();

drop trigger if exists courses_guard_learner_history on public.courses;
create trigger courses_guard_learner_history
  before delete on public.courses
  for each row execute function public.guard_learner_history_courses();

-- ---------------------------------------------------------------------------
-- 5. ADR 0004: blocked verdict + super_owner override
-- ---------------------------------------------------------------------------
alter table public.package_validations
  drop constraint if exists package_validations_verdict_check;
alter table public.package_validations
  add constraint package_validations_verdict_check
  check (verdict in ('pass', 'warning', 'fail', 'unplayable', 'blocked'));

alter table public.package_validations
  add column if not exists override_reason text,
  add column if not exists overridden_by uuid references auth.users(id) on delete set null,
  add column if not exists overridden_at timestamptz;

comment on column public.package_validations.override_reason is
  'Reason a super_owner gave for overriding a cross-course collision block (ADR 0004 step 3a; at most 500 characters).';
comment on column public.package_validations.overridden_by is
  'The super_owner who overrode the block (ADR 0004 step 3a).';
comment on column public.package_validations.overridden_at is
  'When the block was overridden; a blocked row is accepted by the upload gates only when this is set (ADR 0004 step 3a).';

notify pgrst, 'reload schema';

commit;
