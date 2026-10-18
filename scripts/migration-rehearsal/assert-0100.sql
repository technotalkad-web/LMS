-- scripts/migration-rehearsal/assert-0100.sql
-- Scenario "p4-0100": what 0100_alds_core.sql must have done, on the `prod`
-- scenario's synthetic rows (seed.sql ids), after it was pasted twice.
-- The whole file is one transaction that ends in ROLLBACK, so nothing it
-- writes reaches the audit that follows (its row counts stay pinned).
-- Every check raises 'assert-0100: …' on failure; the runner then reports
-- the file as failed and stops the scenario.
--
-- PGlite runs as postgres with no JWT claim, so the delete guards apply here
-- as they do in the SQL editor. The shim grants nothing by default; where a
-- check runs as service_role, anon or authenticated, the table privileges
-- Supabase gives every pre-2026-10-30 relation are granted inside this
-- transaction (and rolled back with it). Whether 0100's revoke beats
-- Supabase's own default privileges on the two new tables is proved by the
-- staging SQL-editor apply, not here (README, "What it cannot prove").
begin;

-- ---------------------------------------------------------------------------
-- (0) every 0100 object exists, once, with its defaults on the existing rows
-- ---------------------------------------------------------------------------
do $$
declare
  missing text[] := '{}';
  r record;
  n bigint;
begin
  for r in
    select * from (values
      ('course_versions', 'alds_manifest'), ('course_versions', 'standard_version'),
      ('course_versions', 'engine_version'), ('course_versions', 'conformance_level'),
      ('course_versions', 'analytics_tier'), ('course_versions', 'analytics_tier_reason'),
      ('course_versions', 'certified_at'), ('course_versions', 'certification_id'),
      ('course_attempts', 'served_language'), ('course_attempts', 'launch_mode'),
      ('course_attempts', 'is_preview'), ('course_attempts', 'alds_ingested_at'),
      ('xapi_statements', 'session_id'), ('xapi_statements', 'standard_version'),
      ('organizations', 'question_analytics_v2'),
      ('package_certifications', 'id'), ('package_certifications', 'organization_id'),
      ('package_certifications', 'course_version_id'), ('package_certifications', 'status'),
      ('package_certifications', 'reason_code'), ('package_certifications', 'reason'),
      ('package_certifications', 'rules_version'), ('package_certifications', 'rules_bundle_hash'),
      ('package_certifications', 'engine_digest'), ('package_certifications', 'package_digest'),
      ('package_certifications', 'static_report'), ('package_certifications', 'coverage'),
      ('package_certifications', 'requested_at'), ('package_certifications', 'finished_at'),
      ('package_certifications', 'requested_by'), ('package_certifications', 'revoked_by'),
      ('package_certifications', 'revoke_reason'), ('package_certifications', 'finding_ids'),
      ('package_certifications', 'created_at'),
      ('learning_sessions', 'id'), ('learning_sessions', 'organization_id'),
      ('learning_sessions', 'attempt_id'), ('learning_sessions', 'launch_kind'),
      ('learning_sessions', 'fetch_token'), ('learning_sessions', 'activity_id'),
      ('learning_sessions', 'launch_mode'), ('learning_sessions', 'launched_at'),
      ('learning_sessions', 'initialized_at'), ('learning_sessions', 'terminated_at'),
      ('learning_sessions', 'last_statement_at'), ('learning_sessions', 'created_at')
    ) as t(tbl, col)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) then
      missing := missing || (r.tbl || '.' || r.col);
    end if;
  end loop;

  for r in
    select * from (values
      ('package_certifications_version_idx'), ('course_versions_analytics_tier_idx'),
      ('learning_sessions_attempt_idx')
    ) as t(idx)
  loop
    if to_regclass('public.' || r.idx) is null then
      missing := missing || ('index ' || r.idx);
    end if;
  end loop;

  for r in
    select * from (values
      ('course_versions', 'course_versions_conformance_level_check'),
      ('course_versions', 'course_versions_analytics_tier_check'),
      ('course_attempts', 'course_attempts_launch_mode_check')
    ) as t(tbl, con)
  loop
    select count(*) into n from pg_constraint
    where conname = r.con and conrelid = ('public.' || r.tbl)::regclass;
    if n <> 1 then
      missing := missing || (r.con || ' x' || n);
    end if;
  end loop;

  if cardinality(missing) > 0 then
    raise exception 'assert-0100: (0) missing or duplicated after 0100: %', array_to_string(missing, ', ');
  end if;

  -- the writer: one overload, security definer, pinned search_path
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname = 'alds_set_version_tier';
  if n <> 1 then
    raise exception 'assert-0100: (0) alds_set_version_tier has % overloads (expected 1)', n;
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = to_regprocedure('public.alds_set_version_tier(uuid,text,text,text,uuid,jsonb,text,text,smallint)')
      and prosecdef
      and proconfig @> array['search_path=pg_catalog, public']
  ) then
    raise exception 'assert-0100: (0) alds_set_version_tier(uuid,text,text,text,uuid,jsonb,text,text,smallint) is missing, not security definer or without its search_path';
  end if;
  -- the guard: security invoker, pinned search_path, one BEFORE INSERT OR UPDATE row trigger
  if not exists (
    select 1 from pg_proc
    where oid = to_regprocedure('public.alds_guard_version_tier()')
      and not prosecdef
      and proconfig @> array['search_path=pg_catalog, public']
  ) then
    raise exception 'assert-0100: (0) alds_guard_version_tier() is missing, security definer or without its search_path';
  end if;
  select count(*) into n from pg_trigger
  where tgrelid = 'public.course_versions'::regclass and tgname = 'course_versions_guard_tier'
    and not tgisinternal and tgenabled = 'O'
    and tgfoid = 'public.alds_guard_version_tier()'::regprocedure
    and tgtype = (1 | 2 | 4 | 16);   -- ROW | BEFORE | INSERT | UPDATE
  if n <> 1 then
    raise exception 'assert-0100: (0) trigger course_versions_guard_tier: % matching row(s) (expected 1, before insert or update, for each row)', n;
  end if;

  -- section 9: the 0098 triggers still bound, the bodies on is_preview
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.course_versions'::regclass and tgname = 'course_versions_guard_learner_history'
      and tgfoid = 'public.guard_learner_history_course_versions()'::regprocedure
  ) or not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.courses'::regclass and tgname = 'courses_guard_learner_history'
      and tgfoid = 'public.guard_learner_history_courses()'::regprocedure
  ) then
    raise exception 'assert-0100: (0) a 0098 delete-guard trigger is no longer bound to its function';
  end if;
  select count(*) into n from pg_proc
  where oid in ('public.guard_learner_history_course_versions()'::regprocedure,
                'public.guard_learner_history_courses()'::regprocedure)
    and prosecdef
    and prosrc like '%not a.is_preview%'
    and prosrc not like '%organization_members%'
    and prosrc like '%request.jwt.claim.role%'
    and prosrc like '%is_preview since 0100%';
  if n <> 2 then
    raise exception 'assert-0100: (0) % of 2 delete-guard functions carry the 0100 body (is_preview clause, claim exemption, hint)', n;
  end if;

  -- RLS and the deny-all policies
  select count(*) into n from pg_class
  where oid in ('public.package_certifications'::regclass, 'public.learning_sessions'::regclass)
    and relrowsecurity;
  if n <> 2 then
    raise exception 'assert-0100: (0) row-level security is enabled on % of the 2 new tables', n;
  end if;
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename in ('package_certifications', 'learning_sessions')
    and cmd = 'ALL' and qual = 'false' and with_check = 'false';
  if n <> 2 then
    raise exception 'assert-0100: (0) % deny-all policies on the new tables (expected 2)', n;
  end if;

  -- foreign keys: none from xapi_statements to learning_sessions (the
  -- session_id FK and its index come with 0101, ADR 0005 note (b) addition
  -- of 2026-10-19: no xapi_statements scan under 0100's locks, and no
  -- unindexed set-null action on every learning_sessions delete); none on
  -- certification_id
  select count(*) into n from pg_constraint
  where contype = 'f' and conrelid = 'public.xapi_statements'::regclass
    and confrelid = 'public.learning_sessions'::regclass;
  if n <> 0 then
    raise exception 'assert-0100: (0) xapi_statements has % FK(s) to learning_sessions (expected 0: the FK comes with 0101)', n;
  end if;
  if to_regclass('public.xapi_statements_session_idx') is not null then
    raise exception 'assert-0100: (0) xapi_statements_session_idx exists after 0100 (expected with 0101, built concurrently)';
  end if;
  if exists (
    select 1 from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and c.conrelid = 'public.course_versions'::regclass
      and a.attname = 'certification_id'
  ) then
    raise exception 'assert-0100: (0) course_versions.certification_id has a foreign key (it must not, ADR 0005 note (b))';
  end if;

  -- defaults on the existing rows; the new tables are empty
  if exists (
    select 1 from public.course_versions
    where analytics_tier <> 'unverified' or analytics_tier_reason is not null
       or certified_at is not null or certification_id is not null
       or conformance_level <> 1 or alds_manifest is not null
  ) then
    raise exception 'assert-0100: (0) an existing course_versions row is not unverified / level 1 after 0100';
  end if;
  if exists (select 1 from public.course_attempts where launch_mode <> 'Normal' or alds_ingested_at is not null) then
    raise exception 'assert-0100: (0) an existing attempt has launch_mode <> Normal or alds_ingested_at set';
  end if;
  if exists (select 1 from public.organizations where question_analytics_v2) then
    raise exception 'assert-0100: (0) an organisation has question_analytics_v2 = true';
  end if;
  if (select count(*) from public.package_certifications) <> 0
     or (select count(*) from public.learning_sessions) <> 0 then
    raise exception 'assert-0100: (0) package_certifications or learning_sessions is not empty after 0100';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (1) the §6d backfill, and nothing else on the attempts
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  bad text[] := '{}';
begin
  for r in
    select x.id, x.want_preview, x.want_lang, x.want_status, x.want_completion, x.want_success,
           a.is_preview, a.served_language, a.status, a.completion_status, a.success_status, a.score
    from (values
      -- f1 learner a1 on e2 (package d2 'hi'); f2 admin a2 on e2
      ('00000000-0000-0000-0000-0000000000f1'::uuid, false, 'hi', 'in_progress', 'in_progress', 'unknown'),
      ('00000000-0000-0000-0000-0000000000f2'::uuid, true,  'hi', 'in_progress', 'in_progress', 'unknown'),
      -- f3 learner a1 and f4 admin a2 on e3 (package d3, language null)
      ('00000000-0000-0000-0000-0000000000f3'::uuid, false, null, 'completed',   'completed',   'unknown'),
      ('00000000-0000-0000-0000-0000000000f4'::uuid, true,  null, 'passed',      'completed',   'passed'),
      -- f5 and f6: the qa learner a3 (role user in the qa org)
      ('00000000-0000-0000-0000-0000000000f5'::uuid, false, null, 'in_progress', 'in_progress', 'unknown'),
      ('00000000-0000-0000-0000-0000000000f6'::uuid, false, null, 'abandoned',   'completed',   'unknown')
    ) as x(id, want_preview, want_lang, want_status, want_completion, want_success)
    left join public.course_attempts a on a.id = x.id
  loop
    if r.is_preview is distinct from r.want_preview
       or r.served_language is distinct from r.want_lang
       or r.status is distinct from r.want_status
       or r.completion_status is distinct from r.want_completion
       or r.success_status is distinct from r.want_success
       or r.score is not null then
      bad := bad || format('%s: is_preview %s served_language %s status %s/%s/%s score %s',
        right(r.id::text, 2), r.is_preview, coalesce(r.served_language, 'null'),
        r.status, r.completion_status, r.success_status, coalesce(r.score::text, 'null'));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0100: (1) backfill: %', array_to_string(bad, '; ');
  end if;
  if (select count(*) from public.course_attempts) <> 6 then
    raise exception 'assert-0100: (1) % attempts (expected the seed''s 6)', (select count(*) from public.course_attempts);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) guard on insert: a new version is always unverified, level 1, with no
--     manifest (an insert cannot plant a Level 2 manifest either)
-- ---------------------------------------------------------------------------
insert into public.course_versions
  (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data, upload_status,
   analytics_tier, analytics_tier_reason, certified_at, certification_id,
   alds_manifest, standard_version, engine_version, conformance_level)
values
  ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
   9, 'cmi5', 'index.html', 'courses/c1/d1/v9/', '{}', 'ready',
   'certified', 'x', now(), gen_random_uuid(),
   '{"standardVersion":"2.0","courseUlid":"01JAH7Q4ZB8K3T6W2M9XRV5C1N"}'::jsonb, '2.0', 'forged', 2::smallint);

do $$
declare
  v public.course_versions%rowtype;
begin
  select * into v from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';
  if v.analytics_tier is distinct from 'unverified' or v.analytics_tier_reason is not null
     or v.certified_at is not null or v.certification_id is not null then
    raise exception 'assert-0100: (2) an insert naming the tier columns kept them: % / % / % / %',
      v.analytics_tier, v.analytics_tier_reason, v.certified_at, v.certification_id;
  end if;
  if v.alds_manifest is not null or v.standard_version is not null or v.engine_version is not null
     or v.conformance_level is distinct from 1::smallint then
    raise exception 'assert-0100: (2) an insert naming the manifest columns kept them: % / % / % / %',
      v.alds_manifest, v.standard_version, v.engine_version, v.conformance_level;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (3) guard on update: a plain update of the tier columns is reverted
-- ---------------------------------------------------------------------------
update public.course_versions
set analytics_tier = 'certified', analytics_tier_reason = 'x', certified_at = now(), certification_id = gen_random_uuid(),
    alds_manifest = '{"courseUlid":"01JAH7Q4ZB8K3T6W2M9XRV5C1N"}'::jsonb, standard_version = '2.0',
    engine_version = 'forged', conformance_level = 2
where id = '00000000-0000-0000-0000-0000000000e9';

do $$
declare
  v public.course_versions%rowtype;
begin
  select * into v from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';
  if v.analytics_tier is distinct from 'unverified' or v.analytics_tier_reason is not null
     or v.certified_at is not null or v.certification_id is not null then
    raise exception 'assert-0100: (3) a plain update moved the tier columns: % / % / % / %',
      v.analytics_tier, v.analytics_tier_reason, v.certified_at, v.certification_id;
  end if;
  if v.alds_manifest is not null or v.standard_version is not null or v.engine_version is not null
     or v.conformance_level is distinct from 1::smallint then
    raise exception 'assert-0100: (3) a plain update moved the manifest columns: % / % / % / %',
      v.alds_manifest, v.standard_version, v.engine_version, v.conformance_level;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (4) the writer certifies, with the run id and the manifest columns
-- ---------------------------------------------------------------------------
do $$
declare
  run_id uuid;
  j jsonb;
  v public.course_versions%rowtype;
begin
  insert into public.package_certifications (id, organization_id, course_version_id, status)
  values ('00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000e9', 'certified')
  returning id into run_id;
  if run_id is distinct from '00000000-0000-0000-0000-000000000c01'::uuid then
    raise exception 'assert-0100: (4) the certification insert returned %', run_id;
  end if;

  select public.alds_set_version_tier(
    '00000000-0000-0000-0000-0000000000e9', 'certified', null, null, run_id,
    '{"standardVersion":"2.0","courseUlid":"01JAH7Q4ZB8K3T6W2M9XRV5C1N"}'::jsonb, '2.0', '2026.10.19.1', 2::smallint
  ) into j;
  select * into v from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';

  if v.analytics_tier is distinct from 'certified' or v.certified_at is null
     or v.certification_id is distinct from run_id or v.conformance_level is distinct from 2::smallint
     or v.standard_version is distinct from '2.0' or v.engine_version is distinct from '2026.10.19.1'
     or v.alds_manifest ->> 'courseUlid' is distinct from '01JAH7Q4ZB8K3T6W2M9XRV5C1N'
     or v.analytics_tier_reason is not null then
    raise exception 'assert-0100: (4) after the writer: tier % certified_at % run % level % standard % engine % manifest % reason %',
      v.analytics_tier, v.certified_at, v.certification_id, v.conformance_level, v.standard_version,
      v.engine_version, v.alds_manifest, v.analytics_tier_reason;
  end if;
  if j ->> 'version_id' is distinct from v.id::text
     or j ->> 'analytics_tier' is distinct from 'certified'
     or j ->> 'certified_at' is null
     or (j ->> 'certified_at')::timestamptz is distinct from v.certified_at
     or (j ->> 'certification_id')::uuid is distinct from run_id
     or not (j ? 'analytics_tier_reason') then
    raise exception 'assert-0100: (4) the writer returned %', j;
  end if;
  if coalesce(current_setting('alds.tier_writer', true), '') = 'on' then
    raise exception 'assert-0100: (4) alds.tier_writer is still on after the writer returned';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (5) an unrelated update keeps the tier (same transaction as the writer, so
--     this also proves the writer switched its setting off again)
-- ---------------------------------------------------------------------------
update public.course_versions set file_count = 3 where id = '00000000-0000-0000-0000-0000000000e9';

do $$
declare
  v public.course_versions%rowtype;
begin
  select * into v from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';
  if v.file_count is distinct from 3 or v.analytics_tier is distinct from 'certified'
     or v.certified_at is null or v.certification_id is distinct from '00000000-0000-0000-0000-000000000c01'::uuid then
    raise exception 'assert-0100: (5) an unrelated update changed the tier: file_count % tier % certified_at % run %',
      v.file_count, v.analytics_tier, v.certified_at, v.certification_id;
  end if;
end
$$;

-- (5b) the same through the service role (the service client): a plain
--      update of storage_driver / upload_status keeps the tier, an update
--      naming the tier columns is reverted, and the writer is callable.
--      Supabase's default table privileges on course_versions are granted
--      for this transaction only.
grant usage on schema public to service_role;
grant select, update on public.course_versions to service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v public.course_versions%rowtype;
  certified timestamptz;
begin
  if current_user <> 'service_role' then
    raise exception 'assert-0100: (5b) running as % (expected service_role)', current_user;
  end if;
  select certified_at into certified from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';

  update public.course_versions set storage_driver = 'r2', upload_status = 'ready'
  where id = '00000000-0000-0000-0000-0000000000e9';
  update public.course_versions
  set analytics_tier = 'unverified', analytics_tier_reason = 'forged', certified_at = null, certification_id = null,
      alds_manifest = null, standard_version = null, engine_version = 'forged', conformance_level = 1
  where id = '00000000-0000-0000-0000-0000000000e9';

  select * into v from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';
  if v.storage_driver is distinct from 'r2' or v.analytics_tier is distinct from 'certified'
     or v.analytics_tier_reason is not null or v.certified_at is distinct from certified
     or v.certification_id is distinct from '00000000-0000-0000-0000-000000000c01'::uuid then
    raise exception 'assert-0100: (5b) a service-role plain update moved the tier: driver % tier % reason % certified_at % run %',
      v.storage_driver, v.analytics_tier, v.analytics_tier_reason, v.certified_at, v.certification_id;
  end if;
  if v.conformance_level is distinct from 2::smallint or v.standard_version is distinct from '2.0'
     or v.engine_version is distinct from '2026.10.19.1'
     or v.alds_manifest ->> 'courseUlid' is distinct from '01JAH7Q4ZB8K3T6W2M9XRV5C1N' then
    raise exception 'assert-0100: (5b) a service-role plain update moved the manifest columns: level % standard % engine % manifest %',
      v.conformance_level, v.standard_version, v.engine_version, v.alds_manifest;
  end if;

  -- (6) revoked keeps certified_at and the manifest columns (called as service_role)
  perform public.alds_set_version_tier(
    '00000000-0000-0000-0000-0000000000e9', 'revoked', 'observed', 'r',
    '00000000-0000-0000-0000-000000000c01');
  select * into v from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';
  if v.analytics_tier is distinct from 'revoked' or v.analytics_tier_reason is distinct from 'r'
     or v.certified_at is distinct from certified or v.certified_at is null
     or v.certification_id is distinct from '00000000-0000-0000-0000-000000000c01'::uuid
     or v.conformance_level is distinct from 2::smallint or v.standard_version is distinct from '2.0'
     or v.engine_version is distinct from '2026.10.19.1'
     or v.alds_manifest ->> 'courseUlid' is distinct from '01JAH7Q4ZB8K3T6W2M9XRV5C1N' then
    raise exception 'assert-0100: (6) after revoke: tier % reason % certified_at % (was %) run % level % standard % engine %',
      v.analytics_tier, v.analytics_tier_reason, v.certified_at, certified, v.certification_id,
      v.conformance_level, v.standard_version, v.engine_version;
  end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', true);

-- (6b) any tier other than certified / revoked clears certified_at
do $$
declare
  v public.course_versions%rowtype;
begin
  perform public.alds_set_version_tier(
    '00000000-0000-0000-0000-0000000000e9', 'uncertified', 'check_error', 'check_error: deadline',
    '00000000-0000-0000-0000-000000000c01');
  select * into v from public.course_versions where id = '00000000-0000-0000-0000-0000000000e9';
  if v.analytics_tier is distinct from 'uncertified' or v.analytics_tier_reason is distinct from 'check_error: deadline'
     or v.certified_at is not null then
    raise exception 'assert-0100: (6b) after uncertified: tier % reason % certified_at %',
      v.analytics_tier, v.analytics_tier_reason, v.certified_at;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (7) refusals: invalid tier 22023, a run of another version 23503, unknown
--     version P0002; none of them moves the tier or leaves the setting on
-- ---------------------------------------------------------------------------
do $$
declare
  got text;
  before_row text;
  after_row text;
begin
  select to_jsonb(v)::text into before_row from public.course_versions v where id = '00000000-0000-0000-0000-0000000000e9';
  insert into public.package_certifications (id, organization_id, course_version_id, status)
  values ('00000000-0000-0000-0000-000000000c02', '00000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000e1', 'pending');

  got := 'no error';
  begin
    perform public.alds_set_version_tier('00000000-0000-0000-0000-0000000000e9', 'gold');
  exception when others then
    got := sqlstate;
  end;
  if got <> '22023' then
    raise exception 'assert-0100: (7) invalid tier: % (expected 22023)', got;
  end if;

  got := 'no error';
  begin
    perform public.alds_set_version_tier('00000000-0000-0000-0000-0000000000e9', null);
  exception when others then
    got := sqlstate;
  end;
  if got <> '22023' then
    raise exception 'assert-0100: (7) null tier: % (expected 22023)', got;
  end if;

  got := 'no error';
  begin
    perform public.alds_set_version_tier(
      '00000000-0000-0000-0000-0000000000e9', 'certified', null, null, '00000000-0000-0000-0000-000000000c02');
  exception when others then
    got := sqlstate;
  end;
  if got <> '23503' then
    raise exception 'assert-0100: (7) a run of another version: % (expected 23503)', got;
  end if;

  got := 'no error';
  begin
    perform public.alds_set_version_tier('00000000-0000-0000-0000-0000000000ff', 'pending');
  exception when others then
    got := sqlstate;
  end;
  if got <> 'P0002' then
    raise exception 'assert-0100: (7) unknown version: % (expected P0002)', got;
  end if;

  select to_jsonb(v)::text into after_row from public.course_versions v where id = '00000000-0000-0000-0000-0000000000e9';
  if after_row is distinct from before_row then
    raise exception 'assert-0100: (7) a refused call changed version e9';
  end if;
  if coalesce(current_setting('alds.tier_writer', true), '') = 'on' then
    raise exception 'assert-0100: (7) alds.tier_writer is on after the refusals';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (8) delete guards on is_preview (no JWT claim: the guard applies)
-- ---------------------------------------------------------------------------
insert into public.course_versions
  (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data, upload_status)
values
  ('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
   10, 'cmi5', 'index.html', 'courses/c1/d1/v10/', '{}', 'ready'),
  ('00000000-0000-0000-0000-0000000000eb', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
   11, 'cmi5', 'index.html', 'courses/c1/d1/v11/', '{}', 'ready'),
  -- ed and ee tell the 0100 rule from 0098's membership rule: the column
  -- decides, not the user's current role
  ('00000000-0000-0000-0000-0000000000ed', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
   12, 'cmi5', 'index.html', 'courses/c1/d1/v12/', '{}', 'ready'),
  ('00000000-0000-0000-0000-0000000000ee', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
   13, 'cmi5', 'index.html', 'courses/c1/d1/v13/', '{}', 'ready');
insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, is_preview) values
  -- the admin's preview attempt on ea; the learner's attempt on eb
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000ea',
   '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'in_progress', true),
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000eb',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'in_progress', false),
  -- a current admin's attempt that is NOT preview (made while a learner) on
  -- ed: blocks under 0100, did not under 0098
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000ed',
   '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'in_progress', false),
  -- a preview attempt by a user who is no longer staff (role user today) on
  -- ee: does not block under 0100, did under 0098
  ('00000000-0000-0000-0000-0000000000fb', '00000000-0000-0000-0000-0000000000ee',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'in_progress', true);

do $$
declare
  got text;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') <> ''
     or coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') <> '' then
    raise exception 'assert-0100: (8) a JWT claim is set; the guard would be bypassed';
  end if;

  -- e2 holds f1 (learner, is_preview false)
  got := 'no error';
  begin
    delete from public.course_versions where id = '00000000-0000-0000-0000-0000000000e2';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  if got not like 'P0001 learner_history_exists%' then
    raise exception 'assert-0100: (8) deleting e2 (a learner attempt): % (expected learner_history_exists)', got;
  end if;

  -- ea holds only the admin's preview attempt: deletes
  got := 'no error';
  begin
    delete from public.course_versions where id = '00000000-0000-0000-0000-0000000000ea';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  if got <> 'no error'
     or exists (select 1 from public.course_versions where id = '00000000-0000-0000-0000-0000000000ea')
     or exists (select 1 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f7') then
    raise exception 'assert-0100: (8) deleting ea (preview attempts only): % (expected the version and its attempt gone)', got;
  end if;

  -- eb holds the learner's attempt: refused
  got := 'no error';
  begin
    delete from public.course_versions where id = '00000000-0000-0000-0000-0000000000eb';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  if got not like 'P0001 learner_history_exists%' then
    raise exception 'assert-0100: (8) deleting eb (a learner attempt): % (expected learner_history_exists)', got;
  end if;

  -- ed: a current admin's non-preview attempt blocks
  got := 'no error';
  begin
    delete from public.course_versions where id = '00000000-0000-0000-0000-0000000000ed';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  if got not like 'P0001 learner_history_exists%' then
    raise exception 'assert-0100: (8) deleting ed (an admin''s non-preview attempt): % (expected learner_history_exists)', got;
  end if;

  -- ee: a preview attempt by today's learner does not block
  got := 'no error';
  begin
    delete from public.course_versions where id = '00000000-0000-0000-0000-0000000000ee';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  if got <> 'no error' or exists (select 1 from public.course_versions where id = '00000000-0000-0000-0000-0000000000ee') then
    raise exception 'assert-0100: (8) deleting ee (preview attempt by a non-staff user): % (expected deleted)', got;
  end if;

  -- the courses guard: c1 holds f1 (learner)
  got := 'no error';
  begin
    delete from public.courses where id = '00000000-0000-0000-0000-0000000000c1';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  if got not like 'P0001 learner_history_exists%' then
    raise exception 'assert-0100: (8) deleting course c1 (a learner attempt): % (expected learner_history_exists)', got;
  end if;

  -- the service_role claim exemption is kept: eb deletes with the claim
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  got := 'no error';
  begin
    delete from public.course_versions where id = '00000000-0000-0000-0000-0000000000eb';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  if got <> 'no error' or exists (select 1 from public.course_versions where id = '00000000-0000-0000-0000-0000000000eb') then
    raise exception 'assert-0100: (8) deleting eb with the service_role claim: % (expected deleted)', got;
  end if;
end
$$;

-- the courses guard with preview attempts only: a course whose attempts are
-- all preview (the admin's, and one by today's learner) deletes; its
-- version's guard runs in the cascade
insert into public.courses (id, organization_id, title, slug) values
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-00000000000a', 'Assert 0100', 'assert-0100');
insert into public.course_packages (id, course_id, language, is_active) values
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000c9', null, true);
insert into public.course_versions
  (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data, upload_status)
values
  ('00000000-0000-0000-0000-0000000000ec', '00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000d9',
   1, 'cmi5', 'index.html', 'courses/c9/d9/v1/', '{}', 'ready');
insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, is_preview) values
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000ec',
   '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'in_progress', true),
  -- a preview attempt by today's learner: blocked the course under 0098 only
  ('00000000-0000-0000-0000-0000000000fc', '00000000-0000-0000-0000-0000000000ec',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'in_progress', true);

do $$
declare
  got text := 'no error';
begin
  begin
    delete from public.courses where id = '00000000-0000-0000-0000-0000000000c9';
  exception when others then
    got := sqlstate || ' ' || sqlerrm;
  end;
  if got <> 'no error'
     or exists (select 1 from public.courses where id = '00000000-0000-0000-0000-0000000000c9')
     or exists (select 1 from public.course_attempts
                where id in ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000fc')) then
    raise exception 'assert-0100: (8) deleting course c9 (preview attempts only): % (expected the course and its attempt gone)', got;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (9) RLS and grants: service_role only; anon and authenticated can neither
--     read the two tables nor execute the writer
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r record;
begin
  if (select count(*) from pg_policies where schemaname = 'public'
        and tablename in ('package_certifications', 'learning_sessions')) <> 2 then
    bad := bad || 'policy count <> 2'::text;
  end if;
  for r in
    select * from (values
      ('service_role',  'public.package_certifications', 'select', true),
      ('service_role',  'public.package_certifications', 'insert', true),
      ('service_role',  'public.package_certifications', 'update', true),
      ('service_role',  'public.package_certifications', 'delete', false),
      ('service_role',  'public.learning_sessions',      'select', true),
      ('service_role',  'public.learning_sessions',      'insert', true),
      ('service_role',  'public.learning_sessions',      'update', true),
      ('service_role',  'public.learning_sessions',      'delete', false),
      ('authenticated', 'public.package_certifications', 'select', false),
      ('authenticated', 'public.package_certifications', 'insert', false),
      ('authenticated', 'public.learning_sessions',      'select', false),
      ('authenticated', 'public.learning_sessions',      'insert', false),
      ('anon',          'public.package_certifications', 'select', false),
      ('anon',          'public.learning_sessions',      'select', false)
    ) as t(rol, tbl, priv, want)
  loop
    if has_table_privilege(r.rol, r.tbl, r.priv) is distinct from r.want then
      bad := bad || format('%s %s on %s is %s', r.rol, r.priv, r.tbl, not r.want);
    end if;
  end loop;
  for r in
    select * from (values
      ('service_role',  'public.alds_set_version_tier(uuid,text,text,text,uuid,jsonb,text,text,smallint)', true),
      ('authenticated', 'public.alds_set_version_tier(uuid,text,text,text,uuid,jsonb,text,text,smallint)', false),
      ('anon',          'public.alds_set_version_tier(uuid,text,text,text,uuid,jsonb,text,text,smallint)', false),
      ('service_role',  'public.alds_guard_version_tier()', true),
      ('authenticated', 'public.alds_guard_version_tier()', false),
      ('anon',          'public.alds_guard_version_tier()', false),
      ('authenticated', 'public.guard_learner_history_course_versions()', false),
      ('authenticated', 'public.guard_learner_history_courses()', false)
    ) as t(rol, fn, want)
  loop
    if has_function_privilege(r.rol, r.fn, 'execute') is distinct from r.want then
      bad := bad || format('%s execute on %s is %s', r.rol, r.fn, not r.want);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0100: (9) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (9b) the same, tried for real as authenticated and as anon (schema usage
--      granted for this transaction, as Supabase grants it, so a refusal
--      can only come from the table or function privilege)
grant usage on schema public to anon, authenticated;
set local role authenticated;
do $$
declare
  got text;
  t text;
begin
  foreach t in array array['package_certifications', 'learning_sessions'] loop
    got := 'no error';
    begin
      execute format('select count(*) from public.%I', t);
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0100: (9b) authenticated reading %: % (expected 42501)', t, got;
    end if;
  end loop;
  got := 'no error';
  begin
    perform public.alds_set_version_tier('00000000-0000-0000-0000-0000000000e9', 'certified');
  exception when others then
    got := sqlstate;
  end;
  if got <> '42501' then
    raise exception 'assert-0100: (9b) authenticated executing alds_set_version_tier: % (expected 42501)', got;
  end if;
end
$$;
reset role;
set local role anon;
do $$
declare
  got text;
  t text;
begin
  foreach t in array array['package_certifications', 'learning_sessions'] loop
    got := 'no error';
    begin
      execute format('select count(*) from public.%I', t);
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0100: (9b) anon reading %: % (expected 42501)', t, got;
    end if;
  end loop;
  got := 'no error';
  begin
    perform public.alds_set_version_tier('00000000-0000-0000-0000-0000000000e9', 'certified');
  exception when others then
    got := sqlstate;
  end;
  if got <> '42501' then
    raise exception 'assert-0100: (9b) anon executing alds_set_version_tier: % (expected 42501)', got;
  end if;
end
$$;
reset role;

rollback;
