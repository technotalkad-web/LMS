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
-- build holds section 0 (the prerequisites and the before-checks), sections
-- 1 and 2, which are ADR 0024 section B's creation order item 2 whole (the
-- new columns, their run-once backfills, the generated columns, the CHECKs,
-- preview_runs, context_derive_log, the immutability and derive triggers,
-- the two attempt foreign keys re-created on delete no action, the open-row,
-- open-request and journey_day_progress key swaps and the indexes), section
-- 3, which is item 3 whole (learning_path_completions,
-- learning_path_step_completions, completion_notices and preview_purge_log,
-- created empty), section 4, which is item 4 whole (the two context views,
-- the two old-name views as the Individual context, the course enrolment
-- view without its path arm and hold-back, the two terms views and the two
-- path views), and of item 6 only the paste-window day_ids trigger on
-- journey_versions (section 6). Not built yet: item 5, the rest of item 6
-- and item 7; nothing writes the four new tables yet. On this
-- build the old bodies still run and some now fail: the 0089
-- journey_record_completion names the dropped credit key as its conflict
-- target (42P10) and its untagged branch re-tags an attempt (refused by the
-- immutability trigger); the old consume_grant inserts a retake that the
-- derive trigger labels. Do not paste a build of this file that still
-- carries this paragraph.
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
-- Row writes: on the FIRST paste only, the run-once backfills of section 1,
-- each into a column this file adds, never into an existing column
-- (principle 5): course_attempts.context_kind on every row (1a);
-- journey_versions.day_ids and day_ids_source on every version (1c);
-- course_attempts.journey_day_id on journey rows (1e); preview_kind =
-- 'legacy_role' on is_preview rows (1f); side_effects_sig and side_effects_at
-- on completed or passed rows (1j); webhook_skip_reason = 'pre_0107' on such
-- SCORM 1.2 rows with no webhook stamp (1k); revision_visits.context_key
-- where the visit's attempt is not individual (1n); journey_day_progress.day_id
-- on every credit (1q) and credit_kind = 'legacy_cross_context' on the
-- credits Q7 counts so (1s). Existing org_api_keys rows read contract_version
-- 1 from the column default (1t); every other new column takes its default.
-- The one row of context_derive_log, a new table (2a), is created on the
-- first paste; the four tables of section 3 are created empty. A later
-- paste writes no row. The temporary table of section 0b
-- is the session's own and is dropped at commit.
--
-- Locks: ACCESS EXCLUSIVE until commit on course_attempts, attempt_requests,
-- revision_visits, xp_events, journey_days, journey_versions,
-- journey_day_progress, journey_enrollments, journey_programs,
-- course_assignments, learning_path_assignments, learning_path_courses,
-- org_api_keys, org_integration_settings and notification_templates; SHARE
-- ROW EXCLUSIVE until commit on the parents of the foreign keys this file
-- adds or re-creates that are not in that list, learning_paths,
-- organizations, auth.users and courses (writes to them wait, reads do
-- not); ACCESS EXCLUSIVE until commit on the three views section 4
-- replaces, v_course_attempt_scoring, v_course_attempt_summary and
-- v_course_enrollments_expanded (their reads wait, the report matviews'
-- refresh among them). The two stored generated columns of course_attempts
-- and the one of attempt_requests rewrite those tables on the first paste
-- (a rewrite per added generated column; a later paste skips them).
-- lock_timeout 5 s: if a lock is not granted the whole file rolls back.
--
-- PREREQUISITES (the DO block of section 0a refuses to run without them; for
-- every object this file replaces it accepts the earlier state and its own,
-- so the second paste passes):
--   0001  organization_members (the org-wide arms of section 4's terms
--         views)
--   0002  course_versions.manifest_type (the pre_0107 marker of section 1);
--         courses (the step facts' course key, section 3); is_org_admin(uuid)
--         (the select policies of section 3; latest body 0056)
--   0003  course_attempts.completion_status, success_status
--   0005  course_assignments (due_at and assigned_at: the terms views)
--   0007  team_members, course_assignments.team_id (the team arms of the
--         terms views)
--   0008  learning_path_courses.step_number; learning_path_assignments
--         (due_at, assigned_at, team_id: the terms views)
--   0014  notification_templates (the event-type check of 0065, below)
--   0017  learning_paths.is_active
--   0033  learning_paths.visibility
--   0034  course_attempts.learning_path_id with its foreign key;
--         learning_paths.sequence_mode
--   0044  lrs_forward_outbox.attempt_id
--   0052  learning_path_courses.release_at; course_assignments.release_at
--         (the release gates of section 4's course terms view)
--   0053  xp_events, user_badges.period, gamification_settings.timezone,
--         course_attempts.last_activity_at, gamification_close_month(),
--         refresh_gamification_views()
--   0058  the journey tables (programs, days, versions, enrolments,
--         day progress); course_attempts.journey_enrollment_id with its
--         foreign key, and journey_day; gamification_record_activity(uuid)
--         (the wrapper) and journey_record_completion(uuid)
--   0065  journey_programs.deadline_days; the event-type check admits
--         'journey_escalation'
--   0069  course_assignments.group_id, learning_path_assignments.group_id
--         (the Custom Group arms of the terms views)
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
      ('public.organization_members',             '0001'),
      ('public.courses',                          '0002'),
      ('public.course_attempts',                  '0002'),
      ('public.course_assignments',               '0005'),
      ('public.team_members',                     '0007'),
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
      ('course_versions',          'manifest_type',         '0002'),
      ('learning_path_courses',    'step_number',           '0008'),
      ('learning_path_courses',    'release_at',            '0052'),
      ('course_assignments',       'due_at',                '0005'),
      ('course_assignments',       'assigned_at',           '0005'),
      ('course_assignments',       'team_id',               '0007'),
      ('course_assignments',       'release_at',            '0052'),
      ('course_assignments',       'group_id',              '0069'),
      ('learning_path_assignments', 'due_at',              '0008'),
      ('learning_path_assignments', 'assigned_at',         '0008'),
      ('learning_path_assignments', 'team_id',             '0008'),
      ('learning_path_assignments', 'group_id',            '0069'),
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
      ('public.is_org_admin(uuid)',                                            '0002'),
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

-- ---------------------------------------------------------------------------
-- 1. Columns, run-once backfills, generated columns and CHECKs (ADR 0024
--    section B, creation order item 2; steps 5, 7, 8, 79 and 91)
-- ---------------------------------------------------------------------------
-- Everything below section 0c, so a refused paste changes nothing. The order
-- is binding: a backfill or a generated column that reads a column not added
-- yet stops the paste with 42703.
--
-- Backfills run once (step 4). Each backfill runs inside the DO block that
-- adds its column, and only when that block finds the column absent; on a
-- later paste the block does nothing, so a value the new code wrote is never
-- touched again. Plain columns with a constant default and no backfill use
-- `add column if not exists`, which a later paste skips with a notice.
--
-- Generated columns (note N3): every `generated always as (...)` of this file
-- ends in `stored` and casts each uuid with `::text`. On Postgres 17 (staging
-- reads 17.6) a generated column without `stored` is a syntax error, while the
-- rehearsal's Postgres 18 would accept it as a virtual column; the rehearsal's
-- static step checks the rule on the raw file.
--
-- No grant for a new column of an existing table: each table's privileges
-- cover its new columns. The exception is org_api_keys (1t, step 8). The
-- grants and policies of attempt_requests and revision_visits, which step 8
-- restates unchanged, go into the last section with the other restated
-- grants (creation order item 7; a later build).

-- 1a. course_attempts.context_kind (step 5): added nullable, backfilled, then
-- not null. preview first, then the journey tag, then the path tag, else
-- individual: the rule section 0b counted as Q1.kind.*. Rows Q2 refuses
-- never reach this block (section 0c).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_attempts' and column_name = 'context_kind'
  ) then
    alter table public.course_attempts
      add column context_kind text
        constraint course_attempts_context_kind_check
        check (context_kind in ('individual', 'path', 'journey', 'preview'));
    update public.course_attempts
       set context_kind = case
             when is_preview then 'preview'
             when journey_enrollment_id is not null then 'journey'
             when learning_path_id is not null then 'path'
             else 'individual' end;
    alter table public.course_attempts alter column context_kind set not null;
  end if;
end
$$;

comment on column public.course_attempts.context_kind is
  'The product context of the attempt, fixed at insert (ADR 0024): individual, path, journey or preview. Backfilled at 0107 from is_preview and the two tags; never updated.';

-- 1b. journey_days: a removed day is kept without a number (step 91). The
-- unique key (program_id, day_number) of 0058 is unchanged and ignores the
-- nulls; the day_number range check of 0058 admits a null.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'journey_days' and column_name = 'removed_at'
  ) then
    alter table public.journey_days add column removed_at timestamptz;
    alter table public.journey_days alter column day_number drop not null;
    alter table public.journey_days
      add constraint journey_days_removed_no_number_check
      check (removed_at is null or day_number is null);
  end if;
end
$$;

comment on column public.journey_days.removed_at is
  'When the day was removed from the program (ADR 0024 section U): the row is kept, without a number, so attempts and credits that name the day keep their parent.';

-- 1c. journey_versions.day_ids (step 91): {"<day number>": "<day id>"} for
-- every day of the version's days, from journey_days by (program, day
-- number), read with the day-number parse of section 0b. A version with no
-- days gets {} (never null; 0108 sets the column not null). Exact as a
-- reading of history by slot: until the new editor ships, a row's id and its
-- number are the same thing (step 90). Q8 refused the first paste on any
-- version day without a journey_days row, so every day of every version is
-- mapped. days itself is not rewritten (principle 5).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'journey_versions' and column_name = 'day_ids'
  ) then
    alter table public.journey_versions
      add column day_ids jsonb,
      add column day_ids_source text
        constraint journey_versions_day_ids_source_check
        check (day_ids_source in ('slot_backfill', 'editor'));
    update public.journey_versions jv
       set day_ids = coalesce((
             select jsonb_object_agg(x.day_number::text, jd.id::text)
             from (
               select case when d.e ->> 'day' ~ '^[0-9]{1,6}$' then (d.e ->> 'day')::int end as day_number
               from jsonb_array_elements(
                 case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end) as d(e)
             ) x
             join public.journey_days jd
               on jd.program_id = jv.program_id and jd.day_number = x.day_number
           ), '{}'::jsonb),
           day_ids_source = 'slot_backfill';
  end if;
end
$$;

comment on column public.journey_versions.day_ids is
  '{"<day number>": "<journey_days id>"} for every day of the version (ADR 0024 section U): the identity of each day. Backfilled at 0107 by slot; filled by the paste-window trigger for a version the old publish writes; written by the publish from the new editor.';
comment on column public.journey_versions.day_ids_source is
  'slot_backfill = day_ids read from journey_days by (program, day number); editor = written by the new editor''s publish (ADR 0024 steps 91 and 94).';

-- 1d. preview_runs (step 79; decision A31): one row per test run, preview
-- only. Created here because course_attempts.preview_run_id references it.
-- It holds ids, a kind, dates and the activity days a tester marked done
-- (decision A41; empty and unused until phase G): no result. No official
-- reader reads it (step 86). Service role only; no delete is granted to any
-- API role: rows leave through the purge function and the organisation and
-- user cascades.
create table if not exists public.preview_runs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  kind                  text not null check (kind in ('path', 'journey')),
  learning_path_id      uuid references public.learning_paths(id) on delete no action,
  journey_program_id    uuid references public.journey_programs(id) on delete no action,
  journey_version_id    uuid references public.journey_versions(id) on delete no action,
  simulated_date        date,
  created_at            timestamptz not null default now(),
  done_activity_day_ids uuid[] not null default '{}',
  constraint preview_runs_shape_chk check (
    (kind = 'path'
       and learning_path_id is not null
       and journey_program_id is null and journey_version_id is null
       and cardinality(done_activity_day_ids) = 0)
    or (kind = 'journey'
       and learning_path_id is null
       and journey_program_id is not null and journey_version_id is not null))
);

-- Foreign-key indexes (step 7's rule, after 0100:473-480): the organisation
-- and user cascades (the staging CI purge) and a path, program or version
-- delete would otherwise scan the table.
create index if not exists preview_runs_organization_idx
  on public.preview_runs (organization_id);
create index if not exists preview_runs_user_idx
  on public.preview_runs (user_id);
create index if not exists preview_runs_learning_path_idx
  on public.preview_runs (learning_path_id) where learning_path_id is not null;
create index if not exists preview_runs_journey_program_idx
  on public.preview_runs (journey_program_id) where journey_program_id is not null;
create index if not exists preview_runs_journey_version_idx
  on public.preview_runs (journey_version_id) where journey_version_id is not null;

comment on table public.preview_runs is
  'One row per Preview test run of a Learning Path or a Day-wise Journey (ADR 0024 steps 79 and 89): ids, a kind and dates only. Never read by an official reader; deleted only by purge_preview_data and the organisation and user cascades.';
comment on column public.preview_runs.simulated_date is
  'The date the run''s unlock rules read; null = today.';
comment on column public.preview_runs.done_activity_day_ids is
  'The activity days a tester marked done inside a journey run (decision A41); always empty for a path run; unused until phase G.';

alter table public.preview_runs enable row level security;
drop policy if exists "no direct access to preview_runs" on public.preview_runs;
create policy "no direct access to preview_runs" on public.preview_runs
  for all
  using (false)
  with check (false);

-- service_role is named in the revoke (the 0103 form), so a project's default
-- privileges cannot leave it a delete the record does not grant.
revoke all on public.preview_runs from public, anon, authenticated, service_role;
grant select, insert, update on public.preview_runs to service_role;

-- 1e. course_attempts.journey_day_id and journey_version_id (steps 5 and
-- 91). journey_day_id is backfilled once, for journey rows only, with the
-- journey_days id of (the enrolment's program, journey_day): exact, because
-- until the new editor ships a day row's id is tied to its number (step 90).
-- Previews are skipped, so a legacy_role row keeps a null day id (the shape
-- check's legacy_role arm). journey_version_id has no backfill: older rows
-- read null and are judged by the pinned version alone (step 13).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_attempts' and column_name = 'journey_day_id'
  ) then
    alter table public.course_attempts
      add column journey_day_id uuid references public.journey_days(id) on delete no action;
    update public.course_attempts a
       set journey_day_id = jd.id
      from public.journey_enrollments e
      join public.journey_days jd on jd.program_id = e.program_id
     where a.context_kind = 'journey'
       and e.id = a.journey_enrollment_id
       and jd.day_number = a.journey_day;
  end if;
end
$$;

alter table public.course_attempts
  add column if not exists journey_version_id uuid references public.journey_versions(id) on delete no action;

comment on column public.course_attempts.journey_day_id is
  'The journey day the attempt belongs to, by identity (ADR 0024 section U): part of the journey context key. journey_day stays the day''s number at launch, for display.';
comment on column public.course_attempts.journey_version_id is
  'The journey version the enrolment was pinned to when the attempt was launched (ADR 0024 step 5, R14); null on rows from before phase 2 (judged by the pinned version alone).';

-- 1f. course_attempts.preview_kind and preview_run_id (step 79). The rule
-- that ties preview_kind to context_kind is part of the shape check (1h),
-- added after this backfill: written on the column it would fail at once
-- with 23514 on every is_preview row (note N2).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_attempts' and column_name = 'preview_kind'
  ) then
    alter table public.course_attempts
      add column preview_kind text
        constraint course_attempts_preview_kind_check
        check (preview_kind in ('legacy_role', 'course', 'path_run', 'journey_run'));
    update public.course_attempts
       set preview_kind = 'legacy_role'
     where is_preview;
  end if;
end
$$;

alter table public.course_attempts
  add column if not exists preview_run_id uuid references public.preview_runs(id) on delete no action;

comment on column public.course_attempts.preview_kind is
  'Which kind of preview (ADR 0024 step 78): course, path_run, journey_run, or legacy_role (flagged by role before 0107; kept, never purged, step 82). Null outside the preview context.';
comment on column public.course_attempts.preview_run_id is
  'The preview_runs row of a path_run or journey_run preview (ADR 0024 step 79); null otherwise.';

-- 1g. course_attempts.context_key (step 5): the one key of the context. The
-- journey key names the day id (A27); a test run's previews have their own
-- key; a legacy_role row keeps the plain key 'preview' whatever its old tags
-- hold. Not declared not null: the shape check (1h) keeps it non-null.
alter table public.course_attempts
  add column if not exists context_key text
    generated always as (
      case context_kind
        when 'path'    then 'path:' || learning_path_id::text
        when 'journey' then 'journey:' || journey_enrollment_id::text || ':' || journey_day_id::text
        when 'preview' then 'preview' || coalesce(':' || preview_run_id::text, '')
                                      || coalesce(':' || journey_day_id::text, '')
        else context_kind
      end) stored;

comment on column public.course_attempts.context_key is
  'Generated: individual, path:<path id>, journey:<enrolment id>:<day id>, preview, preview:<run id> or preview:<run id>:<day id> (ADR 0024 step 5). Every official rule partitions by it.';

-- 1h. course_attempts_context_shape_chk (steps 5 and 79, note N2). Every
-- term is `is [not] null` or a non-null boolean (is_preview is not null since
-- 0100), so no arm can read null and admit a row: a form such as
-- `preview_kind in (...)` alone would admit a preview with a null kind.
-- Dropped and added on every paste, so a re-paste carries this definition;
-- it cannot fail on a later paste, because the check has held since the
-- first. On the first paste it admits every row but the classes Q2 and Q8
-- refuse (spike 2).
alter table public.course_attempts drop constraint if exists course_attempts_context_shape_chk;
alter table public.course_attempts
  add constraint course_attempts_context_shape_chk check (
    (case context_kind
       when 'individual' then
         learning_path_id is null and journey_enrollment_id is null and journey_day is null
         and journey_day_id is null and not is_preview
       when 'path' then
         learning_path_id is not null and journey_enrollment_id is null and journey_day is null
         and journey_day_id is null and not is_preview
       when 'journey' then
         journey_enrollment_id is not null and journey_day is not null and journey_day_id is not null
         and learning_path_id is null and not is_preview
       when 'preview' then
         is_preview and preview_kind is not null and (
           (preview_kind in ('course', 'path_run', 'journey_run')
              and learning_path_id is null and journey_enrollment_id is null and journey_day is null
              and (preview_run_id is not null) = (preview_kind in ('path_run', 'journey_run'))
              and (journey_day_id is not null) = (preview_kind = 'journey_run'))
           -- legacy_role: the old tags are left as they are (step 6)
           or (preview_kind = 'legacy_role' and preview_run_id is null and journey_day_id is null))
       else false
     end)
    and (context_kind = 'preview' or (preview_kind is null and preview_run_id is null))
    and (context_kind = 'journey' or journey_version_id is null)
    and ((preview_kind is not null) = (context_kind = 'preview'))
  );

-- 1i. course_attempts.settle_sig (step 7): the settled state of the row, which
-- the completion writer compares with side_effects_sig. completion_status and
-- success_status are not null (0003), so only the score needs a coalesce.
alter table public.course_attempts
  add column if not exists settle_sig text
    generated always as (
      completion_status || '|' || success_status || '|' || coalesce(score::text, '')) stored;

comment on column public.course_attempts.settle_sig is
  'Generated: completion_status|success_status|score, the settled state the completion writer compares with side_effects_sig (ADR 0024 step 7).';

-- 1j. side_effects_sig and side_effects_at (step 7): the settled state the
-- completion writer last handled. Backfilled once on every row already
-- completed or passed (the 0103 rule's completed test), so the retry sweep
-- never reaches history. No time is invented: completed_at, else started_at.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_attempts' and column_name = 'side_effects_sig'
  ) then
    alter table public.course_attempts
      add column side_effects_sig text,
      add column side_effects_at  timestamptz;
    update public.course_attempts
       set side_effects_sig = settle_sig,
           side_effects_at  = coalesce(completed_at, started_at)
     where completion_status = 'completed' or success_status = 'passed';
  end if;
end
$$;

comment on column public.course_attempts.side_effects_sig is
  'The settle_sig the completion writer last handled (ADR 0024 step 12); a completed row where it differs from settle_sig is a candidate of the retry sweep. Backfilled at 0107 on every completed row.';
comment on column public.course_attempts.side_effects_at is
  'When the completion writer last handled the row (ADR 0024 step 12); backfilled at 0107 from completed_at, else started_at.';

-- 1k. webhook_skip_reason (step 7, step 31): a terminal marker for rows that
-- will never send a completion webhook. Backfilled once with pre_0107 on
-- every SCORM 1.2 row the 1j backfill stamped (completed or passed) whose
-- completion_webhook_at is null: their message went out inline, unlatched,
-- and without the marker the hold sweep (completion_webhook_at null,
-- webhook_skip_reason null, side_effects_at set) would select them. No send
-- time is invented.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_attempts' and column_name = 'webhook_skip_reason'
  ) then
    alter table public.course_attempts
      add column webhook_skip_reason text
        constraint course_attempts_webhook_skip_reason_check
        check (webhook_skip_reason in ('pre_0107', 'not_official', 'out_of_scope'));
    update public.course_attempts a
       set webhook_skip_reason = 'pre_0107'
      from public.course_versions v
     where v.id = a.course_version_id
       and v.manifest_type = 'scorm12'
       and (a.completion_status = 'completed' or a.success_status = 'passed')
       and a.completion_webhook_at is null;
  end if;
end
$$;

comment on column public.course_attempts.webhook_skip_reason is
  'Why the row will never send a completion webhook (ADR 0024 step 31): pre_0107 (a SCORM 1.2 completion from before 0107, sent inline and unlatched), not_official, out_of_scope. Null = the webhook may still be sent.';

-- 1l. The is_preview comment, restated (step 5; the owner's R6 answer).
comment on column public.course_attempts.is_preview is
  'true = a preview launch; never a learner''s result, and excluded from every official rule (ADR 0024). Which launches are previews is decided by the launch code; preview_kind says which kind.';

-- 1m. attempt_requests: the context of a grant (step 8; section U). Existing
-- rows read individual: no writer could set a context. The same shape check
-- as the attempt's, without the preview arm; a generated context_key with
-- the attempt's journey formula (the day id).
alter table public.attempt_requests
  add column if not exists context_kind text not null default 'individual'
    constraint attempt_requests_context_kind_check
    check (context_kind in ('individual', 'path', 'journey')),
  add column if not exists learning_path_id uuid
    references public.learning_paths(id) on delete no action,
  add column if not exists journey_enrollment_id uuid
    references public.journey_enrollments(id) on delete no action,
  add column if not exists journey_day integer,
  add column if not exists journey_day_id uuid
    references public.journey_days(id) on delete no action;

alter table public.attempt_requests
  add column if not exists context_key text
    generated always as (
      case context_kind
        when 'path'    then 'path:' || learning_path_id::text
        when 'journey' then 'journey:' || journey_enrollment_id::text || ':' || journey_day_id::text
        else context_kind
      end) stored;

alter table public.attempt_requests drop constraint if exists attempt_requests_context_shape_chk;
alter table public.attempt_requests
  add constraint attempt_requests_context_shape_chk check (
    case context_kind
      when 'individual' then
        learning_path_id is null and journey_enrollment_id is null and journey_day is null
        and journey_day_id is null
      when 'path' then
        learning_path_id is not null and journey_enrollment_id is null and journey_day is null
        and journey_day_id is null
      when 'journey' then
        journey_enrollment_id is not null and journey_day is not null and journey_day_id is not null
        and learning_path_id is null
      else false
    end
  );

comment on column public.attempt_requests.context_kind is
  'The product context the grant may be consumed in (ADR 0024 step 8): individual, path or journey. Rows from before 0107 read individual.';
comment on column public.attempt_requests.context_key is
  'Generated: individual, path:<path id> or journey:<enrolment id>:<day id>, the attempt''s formula (ADR 0024 step 8).';

-- 1n. revision_visits.context_key (step 8): backfilled once from the visit's
-- attempt where that row still exists (after course_attempts.context_key, 1g);
-- a visit whose attempt row is gone stays individual (disclosed in the
-- record).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'revision_visits' and column_name = 'context_key'
  ) then
    alter table public.revision_visits
      add column context_key text not null default 'individual';
    update public.revision_visits rv
       set context_key = a.context_key
      from public.course_attempts a
     where a.id = rv.attempt_id
       and rv.context_key is distinct from a.context_key;
  end if;
end
$$;

comment on column public.revision_visits.context_key is
  'The context of the visit (ADR 0024 step 11); backfilled at 0107 from the visit''s attempt, individual when that row is gone.';

-- 1o. xp_events (step 8, section F): nullable context columns and the
-- 0-point event marker. Old rows stay null (the table is append-only,
-- 0053:134-146); xp_events_rule_check (0084) is untouched.
alter table public.xp_events
  add column if not exists context_kind text,
  add column if not exists context_key  text,
  add column if not exists event_only   boolean not null default false;

comment on column public.xp_events.context_key is
  'The context of the attempt the row was written for (ADR 0024 section F); null on rows from before 0107.';
comment on column public.xp_events.event_only is
  'true = a 0-point event row recording a context''s completion (ADR 0024 D8); never adds to a total.';

-- 1p. The pass rule per instance (step 8): null = inherit the course's
-- courses.pass_required. The freeze into journey_versions.days is TypeScript
-- (step 46).
alter table public.learning_path_courses
  add column if not exists pass_required boolean;
alter table public.journey_days
  add column if not exists pass_required boolean;

comment on column public.learning_path_courses.pass_required is
  'The step''s pass rule (ADR 0024 step 8): null = the course''s courses.pass_required.';
comment on column public.journey_days.pass_required is
  'The day''s pass rule in the draft (ADR 0024 step 8): null = the course''s courses.pass_required; frozen into journey_versions.days at publish.';

-- 1q. journey_day_progress.day_id (step 91): backfilled once from (the
-- enrolment's program, day_number), then not null. Q8 refused the first
-- paste on any credit without a journey_days row. day_number stays the
-- number when credited. The foreign key is added in 1s, after the last write
-- to this table: it is deferred (note N1), and a deferred key with checks
-- still pending makes any later alter of the table in this transaction fail
-- with 55006. unique (enrollment_id, day_id) replaces unique (enrollment_id,
-- day_number) later in this file, with the new journey_record_completion
-- (note N5).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'journey_day_progress' and column_name = 'day_id'
  ) then
    alter table public.journey_day_progress add column day_id uuid;
    update public.journey_day_progress pr
       set day_id = jd.id
      from public.journey_enrollments e
      join public.journey_days jd on jd.program_id = e.program_id
     where e.id = pr.enrollment_id
       and jd.day_number = pr.day_number;
    alter table public.journey_day_progress alter column day_id set not null;
  end if;
end
$$;

comment on column public.journey_day_progress.day_id is
  'The credited journey day, by identity (ADR 0024 section U); day_number is the day''s number when credited.';

-- 1r. Recorded enrolments (step 8; D15, D17). Existing rows take the default.
-- No deadline_days column on enrolments (D17).
alter table public.journey_enrollments
  add column if not exists source text not null default 'admin'
    constraint journey_enrollments_source_check
    check (source in ('admin', 'audience', 'self'));
alter table public.journey_programs
  add column if not exists visibility text not null default 'private'
    constraint journey_programs_visibility_check
    check (visibility in ('private', 'org_public'));
alter table public.course_assignments
  add column if not exists source text not null default 'admin'
    constraint course_assignments_source_check
    check (source in ('admin', 'self'));
alter table public.learning_path_assignments
  add column if not exists source text not null default 'admin'
    constraint learning_path_assignments_source_check
    check (source in ('admin', 'self'));

comment on column public.journey_enrollments.source is
  'Who made the enrolment (ADR 0024 step 8): admin, audience (journey_auto_enroll) or self (Start journey).';
comment on column public.journey_programs.visibility is
  'private = enrolment by an admin or an audience; org_public = every member may start it (ADR 0024 step 8), the courses and paths form of 0033.';
comment on column public.course_assignments.source is
  'admin = assigned; self = the learner enrolled themselves (ADR 0024 D15).';
comment on column public.learning_path_assignments.source is
  'admin = assigned; self = the learner enrolled themselves (ADR 0024 D15).';

-- 1s. journey_day_progress: credit_kind, recorded_by, late (step 8), then the
-- deferred day_id key. A credit is backfilled legacy_cross_context once when
-- no journey row of its own enrolment backs it (no attempt, a preview row, or
-- another row): the classes section 0b counts as Q7. Such credits are kept
-- and still count as credited (step 45).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'journey_day_progress' and column_name = 'credit_kind'
  ) then
    alter table public.journey_day_progress
      add column credit_kind text not null default 'attempt'
        constraint journey_day_progress_credit_kind_check
        check (credit_kind in ('attempt', 'legacy_cross_context', 'self', 'admin')),
      add column recorded_by uuid,
      add column late boolean not null default false;
    update public.journey_day_progress pr
       set credit_kind = 'legacy_cross_context'
     where not exists (
       select 1 from public.course_attempts a
       where a.id = pr.attempt_id
         and a.context_kind = 'journey'
         and a.journey_enrollment_id = pr.enrollment_id);
  end if;
end
$$;

comment on column public.journey_day_progress.credit_kind is
  'attempt = credited by a journey attempt of this enrolment; legacy_cross_context = a credit from before 0107 that no such attempt backs (kept, counts); self and admin from phase G (ADR 0024 step 8).';
comment on column public.journey_day_progress.recorded_by is
  'Who recorded a self or admin credit (an id only, no foreign key; ADR 0024 step 8).';
comment on column public.journey_day_progress.late is
  'true = credited after the day''s counted date (ADR 0024 step 13).';

-- The day_id key, deferred (note N1): a program delete reaches a credit in two
-- hops (program, enrolment, credit) and a day in one, so an immediate check
-- could run before the credit's own cascade and refuse the delete. Deferred,
-- the program delete passes, and a lone delete of a credited day is still
-- refused, with 23503, at commit. Added after every write to this table in
-- this file (see 1q); its validation of the existing rows runs here, at once.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.journey_day_progress'::regclass
      and conname = 'journey_day_progress_day_id_fkey'
  ) then
    alter table public.journey_day_progress
      add constraint journey_day_progress_day_id_fkey
      foreign key (day_id) references public.journey_days(id)
      on delete no action deferrable initially deferred;
  end if;
end
$$;

-- 1t. org_api_keys: the CRM contract version (step 8, decision A28). Existing
-- keys read 1 and keys created after the paste read 2: inside the run-once
-- block the column is added with default 1, which labels every existing key
-- 1, and the next statement sets the default to 2. A later paste does not
-- reach the block, so it changes no key.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'org_api_keys' and column_name = 'contract_version'
  ) then
    alter table public.org_api_keys
      add column contract_version smallint not null default 1
        constraint org_api_keys_contract_version_check
        check (contract_version in (1, 2)),
      add column allow_contract_override boolean not null default false;
    alter table public.org_api_keys alter column contract_version set default 2;
  end if;
end
$$;

comment on column public.org_api_keys.contract_version is
  'The CRM answer shape this key receives (ADR 0024 decision A28): 1 for keys from before 0107, 2 for keys created after it. Written by the service role only.';
comment on column public.org_api_keys.allow_contract_override is
  'Whether a request with this key may ask for the other contract version (ADR 0024 step 8). Written by the service role only.';

-- The settings route writes this table with the user's session
-- (app/api/org/api-keys/route.ts), and authenticated holds table-level insert
-- and update from the project defaults (0071 granted nothing). A column-level
-- revoke does nothing while the table-level privilege stands, so the
-- table-level privileges are revoked (which also clears any column grant) and
-- only what the route writes is granted back. Select and delete are
-- untouched; the policy (super owners, 0071) is unchanged.
revoke insert, update on public.org_api_keys from authenticated;
grant insert (organization_id, name, key_prefix, key_hash, is_active, created_by)
  on public.org_api_keys to authenticated;
grant update (is_active) on public.org_api_keys to authenticated;

-- 1u. user_badges.period, its column comment restated (step 8; 0053:227 wrote
-- it as an inline comment).
comment on column public.user_badges.period is
  '''YYYY-MM'' for monthly badges; NULL = lifetime; ''enr:<enrolment id>'' for a journey badge (ADR 0024)';

-- 1v. org_integration_settings.webhook_contexts (steps 8 and 31).
alter table public.org_integration_settings
  add column if not exists webhook_contexts text not null default 'individual'
    constraint org_integration_settings_webhook_contexts_check
    check (webhook_contexts in ('individual', 'all'));

comment on column public.org_integration_settings.webhook_contexts is
  'individual = one course_completed per Individual official completion (the default); all = one per product context (ADR 0024 step 31).';

-- 1w. notification_templates_event_type_check, re-asserted from its latest
-- form (0065:33-52) with journey_completion added (step 8). Widening a check
-- never fails on existing rows.
alter table public.notification_templates
  drop constraint if exists notification_templates_event_type_check;
alter table public.notification_templates
  add constraint notification_templates_event_type_check
    check (event_type in (
      'account_creation',
      'asset_assignment',
      'asset_unassignment',
      'asset_completion',
      'asset_reminder',
      'asset_update',
      'custom_broadcast',
      'path_assignment',
      'path_unassignment',
      'path_completion',
      'password_reset',
      'magic_link',
      'account_invite',
      'journey_nudge',
      'journey_escalation',
      'journey_completion'
    ));

-- ---------------------------------------------------------------------------
-- 2. The paste-window log, the two attempt triggers, the two attempt foreign
--    keys and the indexes (ADR 0024 section B, the end of creation order
--    item 2; steps 7, 8 and 91; notes N1, N5 and N7)
-- ---------------------------------------------------------------------------
-- After every backfill of section 1: the immutability trigger would refuse
-- the context_kind backfill itself, and no row this file writes may reach
-- the derive trigger.
--
-- Errors (note N7). The two triggers here and the day_ids trigger of section
-- 6 raise SQLSTATE P0001 with a fixed short message. No message uses a
-- phrase that the old launch code's schema probes match (isAldsSchemaMissing
-- in lib/alds/flag.ts and isSchemaMissing in lib/scoring/attempt-kind.ts;
-- note N7 lists them), and no error carries a code they match (42703, 42P01,
-- 42883, PGRST20x): a match would make the old launch retry its insert
-- without the ALDS_P4 columns, or log a refusal as a missing schema, and
-- hide it. tests/unit/context-trigger-errors.test.ts reads each message from
-- this file and feeds it to both probes.

-- 2a. context_derive_log (step 7): one row, the evidence of the paste window.
-- The derive trigger (2c) counts every insert that named no context_kind
-- (old launch code on a staging deployment, or an old fixture); 0108 refuses
-- to run while the last firing is less than 24 hours old, and drops the
-- table. A time and a count, nothing about a learner. The row is created
-- once; a later paste leaves it as it is.
create table if not exists public.context_derive_log (
  id            boolean primary key default true check (id),
  last_fired_at timestamptz,
  fired_count   bigint not null default 0
);

comment on table public.context_derive_log is
  'One row: when the paste-window derive trigger on course_attempts last fired, and how many times (ADR 0024 step 7). 0108 reads it before it runs and drops it.';

alter table public.context_derive_log enable row level security;
drop policy if exists "no direct access to context_derive_log" on public.context_derive_log;
create policy "no direct access to context_derive_log" on public.context_derive_log
  for all
  using (false)
  with check (false);

-- service_role is named in the revoke (the 0103 form), so a project's default
-- privileges cannot leave it a delete the record does not grant.
revoke all on public.context_derive_log from public, anon, authenticated, service_role;
grant select, insert, update on public.context_derive_log to service_role;

insert into public.context_derive_log (id) values (true)
on conflict (id) do nothing;

-- 2b. course_attempts_context_immutable (step 7, decision D6): the context of
-- an attempt is fixed at insert, for every role, the service role included.
-- There is no trigger-depth exemption: every foreign key on these columns is
-- on delete no action (1e, 1f, 2d), so no referential action updates one.
-- Before update only: a delete is not stopped (the purge of step 81 and the
-- organisation, user and version cascades). It refuses three writes of the
-- code before phase 2, each on purpose: the launch page's resume re-tag, the
-- untagged-credit re-tag of the 0089 journey_record_completion (its new body
-- in this file has none) and the grant-retake update that writes is_preview
-- for a data_analyst. A write of the same values passes. Security invoker:
-- it reads only the old and the new row.
create or replace function public.course_attempts_context_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (new.context_kind, new.learning_path_id, new.journey_enrollment_id, new.journey_day,
      new.journey_day_id, new.journey_version_id, new.is_preview, new.preview_kind,
      new.preview_run_id)
     is distinct from
     (old.context_kind, old.learning_path_id, old.journey_enrollment_id, old.journey_day,
      old.journey_day_id, old.journey_version_id, old.is_preview, old.preview_kind,
      old.preview_run_id) then
    raise exception 'course_attempts: the context of an attempt is fixed when the attempt is created (ADR 0024)'
      using errcode = 'P0001',
            detail = 'context_kind, learning_path_id, journey_enrollment_id, journey_day, journey_day_id, '
                     || 'journey_version_id, is_preview, preview_kind and preview_run_id never change after insert.';
  end if;
  return new;
end
$$;

revoke execute on function public.course_attempts_context_immutable() from public, anon, authenticated;
grant execute on function public.course_attempts_context_immutable() to service_role;

drop trigger if exists course_attempts_context_immutable on public.course_attempts;
create trigger course_attempts_context_immutable
  before update on public.course_attempts
  for each row execute function public.course_attempts_context_immutable();

-- 2c. course_attempts_context_derive (step 7): for the paste window only;
-- 0108 drops it, its function and context_derive_log. The code before phase
-- 2 inserts attempts that name no context_kind; this trigger labels them by
-- the rule section 1 used on the rows before the paste: preview if
-- is_preview, with preview_kind legacy_role (that code flags previews by
-- role), the old tags kept and no day id; else journey if the journey tag
-- is set, nulling a path tag that arrives with it (a choice made at insert,
-- not a rewrite), with journey_day_id read from the enrolment's pinned
-- version (journey_versions.day_ids of journey_day, step 91), and a refusal
-- when there is none, because the shape check needs the id and a day
-- identity is never invented; else path; else individual. A journey_day_id
-- given with the row is kept. journey_version_id stays null, the legal
-- "pinned version only" value (step 5). The trigger's when clause lets only
-- a row with a null context_kind reach it, so an insert by the new code never
-- fires it and never counts as a firing. Each firing is counted in
-- context_derive_log, which the launching session cannot write: security
-- definer.
create or replace function public.course_attempts_context_derive()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_day_id uuid;
begin
  if new.context_kind is not null then
    return new;
  end if;

  if new.is_preview then
    new.context_kind := 'preview';
    new.preview_kind := 'legacy_role';
  elsif new.journey_enrollment_id is not null then
    new.context_kind := 'journey';
    new.learning_path_id := null;
    if new.journey_day_id is null then
      select (jv.day_ids ->> new.journey_day::text)::uuid
        into v_day_id
        from public.journey_enrollments e
        join public.journey_versions jv on jv.id = e.version_id
       where e.id = new.journey_enrollment_id;
      if v_day_id is null then
        raise exception 'course_attempts: this journey day has no day identity in the enrolment''s pinned version (ADR 0024)'
          using errcode = 'P0001',
                detail = format('journey_enrollment_id %s, journey_day %s',
                                new.journey_enrollment_id, coalesce(new.journey_day::text, 'null'));
      end if;
      new.journey_day_id := v_day_id;
    end if;
  elsif new.learning_path_id is not null then
    new.context_kind := 'path';
  else
    new.context_kind := 'individual';
  end if;

  insert into public.context_derive_log as l (id, last_fired_at, fired_count)
  values (true, now(), 1)
  on conflict (id) do update
    set last_fired_at = excluded.last_fired_at,
        fired_count   = l.fired_count + 1;
  return new;
end
$$;

revoke execute on function public.course_attempts_context_derive() from public, anon, authenticated;
grant execute on function public.course_attempts_context_derive() to service_role;

drop trigger if exists course_attempts_context_derive on public.course_attempts;
create trigger course_attempts_context_derive
  before insert on public.course_attempts
  for each row
  when (new.context_kind is null)
  execute function public.course_attempts_context_derive();

-- 2d. The two attempt foreign keys, re-created on delete no action (step 7;
-- set null today, 0034 and 0058). no action is checked at the end of the
-- statement, so the organisation and user cascades still delete attempts
-- together with their path or enrolment, while a lone delete of a path or of
-- an enrolment that an attempt names fails with 23503 (the path is archived
-- instead). Each key is found by its column and its parent, as section 0a
-- reads it; a key that does not read no action is dropped and re-created
-- under its own name, and a key that already reads no action (a later paste)
-- is left alone. Adding the key checks every row against its parent once.
do $$
declare
  r      record;
  k      record;
  v_name text;
begin
  for r in
    select * from (values
      ('learning_path_id',      'public.learning_paths'),
      ('journey_enrollment_id', 'public.journey_enrollments')
    ) as t(col, parent)
  loop
    v_name := null;
    for k in
      select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.conrelid = 'public.course_attempts'::regclass
        and c.confrelid = r.parent::regclass
        and a.attname = r.col
        and c.confdeltype <> 'a'
    loop
      v_name := coalesce(v_name, k.conname);
      execute format('alter table public.course_attempts drop constraint %I', k.conname);
    end loop;
    if not exists (
      select 1 from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.conrelid = 'public.course_attempts'::regclass
        and c.confrelid = r.parent::regclass
        and a.attname = r.col
    ) then
      execute format(
        'alter table public.course_attempts add constraint %I foreign key (%I) references %s(id) on delete no action',
        coalesce(v_name, 'course_attempts_' || r.col || '_fkey'), r.col, r.parent);
    end if;
  end loop;
end
$$;

-- 2e. The open-row key per context (step 7). One open attempt per (learner,
-- version, context) in place of one per (learner, version) (0062:52-54), so
-- three open rows of one version can coexist in three contexts. The version
-- stays in the key, so language-slot routing keeps working. An open
-- legacy_role row and a new course preview of the same version share the
-- key 'preview', so a Preview launch closes that row before it inserts (note
-- N4). The new key is created before the old one is dropped. 0062, and 0103,
-- which refuses to run without the 0062 index, are never pasted again
-- (header).
create unique index if not exists course_attempts_one_in_progress_ctx_idx
  on public.course_attempts (user_id, course_version_id, context_key)
  where status = 'in_progress';
drop index if exists public.course_attempts_one_in_progress_idx;

-- The context readers (step 7): attempts per learner, version and context;
-- per organisation, context kind and completion time; and per context and
-- learner outside the Individual context.
create index if not exists course_attempts_user_version_ctx_idx
  on public.course_attempts (user_id, course_version_id, context_key);
create index if not exists course_attempts_org_kind_completed_idx
  on public.course_attempts (organization_id, context_kind, completed_at);
create index if not exists course_attempts_ctx_user_idx
  on public.course_attempts (context_key, user_id)
  where context_kind <> 'individual';

-- 2f. The open-request key per context (step 8). At most one open request
-- (pending, or an approved grant not yet used: the 0083 predicate, unchanged)
-- per (learner, course, context), in place of one per (learner, course)
-- (0083:45-47). The new key is created before the old one is dropped. 0083 is
-- never pasted again (header).
create unique index if not exists attempt_requests_one_open_ctx_idx
  on public.attempt_requests (user_id, course_id, context_key)
  where status = 'pending' or (status = 'approved' and used_at is null);
drop index if exists public.attempt_requests_one_open_idx;

-- 2g. The credit key by day identity (step 91): unique (enrollment_id, day_id)
-- in place of unique (enrollment_id, day_number) (0058:173), because after a
-- move two credits of one enrolment can carry the same number at credit time.
-- The new key is created before the old one is dropped; the old one is found
-- by its columns, as a constraint or as a bare unique index. The 0089
-- journey_record_completion still names the old key as its conflict target,
-- which raises 42P10 once the key is gone: this file recreates that function
-- (creation order item 6, note N5), and no statement of the file calls it
-- before then. Every statement on journey_day_progress after its deferred key
-- (1s) is DDL: a row write would queue a deferred check, and the next alter
-- of the table in this transaction would fail with 55006.
do $$
declare
  k record;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.journey_day_progress'::regclass
      and conname = 'journey_day_progress_enrollment_id_day_id_key'
  ) then
    alter table public.journey_day_progress
      add constraint journey_day_progress_enrollment_id_day_id_key unique (enrollment_id, day_id);
  end if;
  for k in
    select ic.relname as index_name, c.conname
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    left join pg_constraint c on c.conindid = i.indexrelid and c.conrelid = i.indrelid
    where i.indrelid = 'public.journey_day_progress'::regclass
      and i.indisunique
      and (select array_agg(a.attname::text order by a.attname::text)
             from pg_attribute a
            where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
          = array['day_number', 'enrollment_id']
  loop
    if k.conname is not null then
      execute format('alter table public.journey_day_progress drop constraint %I', k.conname);
    else
      execute format('drop index public.%I', k.index_name);
    end if;
  end loop;
end
$$;

-- 2h. Foreign-key indexes (step 7's rule, after 0100:473-480): every
-- foreign-key column this file adds leads an index, so a delete of its
-- parent row (a program's cascade, a purged test run, an organisation's or a
-- user's cascade) never scans the child table. Of the twenty (step 7's
-- seventeen and the three of learning_path_step_completions, build note
-- O1-a), these are the seven on the changed tables; five are on preview_runs
-- (1d), and the other eight come with the new tables of section 3. Partial
-- where the column is nullable, plain on journey_day_progress.day_id, which
-- is not null.
create index if not exists course_attempts_journey_version_idx
  on public.course_attempts (journey_version_id) where journey_version_id is not null;
create index if not exists course_attempts_preview_run_idx
  on public.course_attempts (preview_run_id) where preview_run_id is not null;
create index if not exists course_attempts_journey_day_idx
  on public.course_attempts (journey_day_id) where journey_day_id is not null;
create index if not exists attempt_requests_journey_day_idx
  on public.attempt_requests (journey_day_id) where journey_day_id is not null;
create index if not exists attempt_requests_learning_path_idx
  on public.attempt_requests (learning_path_id) where learning_path_id is not null;
create index if not exists attempt_requests_journey_enrollment_idx
  on public.attempt_requests (journey_enrollment_id) where journey_enrollment_id is not null;
create index if not exists journey_day_progress_day_idx
  on public.journey_day_progress (day_id);

-- 2i. xp_events (step 8, section F): a context's points rows per
-- organisation, newest first.
create index if not exists xp_events_org_ctx_created_idx
  on public.xp_events (organization_id, context_key, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. The new tables (ADR 0024 section B, creation order item 3; steps 14, 15
--    and 79; build note O1-a, O1-b and O1-f)
-- ---------------------------------------------------------------------------
-- In the record's order: learning_path_completions,
-- learning_path_step_completions (build note O1-f places it here, after
-- learning_path_completions and before completion_notices),
-- completion_notices, preview_purge_log. preview_runs
-- (1d) and context_derive_log (2a) are item 2's. Each table is created empty
-- (no backfill: note N22 for learning_path_completions, note O1-h (1) for the
-- step facts), with its row-level security, its policy, its grants and its
-- foreign-key indexes in this section; each append-only table's trigger
-- function is created before its trigger. The views and functions that read
-- and write these tables come in sections 4 to 6.
--
-- Grants. Each revoke names service_role as well as public, anon and
-- authenticated (the 0103 form, as for preview_runs and context_derive_log),
-- so that on a project whose default privileges give service_role all, the
-- table holds exactly what the record grants: no API role is granted insert
-- on any of the four, and no delete. The rows are inserted only by this
-- file's security definer functions (the writer of step 12, the journey
-- completion of step 13 and the purge of step 81), as the tables' owner.
--
-- Append-only (learning_path_completions, learning_path_step_completions,
-- preview_purge_log): the xp_events form (0053:134-146). A direct update or
-- delete, for every role including the owner, raises; the organisation, user
-- and (for the step facts) course cascades arrive through the referential
-- trigger, at trigger depth 2, and pass. Each trigger function is plpgsql,
-- security invoker (it reads only its own row), with the pinned search_path
-- and execute for service_role only; its refusal is SQLSTATE P0001 with a
-- fixed short message (the form of note N7).

-- 3a. learning_path_completions (step 14): one row per (path, learner) when
-- every step of the path is done for the learner in path:P, inserted on
-- conflict do nothing by the writer of step 12, which reads done from
-- v_path_step_status. Never undone: a step added later, a rule tightened
-- later or a failed retake leaves it as it is (section L). steps holds the
-- step, course, attempt id and score of each step at completion: ids and
-- scores only.
create or replace function public.learning_path_completions_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception 'learning_path_completions is append-only: a path completion is never changed or removed (ADR 0024)'
    using errcode = 'P0001';
end
$$;

revoke execute on function public.learning_path_completions_append_only() from public, anon, authenticated;
grant execute on function public.learning_path_completions_append_only() to service_role;

create table if not exists public.learning_path_completions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  path_id         uuid not null references public.learning_paths(id) on delete no action,
  user_id         uuid not null references auth.users(id) on delete cascade,
  completed_at    timestamptz not null default now(),
  path_score      numeric,
  steps           jsonb not null default '[]'::jsonb,
  constraint learning_path_completions_path_id_user_id_key unique (path_id, user_id)
);

-- Foreign-key indexes (step 7's rule): path_id is led by the unique key.
create index if not exists learning_path_completions_organization_idx
  on public.learning_path_completions (organization_id);
create index if not exists learning_path_completions_user_idx
  on public.learning_path_completions (user_id);

comment on table public.learning_path_completions is
  'One row per (path, learner): the path was completed in path:P (ADR 0024 step 14). Inserted only by the completion writer; append-only, never undone.';
comment on column public.learning_path_completions.path_score is
  'The path score at completion: the average of the steps'' latest official scores; null when no step is scored.';
comment on column public.learning_path_completions.steps is
  'Each step at completion: step, course, attempt id and score (ids and scores only).';

drop trigger if exists learning_path_completions_no_mutation on public.learning_path_completions;
create trigger learning_path_completions_no_mutation
  before update or delete on public.learning_path_completions
  for each row execute function public.learning_path_completions_append_only();

alter table public.learning_path_completions enable row level security;
-- A learner reads their own rows; an admin reads the organisation's. No
-- insert, update or delete policy. authenticated needs the select:
-- v_path_progress is security_invoker and reads this table.
drop policy if exists "learners and admins read path completions" on public.learning_path_completions;
create policy "learners and admins read path completions" on public.learning_path_completions
  for select using (user_id = auth.uid() or public.is_org_admin(organization_id));

revoke all on public.learning_path_completions from public, anon, authenticated, service_role;
grant select on public.learning_path_completions to authenticated, service_role;

-- 3b. learning_path_step_completions (build note O1-a and O1-b; the owner's
-- O1 answer of 2026-11-13, option (ii)): one row per (path, learner, course)
-- says this step was done, written by the writer of step 12 the first time
-- the step satisfies the rule in force at that moment (on conflict do
-- nothing). A step once done stays done even if an admin later makes it
-- pass-required: v_path_step_status reads passed_ever = passed_by_rule or a
-- row here. attempt_id is an id only (the step's official attempt at the
-- write; no foreign key, because a set null action would be an update of an
-- append-only row); rule_pass_required is the step's resolved rule at the
-- write. No key to learning_path_courses, on purpose: its keys cascade, and
-- a step removed and added again finds its fact. The course key cascades:
-- a course with learner attempts is deleted only where the delete guards let
-- it through (the service role, the organisation's cascade), and its attempts
-- leave with it. The path key refuses, as the attempts' own path key does.
-- Built without the second writer at rule changes (question O3, open).
create or replace function public.learning_path_step_completions_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception 'learning_path_step_completions is append-only: a done path step is never changed or removed (ADR 0024)'
    using errcode = 'P0001';
end
$$;

revoke execute on function public.learning_path_step_completions_append_only() from public, anon, authenticated;
grant execute on function public.learning_path_step_completions_append_only() to service_role;

create table if not exists public.learning_path_step_completions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  path_id            uuid not null references public.learning_paths(id) on delete no action,
  course_id          uuid not null references public.courses(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  attempt_id         uuid,
  rule_pass_required boolean not null,
  done_at            timestamptz not null default now(),
  constraint learning_path_step_completions_path_id_user_id_course_id_key unique (path_id, user_id, course_id)
);

-- Foreign-key indexes (step 7's rule): path_id is led by the unique key.
create index if not exists learning_path_step_completions_organization_idx
  on public.learning_path_step_completions (organization_id);
create index if not exists learning_path_step_completions_user_idx
  on public.learning_path_step_completions (user_id);
create index if not exists learning_path_step_completions_course_idx
  on public.learning_path_step_completions (course_id);

comment on table public.learning_path_step_completions is
  'One row per (path, learner, course): the path step was done under the rule in force when the writer recorded it (ADR 0024 build note O1). Inserted only by the completion writer; append-only.';
comment on column public.learning_path_step_completions.attempt_id is
  'The step''s official attempt when the fact was written: an id only, no foreign key.';
comment on column public.learning_path_step_completions.rule_pass_required is
  'The step''s resolved pass rule when the fact was written.';

drop trigger if exists learning_path_step_completions_no_mutation on public.learning_path_step_completions;
create trigger learning_path_step_completions_no_mutation
  before update or delete on public.learning_path_step_completions
  for each row execute function public.learning_path_step_completions_append_only();

alter table public.learning_path_step_completions enable row level security;
-- The form of learning_path_completions: a learner's own rows or an admin's
-- organisation; no insert, update or delete policy. v_path_step_status is
-- security_invoker and reads this table, so authenticated needs the select.
drop policy if exists "learners and admins read step completions" on public.learning_path_step_completions;
create policy "learners and admins read step completions" on public.learning_path_step_completions
  for select using (user_id = auth.uid() or public.is_org_admin(organization_id));

revoke all on public.learning_path_step_completions from public, anon, authenticated, service_role;
grant select on public.learning_path_step_completions to authenticated, service_role;

-- 3c. completion_notices (step 15; decision D16): the latch that sends each
-- completion message once. The writer of step 12 and the journey completion
-- of step 13 claim by insert ... on conflict do nothing and return a notice
-- only when the insert happened; the routes stamp sent_at on that id. One
-- claim per (learner, product, instance): the course, the path or the
-- journey enrolment. Every key column is not null, because a null in the key
-- would never conflict. origin says who made the claim: the writer on a
-- learner's own completion, or an admin's publish to all enrolled learners.
create table if not exists public.completion_notices (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  product_kind    text not null
                    constraint completion_notices_product_kind_check
                    check (product_kind in ('individual', 'path', 'journey')),
  instance_id     uuid not null,
  attempt_id      uuid references public.course_attempts(id) on delete set null,
  event_type      text not null,
  origin          text not null default 'learner'
                    constraint completion_notices_origin_check
                    check (origin in ('learner', 'publish')),
  claimed_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint completion_notices_user_id_product_kind_instance_id_key unique (user_id, product_kind, instance_id)
);

-- Foreign-key indexes (step 7's rule): user_id is led by the unique key;
-- attempt_id is partial, because every purge and cascade of an attempt sets
-- it null.
create index if not exists completion_notices_organization_idx
  on public.completion_notices (organization_id);
create index if not exists completion_notices_attempt_idx
  on public.completion_notices (attempt_id) where attempt_id is not null;

comment on table public.completion_notices is
  'One claim per (learner, product, instance) for the completion message (ADR 0024 step 15): claimed by the completion writer or the journey publish, stamped sent_at by the route that sends it. Service role only.';
comment on column public.completion_notices.instance_id is
  'The course (individual), the path (path) or the journey enrolment (journey).';
comment on column public.completion_notices.origin is
  'learner = claimed by the completion writer on the learner''s own completion; publish = claimed by an admin''s publish to all enrolled learners.';

alter table public.completion_notices enable row level security;
drop policy if exists "no direct access to completion_notices" on public.completion_notices;
create policy "no direct access to completion_notices" on public.completion_notices
  for all
  using (false)
  with check (false);

revoke all on public.completion_notices from public, anon, authenticated, service_role;
grant select, update on public.completion_notices to service_role;

-- 3d. preview_purge_log (step 79; the owner's audit record of every Preview
-- deletion): who, when, how many. Inserted only by purge_preview_data (step
-- 81), which is started by a named person; there is no scheduled run.
-- actor_user_id is the signed-in admin who confirmed the deletion, with no
-- foreign key, so the row outlives the account. attempt_ids and run_ids are
-- the deleted ids, so an admin can repeat a deletion by hand after a restore
-- (step 97); excluded lists the attempts the call refused to delete, each
-- with the table that points at it. Ids and counts only: no score, no name,
-- no email. Append-only, in the form of learning_path_completions.
create or replace function public.preview_purge_log_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception 'preview_purge_log is append-only: a Preview deletion record is never changed or removed (ADR 0024)'
    using errcode = 'P0001';
end
$$;

revoke execute on function public.preview_purge_log_append_only() from public, anon, authenticated;
grant execute on function public.preview_purge_log_append_only() to service_role;

create table if not exists public.preview_purge_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ran_at          timestamptz not null default now(),
  reason          text not null
                    constraint preview_purge_log_reason_check
                    check (reason in ('manual', 'product_delete')),
  actor_user_id   uuid not null,
  scope           jsonb,
  counts          jsonb not null,
  attempt_ids     uuid[],
  run_ids         uuid[],
  excluded        jsonb
);

-- Foreign-key index (step 7's rule).
create index if not exists preview_purge_log_organization_idx
  on public.preview_purge_log (organization_id);

comment on table public.preview_purge_log is
  'One row per Preview deletion (ADR 0024 steps 79 and 81): who (actor_user_id), when (ran_at), why (reason) and how many (counts), with the deleted ids. Inserted only by purge_preview_data; append-only. Service role only.';
comment on column public.preview_purge_log.actor_user_id is
  'The signed-in admin who confirmed the deletion; an id only, no foreign key, so the record outlives the account.';
comment on column public.preview_purge_log.counts is
  'How many rows the deletion removed: one number per table, the cascaded tables included, and their total.';
comment on column public.preview_purge_log.excluded is
  'The attempts the call refused to delete, each with the table that points at it (ADR 0024 step 81).';

drop trigger if exists preview_purge_log_no_mutation on public.preview_purge_log;
create trigger preview_purge_log_no_mutation
  before update or delete on public.preview_purge_log
  for each row execute function public.preview_purge_log_append_only();

alter table public.preview_purge_log enable row level security;
drop policy if exists "no direct access to preview_purge_log" on public.preview_purge_log;
create policy "no direct access to preview_purge_log" on public.preview_purge_log
  for all
  using (false)
  with check (false);

revoke all on public.preview_purge_log from public, anon, authenticated, service_role;
grant select on public.preview_purge_log to service_role;

-- ---------------------------------------------------------------------------
-- 4. The views (ADR 0024 section B, creation order item 4; steps 9 and 18;
--    build notes N8 to N12 and O1-d)
-- ---------------------------------------------------------------------------
-- In the record's order: v_context_attempt_scoring; v_context_attempt_summary;
-- the two old-name views; v_course_enrollments_expanded; the two terms views;
-- v_path_step_status; v_path_progress. A view binds the relations it reads
-- when it is created, so each comes after everything it reads: the summary
-- after the scoring view, and the two path views last, after the terms view
-- and the two path tables of section 3 (learning_path_completions,
-- learning_path_step_completions).
--
-- create or replace view may only append columns and keeps a view's
-- privileges. The two old-name views and the course enrolment view keep
-- their columns, names, order and types exactly (the six LIVE report
-- matviews and the app read them); the column list of each new view is
-- fixed by this file's first paste. Every view is security_invoker, in the
-- definition and restated by alter view, because a create or replace resets
-- the view options it is not given and, without the option, a learner could
-- read every organisation's rows through the Data API. Grants: the three
-- existing views restate their own (0103:536 and :610; 0105:696-697); each
-- new view's revoke names public, anon, authenticated and service_role, and
-- its grant gives select to authenticated and service_role and nothing else
-- (the form of section 3). authenticated needs the select: the views are
-- read on the learner's session, and the path views read the terms view and
-- the summary on it.
--
-- No view calls instance_pass_required (a learner's read would raise 42501):
-- the path rule resolves pass_required by join,
-- coalesce(learning_path_courses.pass_required, courses.pass_required)
-- (step 9).

-- 4a. v_context_attempt_scoring (step 9 (a), (b); notes N8, N9 and N12): the
-- official attempt per (course, learner, context_key). The 0103 body
-- (0103:430-530) with three changes and nothing else: (a) context_key in
-- every partition, the distinct on, the group key and the join to official,
-- so no row fans out across contexts; (b) the official rule, not a revision
-- row, not a preview, not abandoned, in the completed CTE, where the
-- official attempt is chosen (an abandoned row that is completed was official
-- in the 0103 view and never in computeScoring; note N8); and two appended
-- columns, context_key and passed_in_window (note N12: some row of the
-- scored window passed, so the window logic exists here once and the path
-- view reads it). A granted retake joins the window when an approved grant
-- names it in used_attempt_id, whatever the grant's own context (note N9;
-- the is_retake test of 0103:439-442, unchanged).
create or replace view public.v_context_attempt_scoring with (security_invoker = on) as
with completed as (
  select
    cv.course_id,
    ca.user_id,
    ca.context_key,
    ca.id as attempt_id,
    ca.score,
    ca.success_status,
    -- A consumed admin grant marks this attempt as an official RETAKE (0083).
    exists (
      select 1 from public.attempt_requests ar
       where ar.used_attempt_id = ca.id and ar.status = 'approved'
    ) as is_retake,
    row_number() over (
      partition by cv.course_id, ca.user_id, ca.context_key
      order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id
    ) as attempt_no
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  -- 0103: parenthesised, so a revision row leaves both branches (ADR 0014 step 2)
  where (ca.completion_status = 'completed' or ca.success_status = 'passed') and not ca.is_revision
    -- 0107: the official rule (ADR 0024 step 9 (b), note N8)
    and ca.context_kind <> 'preview' and ca.status <> 'abandoned'
),
ranked as (
  select
    c.*,
    -- Slot among NON-retake completed attempts (the base scored window).
    case when not c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.context_key, c.is_retake order by c.attempt_no)
    end as base_no,
    -- 1 = the NEWEST completed retake (it is THE official result).
    case when c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.context_key, c.is_retake order by c.attempt_no desc)
    end as retake_rank
  from completed c
),
policy as (
  select c.id as course_id, p.max_scored_attempts, p.official_basis, p.official_attempt_number
    from public.courses c
   cross join lateral public.effective_attempt_policy(c.id) p
),
scored as (
  select
    r.*,
    p.max_scored_attempts,
    p.official_basis,
    p.official_attempt_number,
    -- Scored window = first max_scored non-retake attempts + every completed retake.
    (r.is_retake or r.base_no <= p.max_scored_attempts) as in_window,
    bool_or(r.is_retake) over (partition by r.course_id, r.user_id, r.context_key) as has_retake,
    max(r.base_no) filter (where r.base_no <= p.max_scored_attempts)
      over (partition by r.course_id, r.user_id, r.context_key) as last_base_no
  from ranked r
  join policy p on p.course_id = r.course_id
),
official as (
  -- Exactly one row per (course, user, context): the official attempt. The
  -- newest completed retake wins; otherwise the basis rule over the base window.
  select distinct on (s.course_id, s.user_id, s.context_key)
    s.course_id, s.user_id, s.context_key, s.attempt_id, s.score, s.success_status
  from scored s
  where (s.has_retake and s.is_retake and s.retake_rank = 1)
     or (not s.has_retake and not s.is_retake and s.base_no <= s.max_scored_attempts
         and case s.official_basis
               when 'best'   then true
               when 'latest' then s.base_no = s.last_base_no
               when 'nth'    then s.base_no = coalesce(s.official_attempt_number, 1)
               else               s.base_no = 1
             end)
  order by s.course_id, s.user_id, s.context_key,
           -- 'best' keeps every base-window row: highest score first, ties → earliest.
           (case when s.official_basis = 'best' then -coalesce(s.score, -1) else 0 end),
           s.base_no
)
select
  x.course_id,
  x.user_id,
  x.max_scored_attempts,
  x.official_basis,
  x.official_attempt_number,
  (count(*))::integer as completed_attempts,
  (count(*) filter (where x.in_window))::integer as scored_attempts,
  (count(*) filter (where not x.in_window))::integer as practice_attempts,
  max(x.score) filter (where x.attempt_no = 1) as first_score,
  max(x.score) filter (where x.in_window) as best_score,
  -- Newest in the window; a completed retake is always newer than the base
  -- window (mirrors computeScoring's scored = [...baseWindow, ...retakes]).
  (array_agg(x.score order by x.is_retake desc, x.attempt_no desc) filter (where x.in_window))[1] as latest_score,
  max(o.score) as official_score,
  -- New trailing columns (0090). NULL when the policy designates no official
  -- attempt yet (e.g. an 'nth' basis beyond the completed count) — the TS
  -- engine then reports in_progress, never "completed".
  case
    when max(o.attempt_id::text) is null then null
    when max(o.success_status) = 'passed' then 'passed'
    when max(o.success_status) = 'failed' then 'failed'
    else 'completed'
  end as official_status,
  max(o.attempt_id::text)::uuid as official_attempt_id,
  -- 0107: the context, and whether some row of the scored window passed
  -- (note N12; never the summary's ever_passed, which also counts practice
  -- and abandoned rows)
  x.context_key,
  coalesce(bool_or(x.in_window and x.success_status = 'passed'), false) as passed_in_window
from scored x
left join official o on o.course_id = x.course_id and o.user_id = x.user_id and o.context_key = x.context_key
group by x.course_id, x.user_id, x.context_key, x.max_scored_attempts, x.official_basis, x.official_attempt_number;

alter view public.v_context_attempt_scoring set (security_invoker = on);

comment on view public.v_context_attempt_scoring is
  'The official attempt per (course, learner, context_key) (ADR 0024 step 9): the 0103 scoring rules within one context, over rows that are not revision rows, not previews and not abandoned. passed_in_window: some row of the scored window passed.';

revoke all on public.v_context_attempt_scoring from public, anon, authenticated, service_role;
grant select on public.v_context_attempt_scoring to authenticated, service_role;

-- 4b. v_context_attempt_summary (step 9 (a), (c), (d); note N12): one row
-- per (course, learner, context_key). The 0103 body (0103:547-604) with
-- these changes and nothing else: base groups by context_key and filters
-- not a revision row and not a preview only, so it keeps abandoned rows as
-- 0103 does and the 0099 columns keep their meaning (attempt_count,
-- latest_completion and total_time_seconds over every row; the live columns
-- over rows that are not abandoned; 0 or null means only reset attempts);
-- the left join to the scoring view adds context_key; and seven columns are
-- appended: context_kind, context_key, learning_path_id,
-- journey_enrollment_id, journey_day, journey_day_id (step 9 (d)) and
-- passed_in_window (note N12, false when the context has no completed row).
-- official_attempt_id is already column 19. The tags are fixed by
-- context_key for every row base admits (the shape CHECK), so any row's
-- value is the context's; each uuid is read with max(::text)::uuid, as 0103
-- reads official_attempt_id. journey_day is the day's number at launch, for
-- display only: two rows of one day can carry different numbers after a
-- publish moved the day, so the newest row's number is shown (started_at,
-- then id); every per-day reader joins on context_key or journey_day_id.
create or replace view public.v_context_attempt_summary with (security_invoker = on) as
with base as (
  select
    cv.course_id,
    ca.user_id,
    ca.context_key,
    (array_agg(ca.completion_status order by ca.started_at desc))[1] as latest_completion,
    (array_agg(ca.success_status   order by ca.started_at desc))[1] as latest_success,
    coalesce(sum(
      extract(epoch from (ca.completed_at - ca.started_at))
    ) filter (where ca.completed_at is not null), 0) as total_time_seconds,
    count(*) as attempt_count,
    bool_or(ca.completion_status = 'completed' or ca.success_status = 'passed') as ever_completed,
    bool_or(ca.success_status = 'passed') as ever_passed,
    (array_agg(ca.success_status
       order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id)
       filter (where ca.completion_status = 'completed' or ca.success_status = 'passed')
    )[1] = 'passed' as first_completed_passed,
    -- 0099: live attempts only (a reset / force-restart / language-switch
    -- abandoned attempt is not progress).
    count(*) filter (where ca.status <> 'abandoned') as live_attempt_count,
    (array_agg(ca.completion_status order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_completion,
    (array_agg(ca.success_status   order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_success,
    -- 0107: the context's tags (ADR 0024 step 9 (d))
    max(ca.context_kind) as context_kind,
    max(ca.learning_path_id::text)::uuid as learning_path_id,
    max(ca.journey_enrollment_id::text)::uuid as journey_enrollment_id,
    (array_agg(ca.journey_day order by ca.started_at desc, ca.id desc))[1] as journey_day,
    max(ca.journey_day_id::text)::uuid as journey_day_id
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  -- 0103: revision rows are not attempts (ADR 0014 step 2)
  where not ca.is_revision
    -- 0107: previews are no context's attempts (ADR 0024 step 9 (c))
    and ca.context_kind <> 'preview'
  group by cv.course_id, ca.user_id, ca.context_key
)
select
  b.course_id,
  b.user_id,
  b.latest_completion,
  b.latest_success,
  s.best_score,
  b.total_time_seconds,
  b.attempt_count,
  b.ever_completed,
  b.ever_passed,
  s.official_score,
  s.first_score,
  s.latest_score,
  coalesce(s.scored_attempts, 0)   as scored_attempts,
  coalesce(s.practice_attempts, 0) as practice_attempts,
  s.official_basis,
  s.max_scored_attempts,
  coalesce(b.first_completed_passed, false) as first_completed_passed,
  -- Trailing columns (0090): the OFFICIAL verdict; null = no official attempt yet.
  s.official_status,
  s.official_attempt_id,
  -- Trailing columns (0099): live attempts; 0 / null = only reset attempts.
  b.live_attempt_count,
  b.latest_live_completion,
  b.latest_live_success,
  -- Trailing columns (0107): the context, and passed_in_window (note N12)
  b.context_kind,
  b.context_key,
  b.learning_path_id,
  b.journey_enrollment_id,
  b.journey_day,
  b.journey_day_id,
  coalesce(s.passed_in_window, false) as passed_in_window
from base b
left join public.v_context_attempt_scoring s
  on s.course_id = b.course_id and s.user_id = b.user_id and s.context_key = b.context_key;

alter view public.v_context_attempt_summary set (security_invoker = on);

comment on view public.v_context_attempt_summary is
  'One row per (course, learner, context_key) (ADR 0024 step 9): the 0103 summary within one context, over rows that are not revision rows or previews (abandoned rows kept, as in the 0099 columns), with the context''s tags and passed_in_window appended.';

revoke all on public.v_context_attempt_summary from public, anon, authenticated, service_role;
grant select on public.v_context_attempt_summary to authenticated, service_role;

-- 4c. The two old-name views (step 9; decision A8): v_course_attempt_scoring
-- and v_course_attempt_summary keep their names, columns, column order and
-- (course, learner) grain and become the Individual context. The 0103
-- bodies (0103:430-530, :547-604) with one clause each and nothing else:
-- context_kind = 'individual' and status <> 'abandoned' in the scoring
-- view's completed CTE, and context_kind = 'individual' alone in the
-- summary's base CTE (abandoned rows stay there, as in 4b). So the six LIVE
-- report matviews that join the summary on (course, learner) keep one row
-- per learner between this file and 0109 (section K). Option and grants as
-- 0103 states them (0103:532, :536, :606, :610).
create or replace view public.v_course_attempt_scoring with (security_invoker = on) as
with completed as (
  select
    cv.course_id,
    ca.user_id,
    ca.id as attempt_id,
    ca.score,
    ca.success_status,
    -- A consumed admin grant marks this attempt as an official RETAKE (0083).
    exists (
      select 1 from public.attempt_requests ar
       where ar.used_attempt_id = ca.id and ar.status = 'approved'
    ) as is_retake,
    row_number() over (
      partition by cv.course_id, ca.user_id
      order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id
    ) as attempt_no
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  -- 0103: parenthesised, so a revision row leaves both branches (ADR 0014 step 2)
  where (ca.completion_status = 'completed' or ca.success_status = 'passed') and not ca.is_revision
    -- 0107: the Individual context under the official rule (ADR 0024 step 9)
    and ca.context_kind = 'individual' and ca.status <> 'abandoned'
),
ranked as (
  select
    c.*,
    -- Slot among NON-retake completed attempts (the base scored window).
    case when not c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.is_retake order by c.attempt_no)
    end as base_no,
    -- 1 = the NEWEST completed retake (it is THE official result).
    case when c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.is_retake order by c.attempt_no desc)
    end as retake_rank
  from completed c
),
policy as (
  select c.id as course_id, p.max_scored_attempts, p.official_basis, p.official_attempt_number
    from public.courses c
   cross join lateral public.effective_attempt_policy(c.id) p
),
scored as (
  select
    r.*,
    p.max_scored_attempts,
    p.official_basis,
    p.official_attempt_number,
    -- Scored window = first max_scored non-retake attempts + every completed retake.
    (r.is_retake or r.base_no <= p.max_scored_attempts) as in_window,
    bool_or(r.is_retake) over (partition by r.course_id, r.user_id) as has_retake,
    max(r.base_no) filter (where r.base_no <= p.max_scored_attempts)
      over (partition by r.course_id, r.user_id) as last_base_no
  from ranked r
  join policy p on p.course_id = r.course_id
),
official as (
  -- Exactly one row per (course, user): the official attempt. The newest
  -- completed retake wins; otherwise the basis rule over the base window.
  select distinct on (s.course_id, s.user_id)
    s.course_id, s.user_id, s.attempt_id, s.score, s.success_status
  from scored s
  where (s.has_retake and s.is_retake and s.retake_rank = 1)
     or (not s.has_retake and not s.is_retake and s.base_no <= s.max_scored_attempts
         and case s.official_basis
               when 'best'   then true
               when 'latest' then s.base_no = s.last_base_no
               when 'nth'    then s.base_no = coalesce(s.official_attempt_number, 1)
               else               s.base_no = 1
             end)
  order by s.course_id, s.user_id,
           -- 'best' keeps every base-window row: highest score first, ties → earliest.
           (case when s.official_basis = 'best' then -coalesce(s.score, -1) else 0 end),
           s.base_no
)
select
  x.course_id,
  x.user_id,
  x.max_scored_attempts,
  x.official_basis,
  x.official_attempt_number,
  (count(*))::integer as completed_attempts,
  (count(*) filter (where x.in_window))::integer as scored_attempts,
  (count(*) filter (where not x.in_window))::integer as practice_attempts,
  max(x.score) filter (where x.attempt_no = 1) as first_score,
  max(x.score) filter (where x.in_window) as best_score,
  -- Newest in the window; a completed retake is always newer than the base
  -- window (mirrors computeScoring's scored = [...baseWindow, ...retakes]).
  (array_agg(x.score order by x.is_retake desc, x.attempt_no desc) filter (where x.in_window))[1] as latest_score,
  max(o.score) as official_score,
  -- New trailing columns (0090). NULL when the policy designates no official
  -- attempt yet (e.g. an 'nth' basis beyond the completed count) — the TS
  -- engine then reports in_progress, never "completed".
  case
    when max(o.attempt_id::text) is null then null
    when max(o.success_status) = 'passed' then 'passed'
    when max(o.success_status) = 'failed' then 'failed'
    else 'completed'
  end as official_status,
  max(o.attempt_id::text)::uuid as official_attempt_id
from scored x
left join official o on o.course_id = x.course_id and o.user_id = x.user_id
group by x.course_id, x.user_id, x.max_scored_attempts, x.official_basis, x.official_attempt_number;

alter view public.v_course_attempt_scoring set (security_invoker = on);

-- Data API grants (explicit; CREATE OR REPLACE keeps existing privileges, so
-- this is idempotent).
grant select on public.v_course_attempt_scoring to authenticated, service_role;

create or replace view public.v_course_attempt_summary with (security_invoker = on) as
with base as (
  select
    cv.course_id,
    ca.user_id,
    (array_agg(ca.completion_status order by ca.started_at desc))[1] as latest_completion,
    (array_agg(ca.success_status   order by ca.started_at desc))[1] as latest_success,
    coalesce(sum(
      extract(epoch from (ca.completed_at - ca.started_at))
    ) filter (where ca.completed_at is not null), 0) as total_time_seconds,
    count(*) as attempt_count,
    bool_or(ca.completion_status = 'completed' or ca.success_status = 'passed') as ever_completed,
    bool_or(ca.success_status = 'passed') as ever_passed,
    (array_agg(ca.success_status
       order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id)
       filter (where ca.completion_status = 'completed' or ca.success_status = 'passed')
    )[1] = 'passed' as first_completed_passed,
    -- 0099: live attempts only (a reset / force-restart / language-switch
    -- abandoned attempt is not progress).
    count(*) filter (where ca.status <> 'abandoned') as live_attempt_count,
    (array_agg(ca.completion_status order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_completion,
    (array_agg(ca.success_status   order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_success
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  -- 0103: revision rows are not attempts (ADR 0014 step 2)
  where not ca.is_revision
    -- 0107: the Individual context (ADR 0024 step 9); abandoned rows stay
    and ca.context_kind = 'individual'
  group by cv.course_id, ca.user_id
)
select
  b.course_id,
  b.user_id,
  b.latest_completion,
  b.latest_success,
  s.best_score,
  b.total_time_seconds,
  b.attempt_count,
  b.ever_completed,
  b.ever_passed,
  s.official_score,
  s.first_score,
  s.latest_score,
  coalesce(s.scored_attempts, 0)   as scored_attempts,
  coalesce(s.practice_attempts, 0) as practice_attempts,
  s.official_basis,
  s.max_scored_attempts,
  coalesce(b.first_completed_passed, false) as first_completed_passed,
  -- Trailing columns (0090): the OFFICIAL verdict; null = no official attempt yet.
  s.official_status,
  s.official_attempt_id,
  -- Trailing columns (0099): live attempts; 0 / null = only reset attempts.
  b.live_attempt_count,
  b.latest_live_completion,
  b.latest_live_success
from base b
left join public.v_course_attempt_scoring s
  on s.course_id = b.course_id and s.user_id = b.user_id;

alter view public.v_course_attempt_summary set (security_invoker = on);

-- Data API grants (explicit; CREATE OR REPLACE keeps existing privileges, so
-- this is idempotent).
grant select on public.v_course_attempt_summary to authenticated, service_role;

-- 4d. v_course_enrollments_expanded (step 18; decision D2): the four direct
-- arms with their release gates, nothing else. The 0105 body (0105:613-689)
-- without its path arm (0105:656-670, the union and the released steps of
-- assigned paths) and without the hold-back (0105:672-689): a course is
-- enrolled only by a course assignment, and the Learning Path is its own
-- product with its own enrolment and progress (v_path_step_status below). A
-- self-enrolment is a user row, so the view needs no new arm. Same two
-- columns, security_invoker, grants as 0105 (0105:691-697); the comment is
-- restated for the direct arms.
create or replace view public.v_course_enrollments_expanded with (security_invoker = on) as
select
  e.course_id,
  e.user_id
from (
  -- direct user assignments, released
  select
    ca.course_id,
    ca.user_id
  from public.course_assignments ca
  where ca.assignee_type = 'user'
    and ca.user_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- team assignments expanded via team_members, released
  select
    ca.course_id,
    tm.user_id
  from public.course_assignments ca
  join public.team_members tm on tm.team_id = ca.team_id
  where ca.assignee_type = 'team'
    and ca.team_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- org-wide assignments expanded via organization_members, released
  select
    ca.course_id,
    om.user_id
  from public.course_assignments ca
  join public.courses c on c.id = ca.course_id
  join public.organization_members om on om.organization_id = c.organization_id
  where ca.assignee_type = 'org'
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- 0105: Custom Group assignments (0069), released, one call per group
  select
    ca.course_id,
    x.user_id
  from public.course_assignments ca
  cross join lateral public.group_member_ids(ca.group_id) as x
  where ca.assignee_type = 'group'
    and ca.group_id is not null
    and (ca.release_at is null or ca.release_at <= now())
) as e;

alter view public.v_course_enrollments_expanded set (security_invoker = on);

comment on view public.v_course_enrollments_expanded is
  'Learners enrolled on a course as an Individual course (0031; 0105, ADR 0020; ADR 0024 step 18): every released direct assignment (user, team, org-wide, Custom Group); a self-enrolment is a user row. A Learning Path step does not enrol (ADR 0024 decision D2). Distinct (course_id, user_id).';

revoke all on public.v_course_enrollments_expanded from anon;
grant select on public.v_course_enrollments_expanded to authenticated, service_role;

-- 4e. The terms views (step 18; decision A9): one due-date rule for the
-- whole LMS. Per (course or path, learner): due_at is the learner's own
-- (user) row's due_at when the learner has a user row, even a null one, else
-- the earliest due_at among the other assignments that reach the learner;
-- enrolled_at is min(assigned_at) (0005:40, 0008:41). That is the rule of the
-- CRM progress feed and the Report Card (lib/integrations/progress.ts
-- 606-616, lib/manager/insights.ts 325-332), as A9 says, and it is why a
-- self-enrolled learner (a user row with no due date) is never overdue. The
-- assignments that reach a learner are the arms of the two enrolment views,
-- written out again here with the assignment's dates (the enrolment views
-- carry no dates): for a course the four released direct arms of 4d, so the
-- terms view has a row exactly where v_course_enrollments_expanded has one
-- and an unreleased assignment sets no date, as the two readers skip it;
-- for a path the four arms of v_path_enrollments_expanded (0105:545-579;
-- path assignments have no release date). organization_id is the course's
-- or the path's. Both are security_invoker (a learner reads only the
-- assignments RLS shows them; an admin their organisation's).
create or replace view public.v_course_enrollment_terms with (security_invoker = on) as
with reach as (
  -- direct user assignments, released
  select ca.course_id, ca.user_id, ca.assignee_type, ca.due_at, ca.assigned_at
  from public.course_assignments ca
  where ca.assignee_type = 'user'
    and ca.user_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union all
  -- team assignments expanded via team_members, released
  select ca.course_id, tm.user_id, ca.assignee_type, ca.due_at, ca.assigned_at
  from public.course_assignments ca
  join public.team_members tm on tm.team_id = ca.team_id
  where ca.assignee_type = 'team'
    and ca.team_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union all
  -- org-wide assignments expanded via organization_members, released
  select ca.course_id, om.user_id, ca.assignee_type, ca.due_at, ca.assigned_at
  from public.course_assignments ca
  join public.courses c on c.id = ca.course_id
  join public.organization_members om on om.organization_id = c.organization_id
  where ca.assignee_type = 'org'
    and (ca.release_at is null or ca.release_at <= now())
  union all
  -- Custom Group assignments, released, one call per group
  select ca.course_id, x.user_id, ca.assignee_type, ca.due_at, ca.assigned_at
  from public.course_assignments ca
  cross join lateral public.group_member_ids(ca.group_id) as x
  where ca.assignee_type = 'group'
    and ca.group_id is not null
    and (ca.release_at is null or ca.release_at <= now())
)
select
  r.course_id,
  r.user_id,
  c.organization_id,
  case when bool_or(r.assignee_type = 'user')
       then max(r.due_at) filter (where r.assignee_type = 'user')
       else min(r.due_at)
  end as due_at,
  min(r.assigned_at) as enrolled_at
from reach r
join public.courses c on c.id = r.course_id
group by r.course_id, r.user_id, c.organization_id;

alter view public.v_course_enrollment_terms set (security_invoker = on);

comment on view public.v_course_enrollment_terms is
  'Per (course, learner) enrolled by a released direct assignment: due_at (the learner''s own user row''s date when they have one, even null, else the earliest of the others) and enrolled_at (the first assigned_at) (ADR 0024 step 18, decision A9).';

revoke all on public.v_course_enrollment_terms from public, anon, authenticated, service_role;
grant select on public.v_course_enrollment_terms to authenticated, service_role;

create or replace view public.v_path_enrollment_terms with (security_invoker = on) as
with reach as (
  -- direct user assignments
  select pa.path_id, pa.user_id, pa.assignee_type, pa.due_at, pa.assigned_at
  from public.learning_path_assignments pa
  where pa.assignee_type = 'user'
    and pa.user_id is not null
  union all
  -- team assignments
  select pa.path_id, tm.user_id, pa.assignee_type, pa.due_at, pa.assigned_at
  from public.learning_path_assignments pa
  join public.team_members tm on tm.team_id = pa.team_id
  where pa.assignee_type = 'team'
    and pa.team_id is not null
  union all
  -- org-wide assignments
  select pa.path_id, om.user_id, pa.assignee_type, pa.due_at, pa.assigned_at
  from public.learning_path_assignments pa
  join public.learning_paths lp on lp.id = pa.path_id
  join public.organization_members om on om.organization_id = lp.organization_id
  where pa.assignee_type = 'org'
  union all
  -- Custom Group assignments, one call per group
  select pa.path_id, x.user_id, pa.assignee_type, pa.due_at, pa.assigned_at
  from public.learning_path_assignments pa
  cross join lateral public.group_member_ids(pa.group_id) as x
  where pa.assignee_type = 'group'
    and pa.group_id is not null
)
select
  r.path_id,
  r.user_id,
  lp.organization_id,
  case when bool_or(r.assignee_type = 'user')
       then max(r.due_at) filter (where r.assignee_type = 'user')
       else min(r.due_at)
  end as due_at,
  min(r.assigned_at) as enrolled_at
from reach r
join public.learning_paths lp on lp.id = r.path_id
group by r.path_id, r.user_id, lp.organization_id;

alter view public.v_path_enrollment_terms set (security_invoker = on);

comment on view public.v_path_enrollment_terms is
  'Per (path, learner) enrolled by an assignment: due_at (the learner''s own user row''s date when they have one, even null, else the earliest of the others) and enrolled_at (the first assigned_at) (ADR 0024 step 18, decision A9).';

revoke all on public.v_path_enrollment_terms from public, anon, authenticated, service_role;
grant select on public.v_path_enrollment_terms to authenticated, service_role;

-- 4f. v_path_step_status (step 9; steps 44 and 18; notes N10 and N12; the
-- owner's O1 answer, build note O1-d): one row per (path, enrolled learner,
-- step), the one SQL definition of a path step's done. The enrolled
-- learners of v_path_enrollments_expanded times the step list, left-joined
-- to v_context_attempt_summary on the path's own key, 'path:' || path_id,
-- and to the step's stored fact. Columns:
--   pass_required    the resolved rule, by join (step 9): the step's own,
--                    else the course's
--   passed_by_rule   the computed half (note N12): some row of the path
--                    context's scored window satisfies the rule as it stands
--                    now (a passed window row under pass_required; else the
--                    window is not empty)
--   done_recorded_at the done_at of the step's row in
--                    learning_path_step_completions, null when there is none
--   passed_ever      passed_by_rule or a stored fact (O1-d); done = passed_ever
--                    (step 44). A rule relaxed later helps at once; a rule
--                    tightened later leaves a recorded step done.
--   latest_result, latest_score, official_attempt_id   the standing official
--                    result of the path context under today's rule
--                    (official_status, official_score, official_attempt_id);
--                    the fact never changes them
--   retake_live      a row of (course, learner, path:P) in progress, neither
--                    completed nor passed, not a revision row, named in
--                    used_attempt_id by an approved grant of any context
--                    (note N9; the test of consume_grant, 0103:782-797, with
--                    the row's context added)
--   failed           not passed_ever, the standing result failed, and no live
--                    retake (step 44)
--   open_attempt     an official row of the context in progress (in
--                    progress and not a revision row)
-- step_number and release_at come with the step (launch_context reads them
-- here, step 18). Every boolean is non-null. No reader of a path step's done
-- takes it from anywhere else in SQL (O1-k).
create or replace view public.v_path_step_status with (security_invoker = on) as
select
  pe.path_id,
  pe.user_id,
  lpc.course_id,
  lp.organization_id,
  lpc.step_number,
  lpc.release_at,
  r.pass_required,
  (r.passed_by_rule or f.done_at is not null) as passed_ever,
  r.passed_by_rule,
  f.done_at as done_recorded_at,
  s.official_status as latest_result,
  s.official_score as latest_score,
  (r.passed_by_rule or f.done_at is not null) as done,
  s.official_attempt_id,
  coalesce(a.retake_live, false) as retake_live,
  (not (r.passed_by_rule or f.done_at is not null)
   and coalesce(s.official_status = 'failed', false)
   and not coalesce(a.retake_live, false)) as failed,
  coalesce(a.open_attempt, false) as open_attempt
from public.v_path_enrollments_expanded pe
join public.learning_paths lp on lp.id = pe.path_id
join public.learning_path_courses lpc on lpc.path_id = pe.path_id
join public.courses c on c.id = lpc.course_id
left join public.v_context_attempt_summary s
  on s.course_id = lpc.course_id
 and s.user_id = pe.user_id
 and s.context_key = 'path:' || pe.path_id::text
left join public.learning_path_step_completions f
  on f.path_id = pe.path_id
 and f.user_id = pe.user_id
 and f.course_id = lpc.course_id
cross join lateral (
  select
    coalesce(lpc.pass_required, c.pass_required) as pass_required,
    case when coalesce(lpc.pass_required, c.pass_required)
         then coalesce(s.passed_in_window, false)
         else coalesce(s.scored_attempts, 0) > 0
    end as passed_by_rule
) r
cross join lateral (
  select
    bool_or(ca.completion_status is distinct from 'completed'
            and ca.success_status is distinct from 'passed'
            and exists (
              select 1 from public.attempt_requests ar
               where ar.used_attempt_id = ca.id
                 and ar.status = 'approved'
            )) as retake_live,
    bool_or(true) as open_attempt
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  where ca.user_id = pe.user_id
    and cv.course_id = lpc.course_id
    and ca.context_key = 'path:' || pe.path_id::text
    and ca.status = 'in_progress'
    and not ca.is_revision
) a;

alter view public.v_path_step_status set (security_invoker = on);

comment on view public.v_path_step_status is
  'One row per (path, enrolled learner, step) (ADR 0024 steps 9 and 44; build notes N10, N12, O1-d): the step''s resolved pass rule and its done (passed_ever = passed_by_rule or a stored step fact), with the standing official result in path:P, a live granted retake, failed and an open attempt.';

revoke all on public.v_path_step_status from public, anon, authenticated, service_role;
grant select on public.v_path_step_status to authenticated, service_role;

-- 4g. v_path_progress (step 9; notes N11 and N22): one row per (path,
-- enrolled learner), driven by v_path_enrollments_expanded, so a learner on
-- a path with no step still has a row (0 of 0, not completed). Columns:
--   steps_total, steps_done   the steps of the path, and those done
--   next_step, next_course_id the lowest step_number not done and its
--                             course, null when every step is done; release
--                             dates and sequence_mode are applied by the
--                             launch and the page, not here
--   path_score                the mean of the steps' latest official scores
--                             where a step has one; unrounded
--   completed, completed_at   a learning_path_completions row exists, and
--                             its completed_at (never undone, so a path
--                             completed before a step was added reads
--                             completed with steps_done < steps_total)
--   status                    one of four, tested in this order: in_progress
--                             when some current step has a live granted
--                             retake (whether or not the path is completed);
--                             completed; failed when some step is failed;
--                             in_progress when some current step has a live
--                             row in path:P (the summary's live_attempt_count
--                             above 0, the 0099 meaning, so a learner with
--                             reset attempts only reads not started);
--                             not_started
--   due_at, enrolled_at       from v_path_enrollment_terms
--   started_at                the earliest started_at of the path context's
--                             rows that are not revision rows and not
--                             abandoned, on courses that are current steps
--   overdue                   due_at is past and the path is not completed
-- completed, completed_at and overdue do not follow status: while a granted
-- retake is live on a completed path, status reads in_progress and completed
-- reads true. A reader that splits every enrolment once reads status; a
-- reader that asks whether the learner completed the path reads completed.
-- A learner who finished a path before this file has no completion row and
-- reads by the path rule (note N22).
create or replace view public.v_path_progress with (security_invoker = on) as
with steps as (
  select
    st.path_id,
    st.user_id,
    (count(*))::integer as steps_total,
    (count(*) filter (where st.done))::integer as steps_done,
    min(st.step_number) filter (where not st.done) as next_step,
    (array_agg(st.course_id order by st.step_number) filter (where not st.done))[1] as next_course_id,
    avg(st.latest_score) filter (where st.latest_score is not null) as path_score,
    bool_or(st.retake_live) as retake_live,
    bool_or(st.failed) as failed
  from public.v_path_step_status st
  group by st.path_id, st.user_id
),
live as (
  select
    lpc.path_id,
    s.user_id,
    bool_or(s.live_attempt_count > 0) as live
  from public.learning_path_courses lpc
  join public.v_context_attempt_summary s
    on s.course_id = lpc.course_id
   and s.context_key = 'path:' || lpc.path_id::text
  group by lpc.path_id, s.user_id
),
started as (
  select
    lpc.path_id,
    ca.user_id,
    min(ca.started_at) as started_at
  from public.learning_path_courses lpc
  join public.course_versions cv on cv.course_id = lpc.course_id
  join public.course_attempts ca
    on ca.course_version_id = cv.id
   and ca.context_key = 'path:' || lpc.path_id::text
  where not ca.is_revision
    and ca.status <> 'abandoned'
  group by lpc.path_id, ca.user_id
)
select
  pe.path_id,
  pe.user_id,
  lp.organization_id,
  coalesce(st.steps_total, 0) as steps_total,
  coalesce(st.steps_done, 0) as steps_done,
  st.next_step,
  st.next_course_id,
  st.path_score,
  (lc.path_id is not null) as completed,
  case
    when coalesce(st.retake_live, false) then 'in_progress'
    when lc.path_id is not null then 'completed'
    when coalesce(st.failed, false) then 'failed'
    when coalesce(lv.live, false) then 'in_progress'
    else 'not_started'
  end as status,
  t.due_at,
  t.enrolled_at,
  sa.started_at,
  lc.completed_at,
  (t.due_at is not null and t.due_at < now() and lc.path_id is null) as overdue
from public.v_path_enrollments_expanded pe
join public.learning_paths lp on lp.id = pe.path_id
left join steps st
  on st.path_id = pe.path_id and st.user_id = pe.user_id
left join live lv
  on lv.path_id = pe.path_id and lv.user_id = pe.user_id
left join started sa
  on sa.path_id = pe.path_id and sa.user_id = pe.user_id
left join public.learning_path_completions lc
  on lc.path_id = pe.path_id and lc.user_id = pe.user_id
left join public.v_path_enrollment_terms t
  on t.path_id = pe.path_id and t.user_id = pe.user_id;

alter view public.v_path_progress set (security_invoker = on);

comment on view public.v_path_progress is
  'One row per (path, enrolled learner) (ADR 0024 step 9; build note N11): steps done of total, the next step and its course, the path score, completed (a learning_path_completions row), status (in_progress, completed, failed or not_started, in that order of tests), the terms, started_at and overdue.';

revoke all on public.v_path_progress from public, anon, authenticated, service_role;
grant select on public.v_path_progress to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The plpgsql functions (ADR 0024 section B, creation order item 6)
-- ---------------------------------------------------------------------------
-- In any order among themselves: a plpgsql body is parsed when it is created
-- and resolves its objects when it first runs. Sections 3 to 5 (creation
-- order items 3 to 5) come before this one; this build holds sections 3 and
-- 4, and section 5 comes with a later build. This build holds one function of
-- the item, the paste-window trigger function on journey_versions, followed
-- by its trigger.

-- 6a. journey_versions_derive_day_ids (step 91, note N6): for the paste
-- window only; 0108 drops it and sets day_ids not null. The publish before
-- phase 2 writes no day_ids; this trigger fills them as section 1 (1c) filled
-- the versions before the paste: from journey_days by (program, day number),
-- read with the same day-number parse, marked slot_backfill. (i) It fills
-- day_ids only when the insert gives none (its when clause, and the body):
-- a given map, from the phase 2 publish or an editor-sourced fixture, is kept
-- as given. (ii) When an entry of the new row's days has no journey_days row
-- for (program, day number), the predicate of Q8.version_days, it refuses the
-- insert and writes nothing: a day identity is never invented, and leaving
-- the day out would move the failure to the learner's launch, where the
-- derive trigger (2c) refuses. A removed day has no number, so a version
-- never maps one. A version with no days gets {}. The old publish never
-- reaches the refusal, because every day it freezes comes from a
-- journey_days row. Security invoker: every writer of a version (an org
-- admin's session under the insert policy of 0058, or the service role)
-- reads every journey_days row of its own program, and a version that names
-- another organisation's program reads none and is refused.
create or replace function public.journey_versions_derive_day_ids()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_unmapped bigint;
  v_day_ids  jsonb;
begin
  if new.day_ids is not null then
    return new;
  end if;

  select count(*) filter (where jd.id is null),
         coalesce(jsonb_object_agg(x.day_number::text, jd.id::text) filter (where jd.id is not null),
                  '{}'::jsonb)
    into v_unmapped, v_day_ids
    from (
      select case when d.e ->> 'day' ~ '^[0-9]{1,6}$' then (d.e ->> 'day')::int end as day_number
      from jsonb_array_elements(
        case when jsonb_typeof(new.days) = 'array' then new.days else '[]'::jsonb end) as d(e)
    ) x
    left join public.journey_days jd
      on jd.program_id = new.program_id and jd.day_number = x.day_number;

  if v_unmapped > 0 then
    raise exception 'journey_versions: a day of this version has no journey_days row, so it has no day identity (ADR 0024)'
      using errcode = 'P0001',
            detail = format('program_id %s: %s day(s) of the version without a journey_days row',
                            new.program_id, v_unmapped);
  end if;

  new.day_ids := v_day_ids;
  new.day_ids_source := 'slot_backfill';
  return new;
end
$$;

revoke execute on function public.journey_versions_derive_day_ids() from public, anon, authenticated;
grant execute on function public.journey_versions_derive_day_ids() to service_role;

drop trigger if exists journey_versions_derive_day_ids on public.journey_versions;
create trigger journey_versions_derive_day_ids
  before insert on public.journey_versions
  for each row
  when (new.day_ids is null)
  execute function public.journey_versions_derive_day_ids();

notify pgrst, 'reload schema';

commit;
