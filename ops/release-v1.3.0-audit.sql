-- ops/release-v1.3.0-audit.sql — read-only audit for the v1.3.0 production
-- release (ADR 0007 step 2 with the checks added at acceptance; ADR 0003
-- steps 7a and 8; ADR 0004 steps 12a and 16; ADR 0008 steps 16 and 20;
-- ADR 0009 steps 10-11; ADR 0010 step 7). The same file is the pre-apply
-- audit and the post-apply probe (ADR 0007 steps 2 and 5).
--
-- WHO RUNS IT: the owner, in the Supabase dashboard SQL editor of the
-- project being audited (staging first, then production). Never through the
-- Supabase CLI, never from a GitHub workflow. The output names course,
-- version, attempt and organisation ids: keep it in the private editor or a
-- private CSV export; never paste it into GitHub, an issue, a PR or a chat
-- that is not private. ops/INCIDENT_LEDGER.md takes ids only (first 8 hex).
--
-- HOW: SQL editor -> New query -> the editor's role selector on postgres
-- (its default; any other role filters the D rows through row-level
-- security, and A04 then reads MISMATCH) -> paste this whole file, select
-- nothing -> Run. The result is ONE grid. Its last row is "ZZ END OF AUDIT":
-- if that row is missing, the editor cut the result (raise the row limit, or
-- export CSV) before reading anything. The editor may ask to confirm a
-- destructive operation: the only drop here is the temporary table's below.
--
-- WHAT IT CHANGES: nothing in the application. The file creates a temporary
-- table (pg_temp.release_audit, private to this editor session and dropped
-- with it), fills it from SELECTs over pg_catalog / information_schema and
-- the application tables, and returns it. Its only INSERTs write that
-- temporary table; it has no UPDATE, DELETE, ALTER, GRANT or function call
-- with side effects. Every presence probe is a catalog SELECT naming the
-- object (never a supabase-js head/count probe, which reports a missing
-- table as present: docs/ARCHITECTURE.md §9). Every data check runs in its
-- own guarded block, so an object missing at migration 0071 yields a row
-- that says so (or an ERROR row), never an aborted run.
--
-- READING THE GRID. Columns:
--   check_id        sort key; A = environment, B = one presence probe per
--                   migration (0070-0071 baseline, 0072-0098 in the sitting,
--                   0099 after v1.3.0, 0100 planned), C = the 0032 constraint
--                   state, D = data checks, Z = summary.
--   label           what the row checks, self-describing.
--   observed        what this database holds now.
--   exp_before      expected on production BEFORE the sitting (believed at
--                   0071; 0072 may already be applied).
--   exp_after       expected right AFTER the sitting (0032 guarded, then
--                   0072-0098), i.e. the post-apply probe.
--   exp_0099        expected after the later 0099 apply (production only
--                   after v1.3.0 is live; staging is here already, so the
--                   staging run is read against this column).
--   at_before / at_after / at_0099
--                   ok, MISMATCH, or blank where the expectation is any /
--                   info / review (read the row yourself).
--   note            how to read the row and the stop rule, if any.
-- Expectation words: present, absent, 0, a literal token, any (either is
-- fine), info (context only), review (the owner reads the list; it is not a
-- pass/fail check).
--
-- WHICH COLUMN TO READ:
--   staging now (at 0099 + 0032)            -> at_0099
--   production before the sitting           -> at_before
--   production after 0032 + 0072-0098       -> at_after
--   production after the later 0099 apply   -> at_0099
--
-- STOP CONDITIONS before the sitting (docs/release/v1.3.0.md has the full
-- runbook): any ERROR row; A04 not postgres; any 0070/0071 baseline probe absent; a migration
-- present above the first absent one (Z02 not "none"); C04 (duplicate
-- package/version pairs) not 0; D02 (shared storage prefixes) not 0 until
-- the duplicates are repointed (ADR 0007 step 3); a planned 0099 or 0100
-- object present. Rows marked review are read by the owner before the tag
-- (acceptance condition a: D03's attempt list in particular).

drop table if exists pg_temp.release_audit;
create temporary table release_audit (
  check_id   text primary key,
  section    text not null,
  label      text not null,
  observed   text,
  exp_before text,
  exp_after  text,
  exp_0099   text,
  note       text
);

-- ---------------------------------------------------------------------------
-- A. Environment
-- ---------------------------------------------------------------------------
insert into pg_temp.release_audit
select 'A01', 'environment', 'run at (UTC)',
       to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
       'info', 'info', 'info', 'Record this with the result.';
insert into pg_temp.release_audit
select 'A02', 'environment', 'server version',
       current_setting('server_version'), 'info', 'info', 'info', null;
insert into pg_temp.release_audit
select 'A03', 'environment', 'organisations whose slug starts qa- (test data; production has none)',
       case when to_regclass('public.organizations') is null then 'absent'
            else (select count(*)::text from public.organizations where slug like 'qa-%') end,
       '0', '0', 'info',
       'Non-zero on production would mean test data there: stop and ask (after the later 0099 apply too: the at_0099 column does not compare this row, because staging has qa data). Staging has qa-* data from the CI suites; the D rows below leave qa-* organisations out and say how many qa rows they skipped.';
insert into pg_temp.release_audit
select 'A04', 'environment', 'role the audit ran as (current_user)',
       current_user::text, 'postgres', 'postgres', 'postgres',
       'Anything else: the D rows are filtered by row-level security and read falsely clean (0 rows, no error). Switch the SQL editor''s role selector to postgres and run again; read nothing from this grid.';

-- ---------------------------------------------------------------------------
-- B. One presence probe per migration (catalog selects naming the object)
-- ---------------------------------------------------------------------------
-- kind: table (any relation: table, view, matview, index), column, function
-- (regprocedure signature), policy, trigger, checkdef (a named constraint
-- whose definition contains a value only that migration adds), funcdef (a
-- function whose definition contains a token only that migration's version
-- has), viewdef (the same for a view or materialized view).
-- A file that creates many objects gets a second probe (suffix b) on the last
-- object it creates whose final state is set by that file, so a paste that
-- stopped early but reported success reads absent. No second probe: 0081 and
-- 0082 (their later objects are recreated by 0082/0088/0089/0090, which the
-- b probes of 0088 and 0090 cover), 0089 (B0089 is already its last object).
insert into pg_temp.release_audit
select p.check_id, 'migration probe', p.label,
       case when case p.kind
         when 'table' then to_regclass('public.' || p.rel) is not null
         when 'column' then exists (
           select 1 from pg_catalog.pg_attribute a
           where a.attrelid = to_regclass('public.' || p.rel)
             and a.attname = p.obj and a.attnum > 0 and not a.attisdropped)
         when 'function' then to_regprocedure('public.' || p.obj) is not null
         when 'policy' then exists (
           select 1 from pg_catalog.pg_policies pp
           where pp.schemaname = 'public' and pp.tablename = p.rel and pp.policyname = p.obj)
         when 'trigger' then exists (
           select 1 from pg_catalog.pg_trigger t
           where t.tgrelid = to_regclass('public.' || p.rel) and t.tgname = p.obj and not t.tgisinternal)
         when 'checkdef' then exists (
           select 1 from pg_catalog.pg_constraint c
           where c.conrelid = to_regclass('public.' || p.rel) and c.conname = p.obj
             and pg_catalog.pg_get_constraintdef(c.oid) like '%' || p.val || '%')
         when 'funcdef' then to_regprocedure('public.' || p.obj) is not null
           and pg_catalog.pg_get_functiondef(to_regprocedure('public.' || p.obj)::oid) like '%' || p.val || '%'
         when 'viewdef' then to_regclass('public.' || p.rel) is not null
           and pg_catalog.pg_get_viewdef(to_regclass('public.' || p.rel)::oid) like '%' || p.val || '%'
       end then 'present' else 'absent' end,
       p.exp_before, p.exp_after, p.exp_0099, p.note
from (values
  -- baseline: production is believed at 0071 (v1.2.0, 2026-09-17)
  ('B0070',  'table',    'package_validations', null, null,
   '0070 table package_validations', 'present', 'present', 'present',
   'Baseline. Absent = production is below 0071: STOP, the runbook does not apply.'),
  ('B0071a', 'table',    'org_api_keys', null, null,
   '0071 table org_api_keys', 'present', 'present', 'present',
   'Baseline. Absent = production is below 0071: STOP.'),
  ('B0071b', 'table',    'org_integration_settings', null, null,
   '0071 table org_integration_settings', 'present', 'present', 'present',
   'Baseline. Absent = production is below 0071: STOP.'),
  -- the sitting: 0072-0098
  ('B0072',  'column',   'courses', 'show_attempts_history', null,
   '0072 column courses.show_attempts_history', 'any', 'present', 'present',
   'May already be on production (scripts/check-migration-grants.mjs names 0073 as the first pending). Present = start the sitting at 0073.'),
  ('B0073',  'table',    'attempt_scoring_rules', null, null,
   '0073 table attempt_scoring_rules', 'absent', 'present', 'present', null),
  ('B0073b', 'funcdef',  null, 'gamification_close_month()', 'attempt_no',
   '0073 end of file: gamification_close_month() has the 0073 body (attempt_no)', 'absent', 'present', 'present',
   'End of file: absent while the first probe is present = the paste stopped early. Paste the file again, then every later file of the sitting in order (runbook §4.5).'),
  ('B0074',  'table',    'dashboard_backgrounds', null, null,
   '0074 table dashboard_backgrounds', 'absent', 'present', 'present', null),
  ('B0075',  'column',   'course_attempts', 'progress_pct', null,
   '0075 column course_attempts.progress_pct', 'absent', 'present', 'present', null),
  ('B0076',  'checkdef', 'course_versions', 'course_versions_manifest_type_check', '''xapi''',
   '0076 course_versions_manifest_type_check admits ''xapi''', 'absent', 'present', 'present',
   'The constraint name exists since 0002; only 0076 adds ''xapi'' to its definition.'),
  ('B0077',  'column',   'course_versions', 'upload_status', null,
   '0077 column course_versions.upload_status', 'absent', 'present', 'present',
   '0098 refuses to run without it (its prerequisite block).'),
  ('B0078',  'column',   'tenant_lrs_config', 'statement_profile', null,
   '0078 column tenant_lrs_config.statement_profile', 'absent', 'present', 'present',
   'Right after 0078 the runbook sets statement_profile = raw on every enabled configuration whose consumer was not told about ambak-v1 (ADR 0007 step 6, decision 3; see D08).'),
  ('B0079',  'table',    'org_reference_counters', null, null,
   '0079 table org_reference_counters', 'absent', 'present', 'present', null),
  ('B0079b', 'table',    'journey_programs_reference_code_uq', null, null,
   '0079 end of file: unique index journey_programs_reference_code_uq', 'absent', 'present', 'present',
   'End of file: absent while the first probe is present = the paste stopped early. Paste the file again, then every later file of the sitting in order (runbook §4.5).'),
  ('B0080',  'policy',   'org_reference_counters', 'org admins read their reference counters', null,
   '0080 policy "org admins read their reference counters"', 'absent', 'present', 'present', null),
  ('B0081',  'column',   'courses', 'pass_required', null,
   '0081 column courses.pass_required', 'absent', 'present', 'present', null),
  ('B0082',  'column',   'course_attempts', 'completion_webhook_at', null,
   '0082 column course_attempts.completion_webhook_at', 'absent', 'present', 'present', null),
  ('B0083',  'table',    'attempt_requests', null, null,
   '0083 table attempt_requests', 'absent', 'present', 'present', null),
  ('B0084',  'checkdef', 'xp_events', 'xp_events_rule_check', '''course_passed''',
   '0084 xp_events_rule_check admits ''course_passed''', 'absent', 'present', 'present',
   'The constraint exists since 0053; only 0084 adds ''course_passed''.'),
  ('B0084b', 'funcdef',  null, 'gamification_record_activity_core(uuid)', 'course_passed',
   '0084 end of file: gamification_record_activity_core(uuid) has the 0084 body (course_passed)', 'absent', 'present', 'present',
   'End of file: absent while the first probe is present = the paste stopped early. Paste the file again, then every later file of the sitting in order (runbook §4.5).'),
  ('B0085',  'column',   'attempt_requests', 'attempts_used', null,
   '0085 column attempt_requests.attempts_used', 'absent', 'present', 'present', null),
  ('B0086',  'table',    'attention_settings', null, null,
   '0086 table attention_settings', 'absent', 'present', 'present', null),
  ('B0087',  'function', null, 'attention_overdue_count(uuid)', null,
   '0087 function attention_overdue_count(uuid)', 'absent', 'present', 'present', null),
  ('B0088',  'column',   'journey_programs', 'unlock_mode', null,
   '0088 column journey_programs.unlock_mode', 'absent', 'present', 'present', null),
  ('B0088b', 'table',    'journey_enrollments_daily_reminder_idx', null, null,
   '0088 end of file: index journey_enrollments_daily_reminder_idx (its later journey_record_completion is replaced by 0089)', 'absent', 'present', 'present',
   'End of file: absent while the first probe is present = the paste stopped early. Paste the file again, then every later file of the sitting in order (runbook §4.5).'),
  ('B0089',  'function', null, 'journey_reminder_counts(uuid[])', null,
   '0089 function journey_reminder_counts(uuid[])', 'absent', 'present', 'present', null),
  ('B0090',  'column',   'v_course_attempt_summary', 'official_attempt_id', null,
   '0090 column v_course_attempt_summary.official_attempt_id', 'absent', 'present', 'present',
   '0099 refuses to run without it (its prerequisite block).'),
  ('B0090b', 'viewdef',  'mv_path_enrollment_status', null, 'official_status',
   '0090 end of file: mv_path_enrollment_status has the 0090 definition (official_status)', 'absent', 'present', 'present',
   'End of file: absent while the first probe is present = the paste stopped early. Paste the file again, then every later file of the sitting in order (runbook §4.5).'),
  ('B0091',  'column',   'organization_members', 'l3_manager_id', null,
   '0091 column organization_members.l3_manager_id', 'absent', 'present', 'present', null),
  ('B0092',  'checkdef', 'attempt_requests', 'attempt_requests_status_check', '''expired''',
   '0092 attempt_requests_status_check admits ''expired''', 'absent', 'present', 'present',
   'The constraint exists since 0083; only 0092 adds ''expired''.'),
  ('B0093',  'table',    'report_card_cache', null, null,
   '0093 table report_card_cache', 'absent', 'present', 'present', null),
  ('B0094',  'policy',   'report_card_cache', 'no direct access to report card cache', null,
   '0094 policy "no direct access to report card cache"', 'absent', 'present', 'present', null),
  ('B0095',  'table',    'help_ticket_messages', null, null,
   '0095 table help_ticket_messages', 'absent', 'present', 'present', null),
  ('B0095b', 'checkdef', 'attempt_requests', 'attempt_requests_source_check', '''ticket''',
   '0095 end of file: attempt_requests_source_check admits ''ticket''', 'absent', 'present', 'present',
   'End of file: absent while the first probe is present = the paste stopped early. Paste the file again, then every later file of the sitting in order (runbook §4.5).'),
  ('B0096',  'table',    'content_scopes', null, null,
   '0096 table content_scopes', 'absent', 'present', 'present', null),
  ('B0096b', 'funcdef',  null, 'journey_auto_enroll()', 'new.department',
   '0096 end of file: journey_auto_enroll() has the 0096 body (new.department)', 'absent', 'present', 'present',
   'End of file: absent while the first probe is present = the paste stopped early. Paste the file again, then every later file of the sitting in order (runbook §4.5).'),
  ('B0097a', 'column',   'organizations', 'enforce_content_mapping', null,
   '0097 column organizations.enforce_content_mapping', 'absent', 'present', 'present', null),
  ('B0097b', 'table',    'manager_coverage', null, null,
   '0097 table manager_coverage', 'absent', 'present', 'present', null),
  ('B0098a', 'table',    'course_versions_storage_prefix_key', null, null,
   '0098 unique index course_versions_storage_prefix_key', 'absent', 'present', 'present',
   'Needs D02 = 0 before the sitting (0098 refuses otherwise).'),
  ('B0098b', 'trigger',  'course_versions', 'course_versions_freeze_ready', null,
   '0098 trigger course_versions_freeze_ready (write-once ready versions)', 'absent', 'present', 'present', null),
  ('B0098c', 'trigger',  'course_versions', 'course_versions_guard_learner_history', null,
   '0098 trigger course_versions_guard_learner_history (delete guard)', 'absent', 'present', 'present', null),
  ('B0098d', 'trigger',  'courses', 'courses_guard_learner_history', null,
   '0098 trigger courses_guard_learner_history (delete guard)', 'absent', 'present', 'present', null),
  ('B0098e', 'checkdef', 'package_validations', 'package_validations_verdict_check', '''blocked''',
   '0098 package_validations_verdict_check admits ''blocked''', 'absent', 'present', 'present',
   'The constraint exists since 0070; only 0098 adds ''blocked''.'),
  ('B0098f', 'column',   'package_validations', 'overridden_at', null,
   '0098 column package_validations.overridden_at', 'absent', 'present', 'present', null),
  -- 0099: never in the sitting (ADR 0008 step 20, ADR 0009 steps 10-11)
  ('B0099a', 'column',   'v_course_attempt_summary', 'live_attempt_count', null,
   '0099 column v_course_attempt_summary.live_attempt_count', 'absent', 'absent', 'present',
   'ADR 0009 step 11 probe. Present before or right after the sitting = 0099 was applied too early: STOP and ask.'),
  ('B0099b', 'policy',   'course_attempts', 'members create own attempts', null,
   '0002 write policy "members create own attempts" on course_attempts (0099 drops it)',
   'present', 'present', 'absent', 'ADR 0009 step 11 probe.'),
  ('B0099c', 'policy',   'course_attempts', 'members update own attempts', null,
   '0002 write policy "members update own attempts" on course_attempts (0099 drops it)',
   'present', 'present', 'absent', 'ADR 0009 step 11 probe.'),
  ('B0099d', 'policy',   'package_validations', 'admins manage package validations', null,
   '0070 policy "admins manage package validations" (0099 replaces it)',
   'present', 'present', 'absent', 'ADR 0008 step 19.'),
  ('B0099e', 'policy',   'package_validations', 'admins read package validations', null,
   '0099 policy "admins read package validations"',
   'absent', 'absent', 'present', 'ADR 0008 step 19.'),
  -- alds core: written "0099" in ADR 0003/0005/0007, numbered 0100 since ADR 0008 decision 2
  ('B0100a', 'column',   'course_versions', 'conformance_level', null,
   'alds core (0100) column course_versions.conformance_level', 'absent', 'absent', 'absent',
   'ADR 0007 step 2 lists it as a planned 0098/0099 object; renumbered to 0100 (ADR 0008 decision 2). Present anywhere = STOP and ask.'),
  ('B0100b', 'column',   'course_attempts', 'is_preview', null,
   'alds core (0100) column course_attempts.is_preview', 'absent', 'absent', 'absent', 'As B0100a.'),
  ('B0100c', 'table',    'learning_sessions', null, null,
   'alds core (0100) table learning_sessions', 'absent', 'absent', 'absent', 'As B0100a.'),
  ('B0100d', 'table',    'package_certifications', null, null,
   'alds core (0100) table package_certifications', 'absent', 'absent', 'absent', 'As B0100a.')
) as p(check_id, kind, rel, obj, val, label, exp_before, exp_after, exp_0099, note);

-- ---------------------------------------------------------------------------
-- C. The 0032 constraint state (ADR 0003 steps 7 and 7a)
-- ---------------------------------------------------------------------------
-- C01-C02 are catalog probes; C03-C04 count rows; C05 states what 0032 will
-- do here. Staging reference (2026-10-16): per-package constraint only,
-- 9 duplicate (course_id, version_number) pairs, 0 (package_id, version_number).
insert into pg_temp.release_audit
select 'C01', '0032 constraint state',
       'legacy constraint course_versions_course_id_version_number_key',
       case when exists (select 1 from pg_catalog.pg_constraint
                         where conname = 'course_versions_course_id_version_number_key'
                           and conrelid = to_regclass('public.course_versions'))
            then 'present' else 'absent' end,
       'any', 'absent', 'absent',
       'Present before = the 0032 hotfix never reached this database; 0032 drops it in the sitting.';
insert into pg_temp.release_audit
select 'C02', '0032 constraint state',
       'per-package constraint course_versions_package_id_version_number_key',
       case when exists (select 1 from pg_catalog.pg_constraint
                         where conname = 'course_versions_package_id_version_number_key'
                           and conrelid = to_regclass('public.course_versions'))
            then 'present' else 'absent' end,
       'any', 'present', 'present',
       'Present before = the hotfix is already applied and 0032 is a no-op here.';

do $audit$
declare
  n bigint;
  m bigint;
  k bigint;
  txt text;
begin
  -- C03 duplicate (course_id, version_number) pairs
  begin
    select count(*) into n from (
      select course_id, version_number from public.course_versions
      group by 1, 2 having count(*) > 1) d;
    insert into pg_temp.release_audit values ('C03', '0032 constraint state',
      'duplicate (course_id, version_number) pairs in course_versions', n::text,
      'info', 'info', 'info',
      'Per-package numbering (0030) makes these normal once the legacy constraint is gone (staging: 9). If C01 is present this must be 0. A migration-replay restore would fail on them (why restore = pg_dump, ADR 0003).');
  exception when others then
    insert into pg_temp.release_audit values ('C03', '0032 constraint state',
      'duplicate (course_id, version_number) pairs in course_versions',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- C04 duplicate (package_id, version_number) pairs
  begin
    select count(*) into n from (
      select package_id, version_number from public.course_versions
      group by 1, 2 having count(*) > 1) d;
    insert into pg_temp.release_audit values ('C04', '0032 constraint state',
      'duplicate (package_id, version_number) pairs in course_versions', n::text,
      '0', '0', '0',
      'Not 0 = 0032 and 0098 cannot add the per-package constraint: STOP before the sitting and ask.');
  exception when others then
    insert into pg_temp.release_audit values ('C04', '0032 constraint state',
      'duplicate (package_id, version_number) pairs in course_versions',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- C05 what 0032 does here
  begin
    select case
             when l and p then 'both'
             when l then 'legacy only'
             when p then 'per-package only'
             else 'neither' end
      into txt
    from (select
            exists (select 1 from pg_catalog.pg_constraint
                    where conname = 'course_versions_course_id_version_number_key'
                      and conrelid = to_regclass('public.course_versions')) as l,
            exists (select 1 from pg_catalog.pg_constraint
                    where conname = 'course_versions_package_id_version_number_key'
                      and conrelid = to_regclass('public.course_versions')) as p) s;
    insert into pg_temp.release_audit values ('C05', '0032 constraint state',
      'which version-number constraint(s) exist', txt,
      'any', 'per-package only', 'per-package only',
      case txt
        when 'per-package only' then '0032 is a no-op here (hotfix already applied).'
        when 'legacy only' then '0032 is a real change here: drops the legacy constraint, adds the per-package one (needs C04 = 0).'
        when 'both' then '0032 drops the legacy constraint; the per-package one stays.'
        else '0032 adds the per-package constraint (needs C04 = 0).' end);
  exception when others then
    insert into pg_temp.release_audit values ('C05', '0032 constraint state',
      'which version-number constraint(s) exist',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- -------------------------------------------------------------------------
  -- D. Data checks
  -- -------------------------------------------------------------------------

  -- D01 attempt rows (the ADRs assert production has none as of 2026-10-17)
  begin
    select count(*), count(*) filter (where status = 'in_progress') into n, m
    from public.course_attempts;
    select string_agg(status || ' ' || c, ', ' order by status) into txt
    from (select status, count(*) c from public.course_attempts group by status) s;
    insert into pg_temp.release_audit values ('D01', 'data',
      'course_attempts rows (all organisations)', n::text,
      'info', 'info', 'info',
      'By status: ' || coalesce(txt, 'none') || '. Production had no attempt rows on 2026-10-17; a non-zero count there widens the D03-D06 lists, nothing else.');
  exception when others then
    insert into pg_temp.release_audit values ('D01', 'data', 'course_attempts rows (all organisations)',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D02 storage-prefix gate (ADR 0003 step 8; 0098's precondition)
  begin
    select count(*) into n from (
      select storage_prefix from public.course_versions
      group by 1 having count(*) > 1) d;
    select string_agg(x, ' | ') into txt from (
      select storage_prefix || ' <- ' || string_agg(id::text, ', ' order by uploaded_at) as x
      from public.course_versions
      group by storage_prefix having count(*) > 1
      order by storage_prefix limit 50) d;
    insert into pg_temp.release_audit values ('D02', 'data',
      'storage-prefix gate: storage_prefix values shared by more than one version', n::text,
      '0', '0', '0',
      case when n = 0 then 'Gate open: 0098 can create course_versions_storage_prefix_key.'
           else 'STOP: repoint each listed version to its own package-scoped folder first (ADR 0007 step 3, ops/release-v1.3.0-repoint.md, written on demand), ledger every repoint, then re-run. Shared (prefix <- version ids, oldest first): ' || txt
                || case when n > 50 then ' (+' || (n - 50) || ' more prefixes; list cut at 50: repoint these, then re-run for the rest)' else '' end end);
  exception when others then
    insert into pg_temp.release_audit values ('D02', 'data',
      'storage-prefix gate: storage_prefix values shared by more than one version',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D03 inactive packages with in-progress attempts (ADR 0004 step 16;
  -- ADR 0007 step 2 acceptance list; acceptance condition a)
  begin
    select count(*) filter (where not q), count(*) filter (where q) into n, m
    from (
      select coalesce(o.slug like 'qa-%', false) as q
      from public.course_attempts a
      join public.course_versions v on v.id = a.course_version_id
      join public.course_packages p on p.id = v.package_id
      left join public.organizations o on o.id = a.organization_id
      where a.status = 'in_progress' and p.is_active = false) s;
    insert into pg_temp.release_audit values ('D03', 'data',
      'in-progress attempts on inactive packages (non-qa organisations)', n::text,
      'review', 'review', 'review',
      'After v1.3.0 the launch rule (ADR 0004 step 9 (3)) abandons each of these at the learner''s next launch. The owner reads the D03.nnnnn rows before the tag (acceptance condition a). qa-* rows skipped: ' || m || '.');
    insert into pg_temp.release_audit
    select 'D03.' || lpad(row_number() over (order by p.id)::text, 5, '0'), 'data',
           'inactive package ' || p.id || ' (course ' || p.course_id || ', slot ' || coalesce(p.language, 'default') || ')',
           count(*)::text, 'review', 'review', 'review',
           'attempt ids (role class): ' || string_agg(
             a.id || ' (' || case when exists (
               select 1 from public.organization_members om
               where om.organization_id = a.organization_id and om.user_id = a.user_id
                 and om.role::text in ('super_owner', 'admin', 'data_analyst'))
             then 'staff' else 'learner' end || ', version ' || v.id || ')', '; ' order by a.started_at)
    from public.course_attempts a
    join public.course_versions v on v.id = a.course_version_id
    join public.course_packages p on p.id = v.package_id
    left join public.organizations o on o.id = a.organization_id
    where a.status = 'in_progress' and p.is_active = false
      and not coalesce(o.slug like 'qa-%', false)
    group by p.id, p.course_id, p.language;
  exception when others then
    insert into pg_temp.release_audit values ('D03', 'data',
      'in-progress attempts on inactive packages (non-qa organisations)',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D04 course default versus slot titles (ADR 0004 steps 12a and 16;
  -- ADR 0008 step 16). One summary row, then one row per non-qa course.
  begin
    insert into pg_temp.release_audit
    with slot as (
      select p.course_id, p.id as package_id, coalesce(p.language, 'default') as lang,
             p.is_active, p.current_version_id,
             nullif(btrim(v.manifest_data ->> 'title'), '') as title
      from public.course_packages p
      left join public.course_versions v on v.id = p.current_version_id
    ),
    d as (
      select c.id as course_id, c.organization_id, c.title as course_title,
             c.current_version_id as default_vid,
             dv.package_id as default_pkg,
             nullif(btrim(dv.manifest_data ->> 'title'), '') as default_title,
             dp.is_active as default_pkg_active,
             coalesce(dp.language, 'default') as default_lang,
             (dp.current_version_id = dv.id) as default_is_pkg_current,
             to_jsonb(dv) ->> 'upload_status' as default_upload_status
      from public.courses c
      left join public.organizations o on o.id = c.organization_id
      left join public.course_versions dv on dv.id = c.current_version_id
      left join public.course_packages dp on dp.id = dv.package_id
      where not coalesce(o.slug like 'qa-%', false)
    ),
    f as (
    select d.course_id,
           nullif(concat_ws(', ',
             case when d.default_vid is null and exists (
                    select 1 from slot s where s.course_id = d.course_id and s.is_active
                      and s.current_version_id is not null)
                  then 'NO_DEFAULT' end,
             case when d.default_pkg_active = false then 'DEFAULT_SLOT_INACTIVE' end,
             case when d.default_vid is not null and d.default_is_pkg_current = false
                  then 'DEFAULT_NOT_SLOT_CURRENT' end,
             case when d.default_upload_status is not null and d.default_upload_status <> 'ready'
                  then 'DEFAULT_NOT_READY' end,
             case when d.default_title is not null
                   and exists (select 1 from slot s where s.course_id = d.course_id
                                 and s.package_id <> d.default_pkg and s.is_active and s.title is not null)
                   and not exists (select 1 from slot s where s.course_id = d.course_id
                                     and s.package_id <> d.default_pkg and s.is_active
                                     and lower(s.title) = lower(d.default_title))
                  then 'TITLE_DIFFERS_FROM_OTHER_SLOTS' end,
             case when d.default_title is not null and exists (
                    select 1 from public.courses c2
                    left join public.course_packages p2 on p2.course_id = c2.id
                    left join public.course_versions v2 on v2.id = p2.current_version_id
                    where c2.organization_id = d.organization_id and c2.id <> d.course_id
                      and (lower(btrim(c2.title)) = lower(d.default_title)
                           or lower(btrim(v2.manifest_data ->> 'title')) = lower(d.default_title)))
                  then 'TITLE_BELONGS_TO_ANOTHER_COURSE' end
           ), '') as flags,
           'default version ' || coalesce(d.default_vid::text, 'none')
             || ' (slot ' || coalesce(d.default_lang, '-') || ', title "' || coalesce(d.default_title, '-') || '")'
             || '; course title "' || coalesce(d.course_title, '-') || '"'
             || '; slots: ' || coalesce((
                  select string_agg(s.lang || (case when s.is_active then '' else ' [inactive]' end)
                                    || ' "' || coalesce(s.title, '-') || '"', ' | ' order by s.lang)
                  from slot s where s.course_id = d.course_id), 'none') as detail
    from d)
    select 'D04.' || lpad(row_number() over (order by (f.flags is null), f.course_id)::text, 5, '0'), 'data',
           'course ' || f.course_id, coalesce(f.flags, 'no flag'),
           'review', 'review', 'review', f.detail
    from f;

    select count(*), count(*) filter (where observed <> 'no flag') into n, m
    from pg_temp.release_audit where check_id like 'D04.%';
    insert into pg_temp.release_audit values ('D04', 'data',
      'courses whose default (courses.current_version_id) looks wrong against its slots (non-qa)',
      m::text, 'review', 'review', 'review',
      'Of ' || n || ' non-qa courses. Flags are heuristics (a translated slot title differs legitimately); TITLE_BELONGS_TO_ANOTHER_COURSE and DEFAULT_SLOT_INACTIVE are the wrong-default class of ADR 0004 step 12a. Each course is listed as D04.nnnnn, flagged first. Production clean-up of a flagged course follows ADR 0008 step 16 after v1.3.0. The stored-bytes check (ADR 0004 step 16) is separate: SQL cannot read package bytes.');
  exception when others then
    insert into pg_temp.release_audit values ('D04', 'data',
      'courses whose default (courses.current_version_id) looks wrong against its slots (non-qa)',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D05 cmi5 attempts completed in under 60 s (ADR 0007 steps 2 and 8:
  -- first-slide completions before #118; history, never rewritten). Counts
  -- completion_status = 'completed' only: before #118 a "terminated" verb
  -- also stamped completed_at on an attempt that was not complete, and those
  -- quick exits are not completions.
  begin
    select count(*) filter (where not q), count(*) filter (where q),
           count(distinct version_id) filter (where not q) into n, m, k
    from (
      select coalesce(o.slug like 'qa-%', false) as q, v.id as version_id
      from public.course_attempts a
      join public.course_versions v on v.id = a.course_version_id
      left join public.organizations o on o.id = a.organization_id
      where v.manifest_type = 'cmi5' and a.completion_status = 'completed'
        and a.completed_at is not null
        and a.completed_at - a.started_at < interval '60 seconds') s;
    select string_agg(x, ' | ') into txt from (
      select 'version ' || v.id || ': ' || count(*) as x
      from public.course_attempts a
      join public.course_versions v on v.id = a.course_version_id
      left join public.organizations o on o.id = a.organization_id
      where v.manifest_type = 'cmi5' and a.completion_status = 'completed'
        and a.completed_at is not null
        and a.completed_at - a.started_at < interval '60 seconds'
        and not coalesce(o.slug like 'qa-%', false)
      group by v.id order by count(*) desc, v.id limit 50) d;
    insert into pg_temp.release_audit values ('D05', 'data',
      'cmi5 attempts completed less than 60 s after they started (non-qa)', n::text,
      'info', 'info', 'info',
      'Counted: completion_status = completed and completed_at less than 60 s after started_at; exits without completion before #118 (completed_at stamped by terminated) are excluded. History, never rewritten (ADR 0002 decision 4). This count goes into the release notes labelled as history, with this definition. qa-* rows skipped: ' || m || '. Per version (most first): ' || coalesce(txt, 'none')
        || case when k > 50 then ' (+' || (k - 50) || ' more versions; list cut at 50)' else '' end);
  exception when others then
    insert into pg_temp.release_audit values ('D05', 'data',
      'cmi5 attempts completed less than 60 s after they started (non-qa)',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D06 completed cmi5/xAPI attempts with zero AU-level outcome statements
  -- (approximates lib/xapi/process-statement.ts launchedActivityIds +
  -- isAboutAu: btrim strips spaces only where JS trim() also strips tabs,
  -- newlines and NBSP, and lower() may fold non-ASCII letters differently from
  -- toLowerCase(); either can only move a rare attempt in or out. Info only.)
  begin
    with z as (
    select a.id as attempt_id, coalesce(o.slug like 'qa-%', false) as q
    from public.course_attempts a
    join public.course_versions v on v.id = a.course_version_id
    left join public.organizations o on o.id = a.organization_id
    where v.manifest_type in ('cmi5', 'xapi') and a.completion_status = 'completed'
      and not exists (
        select 1 from public.xapi_statements s
        where s.attempt_id = a.id
          and s.raw -> 'verb' ->> 'id' in ('http://adlnet.gov/expapi/verbs/completed',
                                           'http://adlnet.gov/expapi/verbs/passed',
                                           'http://adlnet.gov/expapi/verbs/failed')
          and coalesce(nullif(s.raw -> 'object' ->> 'objectType', ''), 'Activity') = 'Activity'
          and lower(regexp_replace(btrim(s.raw -> 'object' ->> 'id'), '/+$', '')) in (
                select lower(regexp_replace(btrim(u.x), '/+$', ''))
                from (select v.manifest_data -> 'raw' ->> ids.idkey
                        from unnest(array['auId', 'activityId', 'courseId']) as ids(idkey)
                       where jsonb_typeof(v.manifest_data -> 'raw' -> ids.idkey) = 'string'
                      union all
                      select 'urn:uuid:' || v.id::text) as u(x)
                where btrim(u.x) <> '')))
    select count(*) filter (where not q), count(*) filter (where q),
           (select string_agg(attempt_id::text, ', ' order by attempt_id)
              from (select attempt_id from z where not q order by attempt_id limit 100) l)
      into n, m, txt
    from z;
    insert into pg_temp.release_audit values ('D06', 'data',
      'completed cmi5/xAPI attempts with zero AU-level completed/passed/failed statements (non-qa)', n::text,
      'info', 'info', 'info',
      'History (completions before #118 counted screen-level statements); never rewritten. The match approximates the app''s AU-id rule (see the comment in the file). qa-* rows skipped: ' || m || '. Attempt ids (first 100): ' || coalesce(txt, 'none')
        || case when n > 100 then ' (+' || (n - 100) || ' more; list cut at 100)' else '' end);
  exception when others then
    insert into pg_temp.release_audit values ('D06', 'data',
      'completed cmi5/xAPI attempts with zero AU-level completed/passed/failed statements (non-qa)',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D07 enabled CRM completion webhooks per organisation (0071). v1.3.0
  -- starts firing cmi5/xAPI completions to them (#148, official attempts).
  begin
    if to_regclass('public.org_integration_settings') is null then
      insert into pg_temp.release_audit values ('D07', 'data',
        'organisations with a CRM completion webhook configured', 'table absent',
        'review', 'review', 'review', 'org_integration_settings is missing: production is below 0071 (see B0071b): STOP.');
    else
      select count(*) into n from public.org_integration_settings
      where nullif(btrim(webhook_url), '') is not null;
      insert into pg_temp.release_audit values ('D07', 'data',
        'organisations with a CRM completion webhook configured', n::text,
        'review', 'review', 'review',
        'Each one receives cmi5/xAPI completion webhooks for the first time after v1.3.0 (official attempts only): the CRM consumer signs off before the tag (ADR 0007 step 8). Listed as D07.nnnnn (host only; the secret is never read).');
      insert into pg_temp.release_audit
      select 'D07.' || lpad(row_number() over (order by s.organization_id)::text, 5, '0'), 'data',
             'organisation ' || s.organization_id || coalesce(' (' || o.slug || ')', ''),
             'webhook host ' || coalesce(nullif(regexp_replace(regexp_replace(regexp_replace(
               btrim(s.webhook_url), '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''), '^[^@/?#]*@', ''), '[/?#:].*$', ''), ''), '(unparsed)'),
             'review', 'review', 'review', null
      from public.org_integration_settings s
      left join public.organizations o on o.id = s.organization_id
      where nullif(btrim(s.webhook_url), '') is not null;
    end if;
  exception when others then
    insert into pg_temp.release_audit values ('D07', 'data',
      'organisations with a CRM completion webhook configured',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D08 enabled tenant LRS configurations (0044; statement_profile from 0078,
  -- read through to_jsonb so the row reads at 0071 too)
  begin
    select count(*) into n from public.tenant_lrs_config where enabled;
    insert into pg_temp.release_audit values ('D08', 'data',
      'enabled tenant_lrs_config rows', n::text,
      'review', 'review', 'review',
      '0078 switches every enabled feed to the ambak-v1 profile when the code deploys. Decision 3 (ADR 0007): set statement_profile = raw on each one right after 0078 unless its consumer was told about ambak-v1 (the runbook has the UPDATE). Listed as D08.nnnnn (endpoint host only). After the sitting and before the tag, each D08.nnnnn statement_profile must match the per-organisation decision recorded before the sitting (runbook §4.6, §5).');
    insert into pg_temp.release_audit
    select 'D08.' || lpad(row_number() over (order by c.organization_id)::text, 5, '0'), 'data',
           'organisation ' || c.organization_id || coalesce(' (' || o.slug || ')', ''),
           'statement_profile ' || coalesce(to_jsonb(c) ->> 'statement_profile', 'n/a (before 0078)'),
           'review', 'review', 'review',
           'endpoint host ' || coalesce(nullif(regexp_replace(regexp_replace(regexp_replace(
             btrim(c.endpoint), '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''), '^[^@/?#]*@', ''), '[/?#:].*$', ''), ''), '(none)')
    from public.tenant_lrs_config c
    left join public.organizations o on o.id = c.organization_id
    where c.enabled;
  exception when others then
    insert into pg_temp.release_audit values ('D08', 'data', 'enabled tenant_lrs_config rows',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D09 current versions without any package_validations row (input to the
  -- owner's validate_existing runs, ADR 0007 decision 6). The Library's
  -- "Validate now" button (action validate_existing) scans the COURSE DEFAULT
  -- version only, so the other slots are listed separately.
  begin
    if to_regclass('public.package_validations') is null then
      insert into pg_temp.release_audit values ('D09', 'data',
        'current versions (one per slot) with no package_validations row (non-qa)', 'table absent',
        'no error', 'no error', 'no error', 'package_validations is missing: production is below 0070 (see B0070): STOP.');
    else
      insert into pg_temp.release_audit
      with cur as (
        select p.course_id, coalesce(p.language, 'default') as lang, v.id as version_id,
               coalesce(c.current_version_id = v.id, false) as is_default
        from public.course_packages p
        join public.course_versions v on v.id = p.current_version_id
        join public.courses c on c.id = p.course_id
        left join public.organizations o on o.id = c.organization_id
        where not coalesce(o.slug like 'qa-%', false)
          and not exists (select 1 from public.package_validations pv where pv.course_version_id = v.id))
      select 'D09.' || lpad(row_number() over (order by (not is_default), course_id, lang)::text, 5, '0'), 'data',
             'course ' || course_id || ' (slot ' || lang || ', version ' || version_id || ')',
             case when is_default then 'course default' else 'other slot' end,
             'info', 'info', 'info',
             case when is_default
                  then 'After the v1.3.0 deploy: Library -> the course page -> "Validate now" (ADR 0007 decision 6).'
                  else 'Not the course default: the "Validate now" button scans only the default; no app path validates this slot today.' end
      from cur;
      select count(*), count(*) filter (where observed = 'course default') into n, m
      from pg_temp.release_audit where check_id like 'D09.%';
      insert into pg_temp.release_audit values ('D09', 'data',
        'current versions (one per slot) with no package_validations row (non-qa)', n::text,
        'info', 'info', 'info',
        'Of these, ' || m || ' are course defaults (after the v1.3.0 deploy: Library -> the course page -> "Validate now", ADR 0007 decision 6) and '
          || (n - m) || ' are other slots (the button scans only the course default; no app path validates them today). Every one is listed as D09.nnnnn, course defaults first.');
    end if;
  exception when others then
    insert into pg_temp.release_audit values ('D09', 'data',
      'current versions (one per slot) with no package_validations row (non-qa)',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D10 ADR 0010 step 7: abandoned attempts that are completed or passed
  begin
    with z as (
      select a.id, coalesce(o.slug like 'qa-%', false) as q
      from public.course_attempts a
      left join public.organizations o on o.id = a.organization_id
      where a.status = 'abandoned'
        and (a.completion_status = 'completed' or a.success_status = 'passed'))
    select count(*) filter (where not q), count(*) filter (where q),
           (select string_agg(id::text, ', ' order by id)
              from (select id from z where not q order by id limit 100) l)
      into n, m, txt
    from z;
    insert into pg_temp.release_audit values ('D10', 'data',
      'abandoned attempts that are completed or passed, non-qa (ADR 0010 step 7 count)', n::text,
      '0', '0', '0',
      'The binding runs are right after each 0099 apply (staging done: 0 on 2026-10-18; production after v1.3.0); before that it is a baseline. Non-zero: report to the owner, ledger the ids, change nothing (ADR 0010 decision 2). qa-* rows skipped: ' || m
        || ' (production has none, A03). Attempt ids (first 100): ' || coalesce(txt, 'none')
        || case when n > 100 then ' (+' || (n - 100) || ' more; list cut at 100)' else '' end);
  exception when others then
    insert into pg_temp.release_audit values ('D10', 'data',
      'abandoned attempts that are completed or passed, non-qa (ADR 0010 step 7 count)',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- D11 the 0099 header's cross-organisation read (forged attempt rows)
  begin
    with z as (
      select a.id, coalesce(oa.slug like 'qa-%', false) or coalesce(oc.slug like 'qa-%', false) as q
      from public.course_attempts a
      join public.course_versions v on v.id = a.course_version_id
      join public.courses c on c.id = v.course_id
      left join public.organizations oa on oa.id = a.organization_id
      left join public.organizations oc on oc.id = c.organization_id
      where a.organization_id <> c.organization_id)
    select count(*) filter (where not q), count(*) filter (where q),
           (select string_agg(id::text, ', ' order by id)
              from (select id from z where not q order by id limit 100) l)
      into n, m, txt
    from z;
    insert into pg_temp.release_audit values ('D11', 'data',
      'attempt rows whose organisation differs from their course''s, non-qa', n::text,
      '0', '0', '0',
      'Non-zero = a row forged through PostgREST before 0099. Ledger the ids, change nothing (ADR 0002 decision 4). qa-* rows skipped (either organisation qa-*, e.g. the ADR 0009 probe on staging before a CI purge): ' || m
        || '. Attempt ids (first 100): ' || coalesce(txt, 'none')
        || case when n > 100 then ' (+' || (n - 100) || ' more; list cut at 100)' else '' end);
  exception when others then
    insert into pg_temp.release_audit values ('D11', 'data',
      'attempt rows whose organisation differs from their course''s, non-qa',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;

  -- -------------------------------------------------------------------------
  -- Z. Summary of the migration probes
  -- -------------------------------------------------------------------------
  begin
    insert into pg_temp.release_audit
    with m as (
      select substr(check_id, 2, 4) as mig, bool_and(observed = 'present') as all_present
      from pg_temp.release_audit
      where check_id ~ '^B00(7[2-9]|8[0-9]|9[0-8])'
      group by 1),
    f as (select min(mig) as first_absent from m where not all_present)
    select 'Z01', 'summary', 'first migration of 0072-0098 not (fully) present',
           coalesce(f.first_absent, 'none'), 'any', 'none', 'none',
           'Before the sitting: 0072 or 0073 is the expected answer (the sitting starts there; 0032 always runs first, guarded). Anything else: stop and ask.'
    from f
    union all
    select 'Z02', 'summary', 'migrations of 0072-0098 present ABOVE the first absent one (gaps)',
           coalesce((select string_agg(m.mig, ', ' order by m.mig) from m
                     where m.all_present and m.mig > f.first_absent), 'none'),
           'none', 'none', 'none',
           'Not none = a migration was applied out of order on this database: STOP and ask before applying anything.'
    from f;
  exception when others then
    insert into pg_temp.release_audit values ('Z01', 'summary', 'first migration of 0072-0098 not (fully) present',
      'ERROR ' || sqlstate || ': ' || sqlerrm, 'no error', 'no error', 'no error', 'Read the error; stop and ask.');
  end;
end
$audit$;

-- ---------------------------------------------------------------------------
-- Result: one grid, plus a mismatch count per moment and the END row.
-- ---------------------------------------------------------------------------
select * from (
with r as (
  select a.*,
         case when exp_before in ('any', 'info', 'review') or exp_before is null then ''
              when observed = exp_before then 'ok' else 'MISMATCH' end as at_before,
         case when exp_after in ('any', 'info', 'review') or exp_after is null then ''
              when observed = exp_after then 'ok' else 'MISMATCH' end as at_after,
         case when exp_0099 in ('any', 'info', 'review') or exp_0099 is null then ''
              when observed = exp_0099 then 'ok' else 'MISMATCH' end as at_0099
  from pg_temp.release_audit a
)
select check_id, section, label, observed, exp_before, exp_after, exp_0099,
       at_before, at_after, at_0099, note
from r
union all
select 'Z90', 'summary', 'rows that MISMATCH each moment (before / after / 0099)',
       count(*) filter (where at_before = 'MISMATCH') || ' / '
         || count(*) filter (where at_after = 'MISMATCH') || ' / '
         || count(*) filter (where at_0099 = 'MISMATCH'),
       null, null, null, null, null, null,
       'Read the count for the moment you are at. 0 there plus the review rows read = clean audit (ADR 0007 decision 1: "clean" includes the acceptance checks). ERROR rows always count as MISMATCH.'
from r
union all
select 'ZZ', 'end', 'END OF AUDIT (if you cannot see this row, the grid was cut)',
       (select count(*)::text from r) || ' rows above', null, null, null, null, null, null, null
) as result
order by check_id collate "C";
