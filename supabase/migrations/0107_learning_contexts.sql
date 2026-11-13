-- 0107_learning_contexts.sql — one fixed product context on every learner
-- record (Individual course, Learning Path, Day-wise Journey, Preview), the
-- official rule decided once per context, one writer of completion side
-- effects, and the day identity of journeys (ADR 0024 section B, the core of
-- phase 1; accepted 2026-11-13; the phase 1 build notes N1 to N24 in its
-- Notes correct the steps they name). Hand-apply in the SQL editor with the
-- role selector on postgres, staging first; never `supabase db push` (the
-- CLI is linked to production).
--
-- BUILD STATE (this paragraph is removed when the file is complete): this
-- commit holds section 0 only, the prerequisites and the before-checks. It
-- checks and refuses; it creates and changes nothing outside its own
-- temporary table. Sections 1 to 7 (ADR 0024 section B, creation order items
-- 2 to 7) follow in later commits on the same branch. Do not paste a build
-- of this file that still carries this paragraph.
--
-- ORDER (ADR 0024 steps 73 and 74):
--   Staging: after pull request 1 (this file, 0108, the rehearsal, the pure
--   modules and the fallback-safe readers) is on both staging deployments,
--   after the fixtures pull request that gives specs 46 and 55 their
--   journey_days rows is merged, and after the lifecycle organisations made
--   by earlier runs are gone (deleted, or the nightly paused for 48 hours so
--   its cleanup removes them): a journey fixture without journey_days rows
--   makes Q8 refuse the paste. Paste in a window clear of everything else
--   that uses the staging database: the pg_cron refresh at 03:30 UTC, the
--   lifecycle nightly from 22:41 UTC (about 45 to 80 minutes), the nightly
--   e2e at 04:00 UTC, any pull request's e2e job and any hand-run harness.
--   Production: in the owner's sitting of step 74, after its gates (staging
--   validation, an on-demand backup within the hour, the restore rehearsal,
--   the freeze, the paste minutes), in this order: 0105 if not yet pasted,
--   0106 if not yet pasted, THIS FILE, the release tag, 0108, 0109. 0106 is
--   never pasted before 0105 inside that sitting. Production has no
--   learners and no courses: every attempt, point, credit, enrolment and
--   journey count of section 0b is expected to read 0 there, except two
--   row counts of Q4 that are not learner records: mv_learner_metrics holds
--   one row per organisation member whatever their activity (0073 reads it
--   from organization_members) and mv_leaderboard one row per
--   user_gamification row. The rows Q5.* and Q8.paste carry no count (n is
--   null; note says what they read). A Q8, Q9 or Q10 count above 0 goes to
--   the owner before the paste (ADR 0024 step 74).
--
-- REQUIRES 0100, 0103, 0104, 0105 and 0106 (the DO block of section 0a
-- refuses without them; the full list is under PREREQUISITES).
--
-- NEVER PASTE AGAIN after this file (ADR 0024 step 4). Each file below
-- defines an object this file supersedes, so a re-paste would put back a
-- body that reads no context, or a key that lets a context be erased:
--   0034        the attempt foreign key learning_path_id (on delete set null)
--   0035, 0056  refresh_report_views(), refresh_gamification_views()
--   0053        gamification_record_activity (a re-paste overwrites the 0058
--               wrapper), gamification_close_month and the first
--               refresh_gamification_views()
--   0058        the gamification_record_activity wrapper,
--               journey_record_completion, the first journey_auto_enroll and
--               the attempt foreign key journey_enrollment_id (on delete set
--               null)
--   0062, 0083  the open-row indexes course_attempts_one_in_progress_idx and
--               attempt_requests_one_open_idx (0103 also refuses to run
--               without the 0062 index)
--   0073        gamification_record_activity_core, gamification_close_month
--               (and the two scoring views, under 0103's rule below)
--   0081, 0088, 0089  journey_record_completion (0089 also
--               journey_reminder_counts)
--   0084        gamification_record_activity_core
--   0096        journey_auto_enroll
--   0098, 0100  the two delete guards guard_learner_history_course_versions()
--               and guard_learner_history_courses(): a re-paste puts back a
--               body that lets rows flagged as previews by role cascade away
--               (ADR 0024 step 7)
--   0103        consume_grant, record_revision_visit and the two scoring views
--   0105        v_course_enrollments_expanded
-- and the earlier definers of the same objects: 0031 (the course enrolment
-- view, v_course_attempt_summary and the first refresh_report_views()),
-- 0082 (v_course_attempt_summary), 0063 (journey_auto_enroll; a re-paste
-- would make audience enrolments read admin), and every file that defines
-- notification_templates_event_type_check:
-- 0014, 0015, 0016, 0025, 0059 and 0065 (a re-paste drops journey_completion
-- from the check, or fails once such a template is stored). The rule of 0103
-- stands as well: never 0073, 0081, 0090, 0092, 0095 or 0099 after 0103.
-- After 0109 this file itself is never pasted again: 0109 recreates the two
-- refresh functions, and a re-paste of this file would strip its matviews
-- and its snapshot from them (ADR 0024 step 21).
--
-- FIRST PASTE AND RE-PASTE (ADR 0024 step 4). The file is idempotent and
-- retry-safe: a second paste changes nothing. One transaction: on a lock
-- timeout or a deadlock nothing changed, paste it again. The FIRST paste is
-- the one that finds journey_day_progress.day_id absent (section 0b says
-- which in the note of its row Q8.paste).
--   Backfills run once. Every backfill of this file (ADR 0024 steps 5, 7 and
--   8) runs only inside the DO block that adds its column, and only when that
--   block finds the column absent; on a later paste the block does nothing.
--   So a re-paste never touches a value the new code wrote: a completed row
--   whose writer call failed stays a sweep candidate, and a held SCORM row is
--   never marked as never sending.
--   Q8 refuses on the first paste only. Once the new editor has removed or
--   moved a day, older versions' numbers and attempts' launch-time numbers
--   rightly match no active journey_days row, so on a later paste Q8 is a
--   count and refuses nothing.
--   The after-checks that count backfilled rows apply to the first paste
--   only (ADR 0024 step 19).
--   On staging a re-paste stays possible until 0109.
--
-- Row writes: none in this commit (the temporary table of section 0b is the
-- session's own and is dropped at commit).
--
-- PREREQUISITES (the DO block of section 0a refuses to run without them; for
-- every object this file replaces it accepts the earlier state and its own,
-- so the second paste passes):
--   0003  course_attempts.completion_status, success_status
--   0008  learning_path_courses.step_number
--   0014  notification_templates (the event-type check of 0065, below)
--   0017  learning_paths.is_active
--   0033  learning_paths.visibility
--   0034  course_attempts.learning_path_id with its foreign key;
--         learning_paths.sequence_mode
--   0044  lrs_forward_outbox.attempt_id
--   0052  learning_path_courses.release_at
--   0053  xp_events, user_badges.period, gamification_settings.timezone,
--         course_attempts.last_activity_at, gamification_close_month(),
--         refresh_gamification_views()
--   0058  the journey tables (programs, days, versions, enrolments,
--         day progress); course_attempts.journey_enrollment_id with its
--         foreign key, and journey_day; gamification_record_activity(uuid)
--         (the wrapper) and journey_record_completion(uuid)
--   0065  journey_programs.deadline_days; the event-type check admits
--         'journey_escalation'
--   0071  org_api_keys, org_integration_settings
--   0081  courses.pass_required, effective_attempt_policy(uuid)
--   0082  course_attempts.completion_webhook_at
--   0083  attempt_requests (used_attempt_id); its open-request index, or
--         this file's
--   0084  gamification_record_activity_core(uuid); xp_events_rule_check
--         admits 'course_passed'
--   0088  journey_programs.unlock_mode, journey_versions.unlock_mode
--   0089  journey_reminder_counts(uuid[]) (either return type: this file
--         drops and creates it with a fourth column)
--   0090  v_course_attempt_summary.official_attempt_id; the report matviews
--   0096  journey_auto_enroll()
--   0098  the delete guards and their two triggers, still bound
--   0099  v_course_attempt_summary.live_attempt_count
--   0100  course_attempts.is_preview, launch_mode, served_language;
--         learning_sessions, package_certifications; the delete guards'
--         0100 bodies or this file's (both name is_preview; the 0098 body
--         does not, and a database holding it is refused)
--   0103  course_attempts.is_revision; revision_visits;
--         attempt_requests.reissued_from and override_confirmed;
--         consume_grant (eight arguments) and record_revision_visit (six)
--   0104  course_attempts.ignored_pass
--   0105  v_group_members_expanded, group_member_ids(uuid); the two
--         enrolment views with exactly (course_id, user_id) and
--         (path_id, user_id)
--   0106  v_course_feedback_responses, course_feedback_summary(uuid)
--   and, in either state: the open-row index of 0062 or this file's;
--   unique (enrollment_id, day_number) on journey_day_progress or this
--   file's unique (enrollment_id, day_id).
--
-- BEFORE the apply (read-only; role postgres; counts only, never an id or a
-- name). Q1 to Q10 are ONE read-only select: section 0b below, from the line
-- `with` to its `;`. Run it alone in the SQL editor and record every row
-- (q, n, note, refuses) under ADR 0024 before the paste. The paste runs the
-- same select into a temporary table, and section 0c refuses the paste on
-- the rows marked refuses (Q2 always, Q8 on the first paste) when their n is
-- above 0; the after-checks compare against the same table. What each
-- prefix counts:
--   Q1   course_attempts by tag shape (P = learning_path_id, J =
--        journey_enrollment_id, D = journey_day; .preview when is_preview),
--        and by the context_kind the backfill will write (step 5: is_preview
--        → preview; else the journey tag → journey; else the path tag →
--        path; else individual). Step 19 compares its counts by
--        context_kind with these.
--   Q2   REFUSES when above 0, on every paste: rows the shape CHECK would
--        refuse. Not previews, each: both a path and a journey tag
--        (both_tags); a journey tag with a null journey_day
--        (journey_null_day); journey_day set with no journey_enrollment_id,
--        the orphans of deleted programs (orphan_day). Counted only: preview
--        rows that carry any tag (step 6: they become legacy_role and keep
--        their tags) and abandoned rows that are completed or passed
--        (expected 0, ADR 0010 step 7).
--   Q3   open rows (status in_progress), distinct (learner, version) pairs
--        among them, the most on one pair (1 while the 0062 index holds), and
--        open rows by context_kind.
--   Q4   the report matviews as last refreshed: the course and path status
--        and performance sums, and the row counts of the other four.
--   Q5   the delete rule of the two attempt foreign keys (learning_path_id,
--        journey_enrollment_id), in note: 'set null' before the first paste,
--        'no action' after it.
--   Q6   xp_events by rule, and by the context_kind of the attempt a row
--        points at.
--   Q7   journey_day_progress rows by what backs them: a journey row of the
--        same enrolment, no attempt, a preview row, or another row. Every row
--        but the first becomes credit_kind legacy_cross_context (step 8).
--   Q8   REFUSES when above 0, on the first paste only, because a day
--        identity would be invented: journey_versions.days entries with no
--        journey_days row for (program, day number) (version_days); journey
--        attempts, not previews, whose (program, journey_day) has no
--        journey_days row (journey_attempts); journey_day_progress rows whose
--        (program, day_number) has none (progress_rows). Counted only:
--        preview rows with a journey tag and no such row, and duplicate day
--        numbers inside one version. Q8.paste names the paste in its note
--        (first, Q8 refuses; later, Q8 counts only) and has no count.
--   Q9   drift from earlier publishes to all, counts only (step 94's gate
--        is Q9.e_*.at_or_below_furthest). A required day is an entry of the
--        pinned version's days with a course and day <= days_total; the open
--        day is the lowest required day with no credit row by number; the
--        furthest day is the larger of the highest credited day number and
--        the highest journey_day of any journey attempt of the enrolment.
--        a: credit rows whose course differs from the pinned version's course
--        on that day number. b: credit rows on a day number that is not a
--        required day of the pinned version. c: in-progress journey attempts
--        whose day is not the open day (c_not_open_day), or whose pinned day
--        holds another course (c_other_course), or either (c). d: active
--        enrolments whose credits are not an unbroken run from the first
--        required day. e: active enrolments against the program's current
--        version and against its draft (journey_days, the program's
--        days_total), classed by where the first day-by-day difference falls
--        against the furthest day.
--   Q10  rows flagged is_preview today (they become legacy_role and are
--        kept, step 82): how many; completed; launch_mode Normal (flagged by
--        the 0100 backfill); carrying a result (completed, passed, failed or
--        scored) per launch mode; the target of a used grant; the xp_events,
--        journey_day_progress and lrs_forward_outbox rows pointing at one;
--        completed rows of a person with no other official result on that
--        course (after this file their result is hidden, step 82); still
--        open.
--   Staging, read on 2026-11-13 (ADR 0024 note N23): Q1 907 rows
--   (individual 629, path 221, journey 6, preview 51); Q2 refusals 0, 0, 0;
--   Q8 REFUSED (6 version days and 6 journey attempts, all in lifecycle
--   fixture organisations; it clears after step 73's actions); Q10 51 rows.
--   Run the select again just before the paste.
--
-- AFTER the apply: the after-checks A1 to A24 (ADR 0024 step 19) run inside
-- this file, at its end, against the table of section 0b (a later commit).

begin;

-- A lock wait must never queue the app's reads and writes behind this file:
-- if a lock is not granted within 5 s the whole transaction rolls back
-- cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0a. Prerequisites
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_cols text;
begin
  for r in
    select * from (values
      ('public.organizations',                    '0001'),
      ('public.course_attempts',                  '0002'),
      ('public.learning_paths',                   '0008'),
      ('public.learning_path_courses',            '0008'),
      ('public.learning_path_assignments',        '0008'),
      ('public.notification_templates',           '0014'),
      ('public.lrs_forward_outbox',               '0044'),
      ('public.xp_events',                        '0053'),
      ('public.user_badges',                      '0053'),
      ('public.gamification_settings',            '0053'),
      ('public.journey_programs',                 '0058'),
      ('public.journey_days',                     '0058'),
      ('public.journey_versions',                 '0058'),
      ('public.journey_enrollments',              '0058'),
      ('public.journey_day_progress',             '0058'),
      ('public.org_api_keys',                     '0071'),
      ('public.org_integration_settings',         '0071'),
      ('public.attempt_requests',                 '0083'),
      ('public.mv_course_interaction_breakdown',  '0031'),
      ('public.mv_course_interaction_top_wrong',  '0035'),
      ('public.mv_leaderboard',                   '0073'),
      ('public.mv_learner_metrics',               '0073'),
      ('public.mv_course_performance',            '0090'),
      ('public.mv_path_performance',              '0090'),
      ('public.mv_course_enrollment_status',      '0099'),
      ('public.mv_path_enrollment_status',        '0099'),
      ('public.learning_sessions',                '0100'),
      ('public.package_certifications',           '0100'),
      ('public.revision_visits',                  '0103'),
      ('public.v_course_attempt_scoring',         '0103'),
      ('public.v_course_attempt_summary',         '0103'),
      ('public.v_course_enrollments_expanded',    '0105'),
      ('public.v_path_enrollments_expanded',      '0105'),
      ('public.v_group_members_expanded',         '0105'),
      ('public.v_course_feedback_responses',      '0106')
    ) as t(rel, mig)
  loop
    if to_regclass(r.rel) is null then
      raise exception '0107 refused: % is missing (apply % first).', r.rel, r.mig;
    end if;
  end loop;

  for r in
    select * from (values
      ('course_attempts',          'completion_status',     '0003'),
      ('course_attempts',          'success_status',        '0003'),
      ('course_attempts',          'learning_path_id',      '0034'),
      ('course_attempts',          'last_activity_at',      '0053'),
      ('course_attempts',          'journey_enrollment_id', '0058'),
      ('course_attempts',          'journey_day',           '0058'),
      ('course_attempts',          'completion_webhook_at', '0082'),
      ('course_attempts',          'is_preview',            '0100'),
      ('course_attempts',          'launch_mode',           '0100'),
      ('course_attempts',          'served_language',       '0100'),
      ('course_attempts',          'is_revision',           '0103'),
      ('course_attempts',          'ignored_pass',          '0104'),
      ('learning_path_courses',    'step_number',           '0008'),
      ('learning_path_courses',    'release_at',            '0052'),
      ('learning_paths',           'is_active',             '0017'),
      ('learning_paths',           'visibility',            '0033'),
      ('learning_paths',           'sequence_mode',         '0034'),
      ('lrs_forward_outbox',       'attempt_id',            '0044'),
      ('user_badges',              'period',                '0053'),
      ('gamification_settings',    'timezone',              '0053'),
      ('journey_programs',         'deadline_days',         '0065'),
      ('journey_programs',         'unlock_mode',           '0088'),
      ('journey_versions',         'unlock_mode',           '0088'),
      ('journey_versions',         'days',                  '0058'),
      ('journey_versions',         'days_total',            '0058'),
      ('journey_versions',         'count_sundays',         '0058'),
      ('courses',                  'pass_required',         '0081'),
      ('attempt_requests',         'used_attempt_id',       '0083'),
      ('attempt_requests',         'reissued_from',         '0103'),
      ('attempt_requests',         'override_confirmed',    '0103'),
      ('v_course_attempt_summary', 'official_attempt_id',   '0090'),
      ('v_course_attempt_summary', 'live_attempt_count',    '0099')
    ) as t(tbl, col, mig)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) then
      raise exception '0107 refused: %.% is missing (apply % first).', r.tbl, r.col, r.mig;
    end if;
  end loop;

  for r in
    select * from (values
      ('public.effective_attempt_policy(uuid)',                                '0081'),
      ('public.gamification_record_activity(uuid)',                            '0058'),
      ('public.gamification_record_activity_core(uuid)',                       '0084'),
      ('public.gamification_close_month()',                                    '0073'),
      ('public.journey_record_completion(uuid)',                               '0089'),
      ('public.journey_reminder_counts(uuid[])',                               '0089'),
      ('public.journey_auto_enroll()',                                         '0096'),
      ('public.refresh_report_views()',                                        '0035'),
      ('public.refresh_gamification_views()',                                  '0056'),
      ('public.guard_learner_history_course_versions()',                       '0100'),
      ('public.guard_learner_history_courses()',                               '0100'),
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)',     '0103'),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)',          '0103'),
      ('public.group_member_ids(uuid)',                                        '0105'),
      ('public.course_feedback_summary(uuid)',                                 '0106')
    ) as t(fn, mig)
  loop
    if to_regprocedure(r.fn) is null then
      raise exception '0107 refused: % is missing (apply % first).', r.fn, r.mig;
    end if;
  end loop;

  -- The delete guards: the 0100 body or this file's (both count by
  -- is_preview); the 0098 body is refused, because 0098 must never be
  -- pasted after 0100. Their two 0098 triggers must still be bound to them.
  if pg_get_functiondef(to_regprocedure('public.guard_learner_history_course_versions()')) not like '%is_preview%'
     or pg_get_functiondef(to_regprocedure('public.guard_learner_history_courses()')) not like '%is_preview%' then
    raise exception '0107 refused: the delete guards hold the 0098 bodies (paste 0100 again first; never 0098 after 0100).';
  end if;
  if not exists (
       select 1 from pg_trigger t
       where t.tgrelid = 'public.course_versions'::regclass
         and t.tgname = 'course_versions_guard_learner_history'
         and t.tgfoid = to_regprocedure('public.guard_learner_history_course_versions()'))
     or not exists (
       select 1 from pg_trigger t
       where t.tgrelid = 'public.courses'::regclass
         and t.tgname = 'courses_guard_learner_history'
         and t.tgfoid = to_regprocedure('public.guard_learner_history_courses()')) then
    raise exception '0107 refused: the 0098 delete-guard triggers are missing or unbound (apply 0098 first).';
  end if;

  -- The 0105 enrolment views keep exactly these columns in both states.
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_course_enrollments_expanded';
  if v_cols is distinct from 'course_id,user_id' then
    raise exception '0107 refused: v_course_enrollments_expanded has columns (%), not (course_id,user_id).', v_cols;
  end if;
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_path_enrollments_expanded';
  if v_cols is distinct from 'path_id,user_id' then
    raise exception '0107 refused: v_path_enrollments_expanded has columns (%), not (path_id,user_id).', v_cols;
  end if;

  -- Checks this file re-asserts or keeps: present in their latest earlier form.
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.xp_events'::regclass and c.conname = 'xp_events_rule_check'
      and pg_get_constraintdef(c.oid) like '%''course_passed''%'
  ) then
    raise exception '0107 refused: xp_events_rule_check does not admit ''course_passed'' (apply 0084 first).';
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.notification_templates'::regclass
      and c.conname = 'notification_templates_event_type_check'
      and pg_get_constraintdef(c.oid) like '%''journey_escalation''%'
  ) then
    raise exception '0107 refused: notification_templates_event_type_check does not admit ''journey_escalation'' (apply 0065 first).';
  end if;

  -- The two attempt foreign keys: set null (0034, 0058) or no action (this file).
  for r in
    select * from (values
      ('learning_path_id',      'public.learning_paths',      '0034'),
      ('journey_enrollment_id', 'public.journey_enrollments', '0058')
    ) as t(col, parent, mig)
  loop
    if not exists (
      select 1 from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.conrelid = 'public.course_attempts'::regclass
        and c.confrelid = r.parent::regclass
        and a.attname = r.col
        and c.confdeltype in ('n', 'a')
    ) then
      raise exception '0107 refused: the foreign key course_attempts.% to % is missing (apply % first).', r.col, r.parent, r.mig;
    end if;
  end loop;

  -- Either state: the 0062 open-row index, or this file's.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'course_attempts'
      and indexname in ('course_attempts_one_in_progress_idx', 'course_attempts_one_in_progress_ctx_idx')
  ) then
    raise exception '0107 refused: no open-row index on course_attempts (apply 0062 first).';
  end if;
  -- Either state: the 0083 open-request index, or this file's.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'attempt_requests'
      and indexname in ('attempt_requests_one_open_idx', 'attempt_requests_one_open_ctx_idx')
  ) then
    raise exception '0107 refused: no open-request index on attempt_requests (apply 0083 first).';
  end if;
  -- Either state: unique (enrollment_id, day_number) of 0058, or this file's
  -- unique (enrollment_id, day_id).
  if not exists (
    select 1 from pg_index i
    where i.indrelid = 'public.journey_day_progress'::regclass
      and i.indisunique
      and (select array_agg(a.attname::text order by a.attname::text)
             from pg_attribute a
            where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
          in (array['day_number', 'enrollment_id'], array['day_id', 'enrollment_id'])
  ) then
    raise exception '0107 refused: journey_day_progress has no unique key per (enrolment, day) (apply 0058 first).';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 0b. Before-checks Q1 to Q10 (read-only; ADR 0024 step 4)
-- ---------------------------------------------------------------------------
-- One select, kept in a temporary table for the refusal of section 0c and
-- for the after-checks at the end of the file. The owner's before-check is
-- the same select, run alone (header, BEFORE). It reads only columns that
-- exist before the first paste, so it answers on every paste. Counts only:
-- no row carries an id or a name.
drop table if exists pg_temp.adr0024_0107_before;
create temporary table adr0024_0107_before on commit drop as
with
first_paste as (
  select not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'journey_day_progress' and column_name = 'day_id'
  ) as yes
),
att as (
  select a.id, a.user_id, a.course_version_id, a.status, a.completion_status,
         a.success_status, a.is_preview, a.is_revision, a.launch_mode,
         a.learning_path_id, a.journey_enrollment_id, a.journey_day, v.course_id,
         case when a.is_preview then 'preview'
              when a.journey_enrollment_id is not null then 'journey'
              when a.learning_path_id is not null then 'path'
              else 'individual' end as kind,
         (case when a.learning_path_id is not null then 'P' else '-' end
          || case when a.journey_enrollment_id is not null then 'J' else '-' end
          || case when a.journey_day is not null then 'D' else '-' end) as shape,
         (a.completion_status = 'completed'
          or a.success_status in ('passed', 'failed')
          or a.status in ('completed', 'passed', 'failed')
          or a.score is not null) as has_result
  from public.course_attempts a
  join public.course_versions v on v.id = a.course_version_id
),
prev as (
  select p.*,
         exists (select 1 from public.attempt_requests ar where ar.used_attempt_id = p.id) as used_grant,
         not exists (
           select 1 from att o
           where o.user_id = p.user_id and o.course_id = p.course_id
             and not o.is_preview and not o.is_revision and o.status <> 'abandoned' and o.has_result
         ) as no_other_official_result
  from att p
  where p.is_preview
),
vday as (
  select jv.id as version_id, jv.program_id, jv.days_total,
         case when d.e ->> 'day' ~ '^[0-9]{1,6}$' then (d.e ->> 'day')::int end as day_number,
         lower(nullif(d.e ->> 'course_id', '')) as course_id
  from public.journey_versions jv
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end) as d(e)
),
pin as (
  select e.id as enrollment_id, e.program_id, e.version_id, e.status, jv.days_total
  from public.journey_enrollments e
  join public.journey_versions jv on jv.id = e.version_id
),
pin_day as (
  select p.enrollment_id, vd.day_number, vd.course_id,
         coalesce(vd.day_number between 1 and p.days_total and vd.course_id is not null, false) as required
  from pin p
  join vday vd on vd.version_id = p.version_id
),
credit as (
  select pr.enrollment_id, pr.day_number, lower(pr.course_id::text) as course_id
  from public.journey_day_progress pr
),
open_day as (
  select pd.enrollment_id, min(pd.day_number) as day_number
  from pin_day pd
  where pd.required
    and not exists (select 1 from credit c where c.enrollment_id = pd.enrollment_id and c.day_number = pd.day_number)
  group by pd.enrollment_id
),
furthest as (
  select p.enrollment_id,
         greatest(0,
           coalesce((select max(c.day_number) from credit c where c.enrollment_id = p.enrollment_id), 0),
           coalesce((select max(a.journey_day) from att a
                     where a.journey_enrollment_id = p.enrollment_id and not a.is_preview), 0)) as day_number
  from pin p
),
vs_current as (
  select case
           when jp.current_version_id is null then 'no_current'
           when jp.current_version_id = p.version_id then 'pinned_is_current'
           else coalesce((
             select case when min(g.d) <= f.day_number then 'at_or_below_furthest' else 'above_furthest' end
             from generate_series(1, greatest(p.days_total, cv.days_total)) as g(d)
             where (case when g.d <= p.days_total
                         then coalesce((select max(x.course_id) from pin_day x
                                        where x.enrollment_id = p.enrollment_id and x.day_number = g.d), '')
                         else '#beyond' end)
                   is distinct from
                   (case when g.d <= cv.days_total
                         then coalesce((select max(y.course_id) from vday y
                                        where y.version_id = cv.id and y.day_number = g.d), '')
                         else '#beyond' end)
             having count(*) > 0), 'same_days')
         end as cls
  from pin p
  join public.journey_programs jp on jp.id = p.program_id
  left join public.journey_versions cv on cv.id = jp.current_version_id
  join furthest f on f.enrollment_id = p.enrollment_id
  where p.status = 'active'
),
vs_draft as (
  select case
           when not exists (select 1 from public.journey_days jd where jd.program_id = p.program_id) then 'no_draft_rows'
           else coalesce((
             select case when min(g.d) <= f.day_number then 'at_or_below_furthest' else 'above_furthest' end
             from generate_series(1, greatest(p.days_total, jp.days_total)) as g(d)
             where (case when g.d <= p.days_total
                         then coalesce((select max(x.course_id) from pin_day x
                                        where x.enrollment_id = p.enrollment_id and x.day_number = g.d), '')
                         else '#beyond' end)
                   is distinct from
                   (case when g.d <= jp.days_total
                         then coalesce((select max(lower(jd.course_id::text)) from public.journey_days jd
                                        where jd.program_id = p.program_id and jd.day_number = g.d), '')
                         else '#beyond' end)
             having count(*) > 0), 'same')
         end as cls
  from pin p
  join public.journey_programs jp on jp.id = p.program_id
  join furthest f on f.enrollment_id = p.enrollment_id
  where p.status = 'active'
),
q as (
  -- Q1: by tag shape, and by the context_kind the backfill will write
  select 'Q1.total' as q, count(*) as n, 'course_attempts rows' as note, false as refuses
  from att
  union all
  select 'Q1.kind.' || k.kind, (select count(*) from att a where a.kind = k.kind),
         'rows the backfill labels ' || k.kind, false
  from (values ('individual'), ('path'), ('journey'), ('preview')) as k(kind)
  union all
  select 'Q1.shape.' || a.shape || case when a.is_preview then '.preview' else '' end, count(*),
         'tag shape (P path, J journey enrolment, D journey day)', false
  from att a
  group by a.shape, a.is_preview
  union all
  -- Q2: rows the shape CHECK would refuse (refuse on every paste); two counts
  select v.q, v.n, v.note, v.refuses
  from (select
          count(*) filter (where not is_preview and learning_path_id is not null
                                 and journey_enrollment_id is not null) as both_tags,
          count(*) filter (where not is_preview and journey_enrollment_id is not null
                                 and journey_day is null) as journey_null_day,
          count(*) filter (where not is_preview and journey_day is not null
                                 and journey_enrollment_id is null) as orphan_day,
          count(*) filter (where is_preview and (learning_path_id is not null
                                 or journey_enrollment_id is not null or journey_day is not null)) as preview_tagged,
          count(*) filter (where status = 'abandoned'
                                 and (completion_status = 'completed' or success_status = 'passed')) as abandoned_done
        from att) c
  cross join lateral (values
    ('Q2.both_tags',        c.both_tags,        'not previews with a path and a journey tag', true),
    ('Q2.journey_null_day', c.journey_null_day, 'not previews with a journey tag and a null journey_day', true),
    ('Q2.orphan_day',       c.orphan_day,       'not previews with journey_day and no enrolment', true),
    ('Q2.preview_tagged',   c.preview_tagged,   'previews that carry a tag (kept as legacy_role)', false),
    ('Q2.abandoned_done',   c.abandoned_done,   'abandoned rows that are completed or passed (expected 0)', false)
  ) as v(q, n, note, refuses)
  union all
  -- Q3: open rows per (learner, version)
  select v.q, v.n, v.note, false
  from (select count(*) as open_rows,
               count(distinct (user_id, course_version_id)) as open_pairs
        from att where status = 'in_progress') c
  cross join (select coalesce(max(m.n), 0) as max_per_pair
              from (select count(*) as n from att where status = 'in_progress'
                    group by user_id, course_version_id) m) mx
  cross join lateral (values
    ('Q3.open_rows',    c.open_rows,       'rows with status in_progress'),
    ('Q3.open_pairs',   c.open_pairs,      'distinct (learner, version) among them'),
    ('Q3.max_per_pair', mx.max_per_pair,   'the most open rows on one pair')
  ) as v(q, n, note)
  union all
  select 'Q3.open.' || k.kind, (select count(*) from att a where a.status = 'in_progress' and a.kind = k.kind),
         'open rows the backfill labels ' || k.kind, false
  from (values ('individual'), ('path'), ('journey'), ('preview')) as k(kind)
  union all
  -- Q4: the report matviews as last refreshed
  select v.q, v.n, 'matview sum or row count', false
  from (select coalesce(sum(total_enrolled), 0) as te, coalesce(sum(completed), 0) as co,
               coalesce(sum(in_progress), 0) as ip, coalesce(sum(not_started), 0) as ns
        from public.mv_course_enrollment_status) ce
  cross join (select coalesce(sum(total_enrolled), 0) as te, coalesce(sum(total_completed), 0) as co,
                     coalesce(sum(total_passed), 0) as pa, coalesce(sum(total_failed), 0) as fa
              from public.mv_course_performance) cp
  cross join (select coalesce(sum(total_enrolled), 0) as te, coalesce(sum(completed), 0) as co,
                     coalesce(sum(in_progress), 0) as ip, coalesce(sum(not_started), 0) as ns
              from public.mv_path_enrollment_status) pe
  cross join (select coalesce(sum(total_enrolled), 0) as te, coalesce(sum(total_completed), 0) as co,
                     coalesce(sum(total_passed), 0) as pa, coalesce(sum(total_failed), 0) as fa
              from public.mv_path_performance) pp
  cross join lateral (values
    ('Q4.course_status.total_enrolled', ce.te::bigint),
    ('Q4.course_status.completed',      ce.co::bigint),
    ('Q4.course_status.in_progress',    ce.ip::bigint),
    ('Q4.course_status.not_started',    ce.ns::bigint),
    ('Q4.course_perf.total_enrolled',   cp.te::bigint),
    ('Q4.course_perf.total_completed',  cp.co::bigint),
    ('Q4.course_perf.total_passed',     cp.pa::bigint),
    ('Q4.course_perf.total_failed',     cp.fa::bigint),
    ('Q4.path_status.total_enrolled',   pe.te::bigint),
    ('Q4.path_status.completed',        pe.co::bigint),
    ('Q4.path_status.in_progress',      pe.ip::bigint),
    ('Q4.path_status.not_started',      pe.ns::bigint),
    ('Q4.path_perf.total_enrolled',     pp.te::bigint),
    ('Q4.path_perf.total_completed',    pp.co::bigint),
    ('Q4.path_perf.total_passed',       pp.pa::bigint),
    ('Q4.path_perf.total_failed',       pp.fa::bigint),
    ('Q4.rows.mv_course_interaction_breakdown', (select count(*) from public.mv_course_interaction_breakdown)),
    ('Q4.rows.mv_course_interaction_top_wrong', (select count(*) from public.mv_course_interaction_top_wrong)),
    ('Q4.rows.mv_leaderboard',                  (select count(*) from public.mv_leaderboard)),
    ('Q4.rows.mv_learner_metrics',              (select count(*) from public.mv_learner_metrics))
  ) as v(q, n)
  union all
  -- Q5: the delete rule of the two attempt foreign keys (in note)
  select 'Q5.' || a.attname::text, null::bigint,
         case c.confdeltype when 'a' then 'no action' when 'r' then 'restrict' when 'c' then 'cascade'
                            when 'n' then 'set null' when 'd' then 'set default' end,
         false
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'f'
    and c.conrelid = 'public.course_attempts'::regclass
    and c.confrelid in ('public.learning_paths'::regclass, 'public.journey_enrollments'::regclass)
  union all
  -- Q6: xp_events by rule, and by the kind of the attempt a row points at
  select 'Q6.total', count(*), 'xp_events rows', false from public.xp_events
  union all
  select 'Q6.rule.' || x.rule, count(*), 'xp_events rows with this rule', false
  from public.xp_events x
  group by x.rule
  union all
  select 'Q6.attempt.' || k.kind,
         (select count(*) from public.xp_events x left join att a on a.id = x.attempt_id
          where coalesce(a.kind, 'none') = k.kind),
         'xp_events rows by the kind of their attempt (none = no attempt)', false
  from (values ('none'), ('individual'), ('path'), ('journey'), ('preview')) as k(kind)
  union all
  -- Q7: journey_day_progress by what backs each row
  select 'Q7.' || k.cls,
         (select count(*) from public.journey_day_progress pr
          left join att a on a.id = pr.attempt_id
          where (case when pr.attempt_id is null then 'attempt_null'
                      when a.is_preview then 'preview_row'
                      when a.kind = 'journey' and a.journey_enrollment_id = pr.enrollment_id then 'journey_row'
                      else 'other_row' end) = k.cls),
         k.note, false
  from (values
    ('journey_row',  'credits backed by a journey row of the same enrolment'),
    ('attempt_null', 'credits with no attempt (become legacy_cross_context)'),
    ('preview_row',  'credits backed by a preview row (become legacy_cross_context)'),
    ('other_row',    'credits backed by another row (become legacy_cross_context)')
  ) as k(cls, note)
  union all
  -- Q8: a day identity would be invented (refuse on the first paste only)
  select v.q, v.n, v.note, v.refuses
  from (select
          (select count(*) from vday vd
           where not exists (select 1 from public.journey_days jd
                             where jd.program_id = vd.program_id and jd.day_number = vd.day_number)) as version_days,
          (select count(*) from att a
           join public.journey_enrollments e on e.id = a.journey_enrollment_id
           where not a.is_preview and a.journey_day is not null
             and not exists (select 1 from public.journey_days jd
                             where jd.program_id = e.program_id and jd.day_number = a.journey_day)) as journey_attempts,
          (select count(*) from public.journey_day_progress pr
           join public.journey_enrollments e on e.id = pr.enrollment_id
           where not exists (select 1 from public.journey_days jd
                             where jd.program_id = e.program_id and jd.day_number = pr.day_number)) as progress_rows,
          (select count(*) from att a
           join public.journey_enrollments e on e.id = a.journey_enrollment_id
           where a.is_preview and a.journey_day is not null
             and not exists (select 1 from public.journey_days jd
                             where jd.program_id = e.program_id and jd.day_number = a.journey_day)) as preview_rows,
          (select count(*) from (select version_id, day_number from vday
                                 where day_number is not null
                                 group by version_id, day_number having count(*) > 1) dup) as duplicate_days,
          (select yes from first_paste) as fp) c
  cross join lateral (values
    ('Q8.paste',            null::bigint,
                            case when c.fp
                                 then 'first paste (journey_day_progress.day_id is absent): Q8 refuses'
                                 else 'later paste: Q8 counts only' end, false),
    ('Q8.version_days',     c.version_days,     'version days with no journey_days row for (program, day)', c.fp),
    ('Q8.journey_attempts', c.journey_attempts, 'journey attempts (not previews) with no journey_days row for their day', c.fp),
    ('Q8.progress_rows',    c.progress_rows,    'journey_day_progress rows with no journey_days row for their day', c.fp),
    ('Q8.preview_rows',     c.preview_rows,     'previews with a journey tag and no journey_days row (counted only)', false),
    ('Q8.duplicate_days',   c.duplicate_days,   'day numbers listed twice in one version (counted only)', false)
  ) as v(q, n, note, refuses)
  union all
  -- Q9: drift from earlier publishes to all (counts only)
  select v.q, v.n, v.note, false
  from (select
          (select count(*) from credit c join pin p on p.enrollment_id = c.enrollment_id
           where c.course_id is distinct from
                 (select max(pd.course_id) from pin_day pd
                  where pd.enrollment_id = c.enrollment_id and pd.day_number = c.day_number)) as a,
          (select count(*) from credit c join pin p on p.enrollment_id = c.enrollment_id
           where not exists (select 1 from pin_day pd
                             where pd.enrollment_id = c.enrollment_id and pd.day_number = c.day_number
                               and pd.required)) as b,
          (select count(*) from att a
           left join pin p on p.enrollment_id = a.journey_enrollment_id
           left join open_day od on od.enrollment_id = a.journey_enrollment_id
           where a.kind = 'journey' and a.status = 'in_progress'
             and (p.enrollment_id is null or a.journey_day is distinct from od.day_number)) as c_not_open_day,
          (select count(*) from att a
           left join pin p on p.enrollment_id = a.journey_enrollment_id
           where a.kind = 'journey' and a.status = 'in_progress'
             and (p.enrollment_id is null
                  or lower(a.course_id::text) is distinct from
                     (select max(pd.course_id) from pin_day pd
                      where pd.enrollment_id = a.journey_enrollment_id and pd.day_number = a.journey_day))) as c_other_course,
          (select count(*) from att a
           left join pin p on p.enrollment_id = a.journey_enrollment_id
           left join open_day od on od.enrollment_id = a.journey_enrollment_id
           where a.kind = 'journey' and a.status = 'in_progress'
             and (p.enrollment_id is null
                  or a.journey_day is distinct from od.day_number
                  or lower(a.course_id::text) is distinct from
                     (select max(pd.course_id) from pin_day pd
                      where pd.enrollment_id = a.journey_enrollment_id and pd.day_number = a.journey_day))) as c_either,
          (select count(*) from pin p
           where p.status = 'active'
             and exists (
               select 1 from pin_day r
               where r.enrollment_id = p.enrollment_id and r.required
                 and not exists (select 1 from credit c
                                 where c.enrollment_id = r.enrollment_id and c.day_number = r.day_number)
                 and exists (select 1 from pin_day l
                             join credit c on c.enrollment_id = l.enrollment_id and c.day_number = l.day_number
                             where l.enrollment_id = r.enrollment_id and l.required
                               and l.day_number > r.day_number))) as d
       ) c
  cross join lateral (values
    ('Q9.a',              c.a,              'credits whose course differs from the pinned version''s course on that day'),
    ('Q9.b',              c.b,              'credits on a day that is not a required day of the pinned version'),
    ('Q9.c_not_open_day', c.c_not_open_day, 'in-progress journey attempts not on the open day'),
    ('Q9.c_other_course', c.c_other_course, 'in-progress journey attempts whose pinned day holds another course'),
    ('Q9.c',              c.c_either,       'in-progress journey attempts, either of the two'),
    ('Q9.d',              c.d,              'active enrolments whose credits are not an unbroken run')
  ) as v(q, n, note)
  union all
  select 'Q9.e_current.' || k.cls, (select count(*) from vs_current s where s.cls = k.cls),
         'active enrolments against the current version', false
  from (values ('pinned_is_current'), ('no_current'), ('same_days'),
               ('at_or_below_furthest'), ('above_furthest')) as k(cls)
  union all
  select 'Q9.e_draft.' || k.cls, (select count(*) from vs_draft s where s.cls = k.cls),
         'active enrolments against the draft', false
  from (values ('no_draft_rows'), ('same'), ('at_or_below_furthest'), ('above_furthest')) as k(cls)
  union all
  -- Q10: rows flagged is_preview today (kept as legacy_role)
  select v.q, v.n, v.note, false
  from (select count(*) as rows_,
               count(*) filter (where completion_status = 'completed') as completed,
               count(*) filter (where launch_mode = 'Normal') as normal,
               count(*) filter (where has_result and launch_mode = 'Normal') as result_normal,
               count(*) filter (where has_result and launch_mode = 'Browse') as result_browse,
               count(*) filter (where has_result and launch_mode = 'Review') as result_review,
               count(*) filter (where used_grant) as used_grant,
               count(*) filter (where completion_status = 'completed' and no_other_official_result) as sole_result,
               count(*) filter (where status = 'in_progress') as open_
        from prev) c
  cross join lateral (values
    ('Q10.rows',          c.rows_,         'is_preview rows'),
    ('Q10.completed',     c.completed,     'of them completed'),
    ('Q10.normal',        c.normal,        'of them launch_mode Normal'),
    ('Q10.result_normal', c.result_normal, 'carry a result, launch_mode Normal'),
    ('Q10.result_browse', c.result_browse, 'carry a result, launch_mode Browse'),
    ('Q10.result_review', c.result_review, 'carry a result, launch_mode Review'),
    ('Q10.used_grant',    c.used_grant,    'the target of a used grant'),
    ('Q10.sole_result',   c.sole_result,   'completed, and the person holds no other official result on the course'),
    ('Q10.open',          c.open_,         'still open'),
    ('Q10.xp_events',     (select count(*) from public.xp_events x join prev p on p.id = x.attempt_id),
                          'xp_events rows pointing at one'),
    ('Q10.progress',      (select count(*) from public.journey_day_progress pr join prev p on p.id = pr.attempt_id),
                          'journey_day_progress rows pointing at one'),
    ('Q10.outbox',        (select count(*) from public.lrs_forward_outbox o join prev p on p.id = o.attempt_id),
                          'lrs_forward_outbox rows pointing at one')
  ) as v(q, n, note)
)
select q, n, note, refuses from q
order by q;

-- ---------------------------------------------------------------------------
-- 0c. Refusals: Q2 on every paste, Q8 on the first paste (ADR 0024 step 4)
-- ---------------------------------------------------------------------------
do $$
declare
  v_refused text;
begin
  select string_agg(b.q || ' = ' || b.n, ', ' order by b.q) into v_refused
  from pg_temp.adr0024_0107_before b
  where b.refuses and b.n > 0;
  if v_refused is not null then
    raise exception '0107 refused: %. Nothing changed.', v_refused
      using hint = 'ADR 0024 step 4: Q2 counts rows the context shape check would refuse; '
                || 'Q8 counts journey days with no journey_days row (a day identity would be invented). '
                || 'Run the select of section 0b alone for every count; on staging see step 73.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
