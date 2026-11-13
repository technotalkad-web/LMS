-- 0107_learning_contexts.sql — one fixed product context on every learner
-- record (Individual course, Learning Path, Day-wise Journey, Preview), the
-- official rule decided once per context, one writer of completion side
-- effects, and the day identity of journeys (ADR 0024 section B, the core of
-- phase 1; accepted 2026-11-13; the phase 1 build notes N1 to N24 in its
-- Notes correct the steps they name). Hand-apply in the SQL editor with the
-- role selector on postgres, staging first; never `supabase db push` (the
-- CLI is linked to production).
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
-- is the session's own and is dropped at commit. The after-checks write
-- nothing they keep: the completion sweep that A6 runs through the two
-- refresh functions, and the refreshes themselves, are rolled back with the
-- block that calls them; every other check reads, or tries a write as an
-- API role that is refused before it touches a row.
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
-- The after-check A6 (section 7b) takes the locks of the two refreshes, an
-- EXCLUSIVE lock on each of the eight matviews as a scheduled refresh does,
-- and releases them when its block rolls back: a scheduled refresh running
-- at the same minute makes A6 wait, and after 5 s the refresh answers an
-- error and the file rolls back (paste again, clear of 03:30 UTC and of the
-- crons' :03 and :07 quarter-hour offsets).
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
--   0004  xapi_statements, xapi_state, cmi5_launch_tokens (the counts of
--         purge_preview_data, section 6)
--   0005  course_assignments (due_at and assigned_at: the terms views;
--         assignee_type: launch_context)
--   0006  profiles (gamification_close_month's snapshots, section 6)
--   0007  team_members, course_assignments.team_id (the team arms of the
--         terms views); teams (gamification_close_month)
--   0008  learning_path_courses.step_number; learning_path_assignments
--         (due_at, assigned_at, team_id: the terms views)
--   0011  organization_members.status (launch_context's member.active),
--         designation, job_role and city (journey_auto_enroll);
--         profiles.first_name and last_name
--   0014  notification_templates (the event-type check of 0065, below)
--   0017  learning_paths.is_active; courses.is_active (launch_context)
--   0027  profiles.email
--   0033  learning_paths.visibility; courses.visibility (launch_context)
--   0034  course_attempts.learning_path_id with its foreign key;
--         learning_paths.sequence_mode
--   0044  lrs_forward_outbox.attempt_id
--   0052  learning_path_courses.release_at; course_assignments.release_at
--         (the release gates of section 4's course terms view)
--   0053  xp_events, user_badges.period and metadata,
--         gamification_settings.timezone, user_gamification,
--         gamification_badges, gamification_level_for(integer, jsonb) (the
--         XP core, section 6), course_attempts.last_activity_at,
--         gamification_close_month(), refresh_gamification_views();
--         gamification_recognitions, xp_events.source_day,
--         user_gamification.opted_out and the streak columns,
--         gamification_settings.enabled and allow_opt_out and
--         profiles.avatar_url (gamification_close_month, section 6)
--   0056  organization_members.business_vertical and branch
--         (journey_auto_enroll)
--   0058  the journey tables (programs, days, versions, enrolments,
--         day progress), journey_enrollments.version_id and
--         journey_day_progress.completed_at (section 5);
--         journey_programs.name (the badge's metadata, section 6);
--         journey_enrollments.start_date, journey_programs.current_version_id
--         and journey_days.course_id and mission_title (section 6);
--         course_attempts.journey_enrollment_id with its foreign key, and
--         journey_day; gamification_record_activity(uuid) (the wrapper) and
--         journey_record_completion(uuid); journey_programs.is_active and
--         auto_enroll_new_users, journey_enrollments.enrolled_by
--         (journey_auto_enroll and launch_context)
--   0063  journey_programs.audience (journey_auto_enroll)
--   0065  journey_programs.deadline_days; the event-type check admits
--         'journey_escalation'
--   0069  course_assignments.group_id, learning_path_assignments.group_id
--         (the Custom Group arms of the terms views)
--   0071  org_api_keys, org_integration_settings
--   0081  courses.pass_required, effective_attempt_policy(uuid)
--   0082  course_attempts.completion_webhook_at
--   0083  attempt_requests (used_attempt_id; decided_at, decision_note,
--         expires_at and used_at, which consume_grant reads in section 6);
--         its open-request index, or this file's
--   0084  gamification_record_activity_core(uuid); xp_events_rule_check
--         admits 'course_passed'
--   0088  journey_programs.unlock_mode, journey_versions.unlock_mode
--   0089  journey_reminder_counts(uuid[]) (either return type: this file
--         drops and creates it with a fourth column)
--   0090  v_course_attempt_summary.official_attempt_id; the report matviews
--   0096  journey_auto_enroll(); journey_audience_matches(jsonb, text,
--         text, text, text, text, text) and
--         organization_members.department (its 0096 body, section 6)
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
--   file's unique (enrollment_id, day_id); and auth.uid() of Supabase's auth
--   schema (the restated policies of section 7a). The after-check A14 reads
--   public.platform_owners (0021) when it exists, and needs it nowhere else.
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
-- this file, at its end (section 7b), against the table of section 0b, and a
-- failed check rolls the whole file back ("0107 after-check failed: ...
-- Nothing changed."). Two counts are reported as notices and never refuse:
-- on a later paste, the completed rows the completion writer has not
-- handled yet (A9; the sweep's candidates); and active enrolments with a
-- credit on every required day that are not completed (A18). A6 calls both
-- refresh functions inside a block it rolls back, so the paste keeps
-- neither the sweep's writes nor the refreshed matviews. The SQL editor may
-- not show a notice, so after the paste run these reads and record them
-- under ADR 0024 (the first runs the refreshes and the sweep for real; the
-- other two only read):
--   R1  select public.refresh_report_views();
--       every entry's error null, the last entry completion_sweep; record
--       the ms of each
--   R2  A9's count (0 on the first paste; on a later paste, the sweep's
--       candidates):
--       select count(*) from public.course_attempts
--        where (completion_status = 'completed' or success_status = 'passed')
--          and side_effects_sig is distinct from settle_sig;
--   R3  A18's count (expected 0; above 0 it goes to the owner):
--       select count(*) from public.journey_credit_state(array(
--         select id from public.journey_enrollments where status = 'active'))
--        where required_days > 0 and next_day is null;

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
      ('public.profiles',                         '0006'),
      ('public.teams',                            '0007'),
      ('public.course_attempts',                  '0002'),
      ('public.xapi_statements',                  '0004'),
      ('public.xapi_state',                       '0004'),
      ('public.cmi5_launch_tokens',               '0004'),
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
      ('public.user_gamification',                '0053'),
      ('public.gamification_badges',              '0053'),
      ('public.gamification_recognitions',        '0053'),
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
      ('courses',                  'is_active',             '0017'),
      ('courses',                  'visibility',            '0033'),
      ('organization_members',     'status',                '0011'),
      ('organization_members',     'designation',           '0011'),
      ('organization_members',     'job_role',              '0011'),
      ('organization_members',     'city',                  '0011'),
      ('organization_members',     'business_vertical',     '0056'),
      ('organization_members',     'branch',                '0056'),
      ('organization_members',     'department',            '0096'),
      ('profiles',                 'first_name',            '0011'),
      ('profiles',                 'last_name',             '0011'),
      ('profiles',                 'email',                 '0027'),
      ('profiles',                 'avatar_url',            '0053'),
      ('course_assignments',       'assignee_type',         '0005'),
      ('xp_events',                'source_day',            '0053'),
      ('user_gamification',        'opted_out',             '0053'),
      ('user_gamification',        'current_streak_days',   '0053'),
      ('user_gamification',        'longest_streak_days',   '0053'),
      ('gamification_settings',    'enabled',               '0053'),
      ('gamification_settings',    'allow_opt_out',         '0053'),
      ('journey_programs',         'is_active',             '0058'),
      ('journey_programs',         'auto_enroll_new_users', '0058'),
      ('journey_programs',         'audience',              '0063'),
      ('journey_enrollments',      'enrolled_by',           '0058'),
      ('learning_paths',           'visibility',            '0033'),
      ('learning_paths',           'sequence_mode',         '0034'),
      ('lrs_forward_outbox',       'attempt_id',            '0044'),
      ('user_badges',              'period',                '0053'),
      ('user_badges',              'metadata',              '0053'),
      ('journey_programs',         'name',                  '0058'),
      ('gamification_settings',    'timezone',              '0053'),
      ('journey_programs',         'deadline_days',         '0065'),
      ('journey_programs',         'unlock_mode',           '0088'),
      ('journey_versions',         'unlock_mode',           '0088'),
      ('journey_versions',         'days',                  '0058'),
      ('journey_versions',         'days_total',            '0058'),
      ('journey_versions',         'count_sundays',         '0058'),
      ('journey_enrollments',      'version_id',            '0058'),
      ('journey_enrollments',      'start_date',            '0058'),
      ('journey_programs',         'current_version_id',    '0058'),
      ('journey_days',             'course_id',             '0058'),
      ('journey_days',             'mission_title',         '0058'),
      ('journey_day_progress',     'completed_at',          '0058'),
      ('attempt_requests',         'decided_at',            '0083'),
      ('attempt_requests',         'decision_note',         '0083'),
      ('attempt_requests',         'expires_at',            '0083'),
      ('attempt_requests',         'used_at',               '0083'),
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
      ('public.gamification_level_for(integer,jsonb)',                         '0053'),
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
      ('public.journey_audience_matches(jsonb,text,text,text,text,text,text)', '0096'),
      ('auth.uid()',                                                           'the Supabase auth schema'),
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
-- grants (creation order item 7, section 7a).

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
-- 5. The language sql functions (ADR 0024 section B, creation order item 5;
--    steps 9 and 13; build note N14)
-- ---------------------------------------------------------------------------
-- In the record's order, each after what it reads: a language sql body is
-- checked against its objects when it is created (42P01 otherwise), so
-- official_attempt_in_context follows the scoring view of section 4 and
-- journey_reminder_counts follows journey_credit_state. Every function is
-- stable, names its relations with their schema and carries set search_path
-- = pg_catalog, public (section B's header). Execute is revoked from public,
-- anon and authenticated and granted to service_role only: no view calls
-- any of them (a learner's read of such a view would raise 42501; the views
-- of section 4 resolve the rule by join), and their callers are the service
-- role and the security definer functions of section 6.
--
-- The four new functions are security invoker; the record does not say.
-- Each caller is either the service role, which bypasses row-level security
-- and holds select on every relation they read (the project defaults on the
-- tables, this file's grant on v_context_attempt_scoring), or a security
-- definer function of section 6, which runs them as its owner.
-- journey_reminder_counts keeps the security definer of its 0089 body.
--
-- The day parse is section 0b's: a days entry's day is a number of one to
-- six digits, else it names no day. A days entry's pass_required counts only
-- as a JSON boolean (null = inherit the course's courses.pass_required, step
-- 8). Where a version lists one day number twice (Q8 counts such versions;
-- staging holds none), the day is one day: it is required once, and its rule
-- is read from its first entry in array order.

-- 5a. official_attempt_in_context (step 9): the official attempt of one
-- (learner, course, context), read from v_context_attempt_scoring, the one
-- definition of the official rule (section 4a); null while the context has
-- none. It replaces the ad-hoc chains of consume_grant,
-- gamification_close_month and the XP ordinal (section 6). Views never call
-- it per row: they join official_attempt_id set-based.
create or replace function public.official_attempt_in_context(p_user uuid, p_course uuid, p_context_key text)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select s.official_attempt_id
    from public.v_context_attempt_scoring s
   where s.user_id = p_user
     and s.course_id = p_course
     and s.context_key = p_context_key;
$$;

comment on function public.official_attempt_in_context(uuid, uuid, text) is
  'The official attempt of one (learner, course, context_key), from v_context_attempt_scoring; null while the context has none (ADR 0024 step 9). Service role only.';

revoke execute on function public.official_attempt_in_context(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.official_attempt_in_context(uuid, uuid, text) to service_role;

-- 5b. instance_pass_required (step 9; twins contract 1.4): the pass rule of
-- one context, in the record's order: for a path key, the step's own
-- learning_path_courses.pass_required; for a journey key, the pass_required
-- of the day in the enrolment's pinned version (the days entry whose
-- day_ids entry is the key's day id); else, and whenever that value is null
-- (inherit) or the step or the day is not found (a course that is no longer
-- a step, a day the pinned version does not hold, an unknown enrolment), the
-- course's courses.pass_required. Individual and preview keys take the
-- course's rule. It never answers null: false for an unknown course (the
-- coalesce of 0089:117 and 0103's consume_grant). The key's ids are read
-- with patterns that yield null on any other form, so no key, however
-- malformed, makes a cast fail. It answers the pinned version's rule only;
-- the lenient rule of R14 is journey_attempt_satisfies (5c). The path arm
-- equals v_path_step_status.pass_required on every step row (the rehearsal
-- asserts it).
create or replace function public.instance_pass_required(p_course uuid, p_context_key text)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with k as (
    select
      substring(p_context_key
        from '^path:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::uuid as path_id,
      substring(p_context_key
        from '^journey:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid as enrollment_id,
      substring(p_context_key
        from '^journey:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::uuid as day_id
  )
  select coalesce(
           -- a path key: the step's own rule
           (select lpc.pass_required
              from public.learning_path_courses lpc
             where lpc.path_id = k.path_id
               and lpc.course_id = p_course),
           -- a journey key: the day's rule in the enrolment's pinned version
           (select case when jsonb_typeof(d.e -> 'pass_required') = 'boolean'
                        then (d.e ->> 'pass_required')::boolean end
              from public.journey_enrollments en
              join public.journey_versions jv on jv.id = en.version_id
              cross join lateral jsonb_array_elements(
                case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end
              ) with ordinality as d(e, ord)
             where en.id = k.enrollment_id
               and (jv.day_ids ->> (case when d.e ->> 'day' ~ '^[0-9]{1,6}$'
                                         then (d.e ->> 'day')::int end)::text)::uuid = k.day_id
             order by d.ord
             limit 1),
           -- else, and whenever neither answers: the course's rule
           (select c.pass_required from public.courses c where c.id = p_course),
           false)
    from k;
$$;

comment on function public.instance_pass_required(uuid, text) is
  'The pass rule of one context (ADR 0024 step 9): the path step''s, else the day''s in the enrolment''s pinned version, else the course''s; never null. Service role only; views resolve the rule by join.';

revoke execute on function public.instance_pass_required(uuid, text) from public, anon, authenticated;
grant execute on function public.instance_pass_required(uuid, text) to service_role;

-- 5c. journey_attempt_satisfies (step 13, R14): whether one attempt's
-- result satisfies a day's pass rule, leniently. True when it satisfies the
-- rule the caller gives, p_target_rule (the resolved pass_required of the
-- attempt's day in the version the caller judges against: the pinned
-- version for journey_record_completion and consume_grant, the target
-- version or the draft for journey_repin_enrollments), or the rule of the
-- attempt's day in the version it was launched under
-- (course_attempts.journey_version_id; the days entry whose day_ids entry is
-- the attempt's journey_day_id, null = the course's courses.pass_required).
-- It reads the launched version and never the target, so it can judge a
-- draft that has no version row. With a null journey_version_id (rows from
-- before phase 2) or a launched version that does not map the day, the
-- target's rule alone judges. A result satisfies a rule as
-- journey_record_completion has credited a day since 0081 (0089:42-51):
-- under pass_required, success_status passed; otherwise completed or passed,
-- so a completed row that failed satisfies a rule that requires no pass. The
-- not-failed term of consume_grant's stands test (0103, its step 7) is that
-- caller's own. It judges the result only: the caller checks the row's
-- context, revision flag and status. It never answers null: false for an
-- unknown or null attempt id; a null p_target_rule is read as pass required
-- (a rule the caller could not resolve never relaxes the test).
create or replace function public.journey_attempt_satisfies(p_attempt_id uuid, p_target_rule boolean)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce((
    select ca.success_status = 'passed'
           or (ca.completion_status = 'completed'
               and (p_target_rule is false or lr.pass_required is false))
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
      left join lateral (
        -- the day's rule in the version the attempt was launched under
        select coalesce(
                 case when jsonb_typeof(d.e -> 'pass_required') = 'boolean'
                      then (d.e ->> 'pass_required')::boolean end,
                 (select c.pass_required from public.courses c where c.id = cv.course_id)) as pass_required
          from public.journey_versions jv
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end
          ) with ordinality as d(e, ord)
         where jv.id = ca.journey_version_id
           and (jv.day_ids ->> (case when d.e ->> 'day' ~ '^[0-9]{1,6}$'
                                     then (d.e ->> 'day')::int end)::text)::uuid = ca.journey_day_id
         order by d.ord
         limit 1
      ) lr on true
     where ca.id = p_attempt_id
  ), false);
$$;

comment on function public.journey_attempt_satisfies(uuid, boolean) is
  'Whether an attempt''s result satisfies the caller''s rule for its day or the day''s rule in the version the attempt was launched under (ADR 0024 step 13, R14); never null. Service role only.';

revoke execute on function public.journey_attempt_satisfies(uuid, boolean) from public, anon, authenticated;
grant execute on function public.journey_attempt_satisfies(uuid, boolean) to service_role;

-- 5d. journey_credit_state (step 13, decision A27, section U; build note
-- N14; twins contract 4.1): the one journey completion rule, by day
-- identity. One row per enrolment of p_ids that exists, whatever its status
-- (a completed enrolment's credits are still read), in enrollment_id order.
-- A required day is a day of the pinned version's days that carries a
-- course (a non-empty course_id) and whose number is between 1 and
-- days_total (0089:131-134); its id is the version's day_ids entry for that
-- number. A credit counts only when its day_id is the id of a required day,
-- whatever its kind (legacy_cross_context included) and whatever its
-- day_number; a credit on a rest day, above days_total or on a day the
-- version does not hold counts towards nothing. credited lists the numbers
-- of the credited required days ascending, credited_day_ids their ids in the
-- same order, credited_days their count; next_day and next_day_id name the
-- lowest-numbered required day with no credit, null when none is left. Zero
-- required days: required_days 0 and next_day null, so the enrolment is
-- never complete (complete = required_days > 0 and next_day is null).
-- resumable_day_ids: the journey_day_id of every open official attempt of
-- the enrolment (context_kind journey, status in_progress, not a revision
-- row), whether or not the day is still in the pinned version, in ascending
-- uuid order (a removed day has no number). Arrays are never null. Every SQL
-- reader of a journey's progress uses it: the completion functions and
-- launch_context (section 6), journey_reminder_counts (5e) and 0109.
create or replace function public.journey_credit_state(p_ids uuid[])
returns table (
  enrollment_id     uuid,
  required_days     integer,
  credited_days     integer,
  credited          integer[],
  credited_day_ids  uuid[],
  next_day          integer,
  next_day_id       uuid,
  resumable_day_ids uuid[]
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with enr as (
    select en.id, en.version_id
      from public.journey_enrollments en
     where en.id = any(p_ids)
  ),
  req as (
    -- the required days of each pinned version, one row per day number
    select distinct
           en.id as enrollment_id,
           x.day_number,
           (jv.day_ids ->> x.day_number::text)::uuid as day_id
      from enr en
      join public.journey_versions jv on jv.id = en.version_id
      cross join lateral (
        select case when d.e ->> 'day' ~ '^[0-9]{1,6}$' then (d.e ->> 'day')::int end as day_number,
               nullif(d.e ->> 'course_id', '') as course_id
          from jsonb_array_elements(
                 case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end) as d(e)
      ) x
     where x.course_id is not null
       and x.day_number between 1 and jv.days_total
  ),
  st as (
    select r.enrollment_id,
           r.day_number,
           r.day_id,
           exists (
             select 1 from public.journey_day_progress p
              where p.enrollment_id = r.enrollment_id
                and p.day_id = r.day_id
           ) as is_credited
      from req r
  )
  select
    en.id,
    count(st.day_number)::integer,
    (count(*) filter (where st.is_credited))::integer,
    coalesce(array_agg(st.day_number order by st.day_number) filter (where st.is_credited), '{}'::integer[]),
    coalesce(array_agg(st.day_id order by st.day_number) filter (where st.is_credited), '{}'::uuid[]),
    (array_agg(st.day_number order by st.day_number) filter (where not st.is_credited))[1],
    (array_agg(st.day_id order by st.day_number) filter (where not st.is_credited))[1],
    coalesce((
      select array_agg(distinct ca.journey_day_id order by ca.journey_day_id)
        from public.course_attempts ca
       where ca.journey_enrollment_id = en.id
         and ca.context_kind = 'journey'
         and ca.status = 'in_progress'
         and not ca.is_revision
         and ca.journey_day_id is not null
    ), '{}'::uuid[])
  from enr en
  left join st on st.enrollment_id = en.id
  group by en.id
  order by en.id;
$$;

comment on function public.journey_credit_state(uuid[]) is
  'The journey completion rule by day identity (ADR 0024 step 13, section U): per enrolment, the required days of the pinned version, the credited ones (numbers ascending, ids parallel), the open day and the resumable day ids. Complete = required_days > 0 and next_day is null. Service role only.';

revoke execute on function public.journey_credit_state(uuid[]) from public, anon, authenticated;
grant execute on function public.journey_credit_state(uuid[]) to service_role;

-- 5e. journey_reminder_counts (step 13): recreated from its latest body,
-- 0089:147-169, grants 0089:171-172. enrollment_id and done_today are as in
-- 0089 (done_today: some credit row of the enrolment is stamped today in the
-- organisation's timezone); done is now journey_credit_state's credited_days,
-- credits by day identity in place of a count of progress rows; a fourth
-- column, credited, the numbers of the credited days, which the nudges cron
-- passes to the TypeScript twin. The old cron code reads the three columns
-- it knows. A new output column changes the return type, which create or
-- replace refuses (42P13), so the function is dropped and created on every
-- paste; the drop resets its privileges, which are restated below. Security
-- definer as in 0089; the search_path is pinned (section B's header).
drop function if exists public.journey_reminder_counts(uuid[]);

create function public.journey_reminder_counts(p_ids uuid[])
returns table (enrollment_id uuid, done integer, done_today boolean, credited integer[])
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.id as enrollment_id,
         cs.credited_days as done,
         coalesce(
           bool_or(
             p.completed_at is not null
             and (p.completed_at at time zone coalesce(gs.timezone, 'Asia/Kolkata'))::date
                 = (now() at time zone coalesce(gs.timezone, 'Asia/Kolkata'))::date
           ),
           false
         ) as done_today,
         cs.credited
    from public.journey_enrollments e
    left join public.gamification_settings gs on gs.organization_id = e.organization_id
    left join public.journey_day_progress p on p.enrollment_id = e.id
    join public.journey_credit_state(p_ids) cs on cs.enrollment_id = e.id
   where e.id = any(p_ids)
   group by e.id, cs.credited_days, cs.credited;
$$;

revoke all on function public.journey_reminder_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.journey_reminder_counts(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The plpgsql functions (ADR 0024 section B, creation order item 6)
-- ---------------------------------------------------------------------------
-- In any order among themselves: a plpgsql body is parsed when it is created
-- and resolves its objects when it first runs. Sections 3 to 5 (creation
-- order items 3 to 5) come before this one. Every function states security
-- definer or security invoker and set search_path = pg_catalog, public, and
-- names its relations with their schema: a create or replace that leaves
-- either out resets it while a trigger stays bound (note N5, spike 6). The
-- item, whole: the paste-window trigger function on journey_versions with
-- its trigger (6a), the two delete guards (6b), both forms of
-- record_revision_visit (6c), both forms of consume_grant (6d),
-- journey_save_days (6e), journey_repin_enrollments (6f), the journey
-- completion core with its two wrappers (6g), journey_record_completion
-- (6h), the XP core with its wrapper (6i), record_learning_activity (6j),
-- sweep_completion_side_effects (6k), purge_preview_data (6l), the two
-- refresh functions (6m), gamification_close_month (6n),
-- journey_auto_enroll (6o) and, last, launch_context (6p). Lock
-- order, in every function of this section that takes more than one: an
-- attempt_requests row, then journey_enrollments rows (in id order), then
-- course_attempts rows; no function locks an attempt row before an
-- enrolment.

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

-- 6b. The two delete guards (step 7; note N5; row L2, answered no): recreated
-- by create or replace from their latest bodies (0100:511-576, grants
-- 0100:578-581), so the two triggers of 0098:249-257 stay bound and are not
-- recreated. One clause changes in each: the count's `and not a.is_preview`
-- becomes `and (not a.is_preview or a.preview_kind = 'legacy_role')`, so the
-- guards count every attempt that is not a preview of one of the three new
-- kinds: every learner attempt, as before, and every row flagged as a
-- preview by role, which section 1 (1f) labelled legacy_role and which is
-- never deleted (step 82). The clause is written in that form on purpose:
-- preview_kind is null on every official row, so a test such as
-- `preview_kind not in (...)` would read null there and stop counting
-- learner attempts. The hint gains ADR 0024. Everything else is kept as it
-- is: security definer, the pinned search_path, the claim read with its
-- nullif, the return at once for the service role (so the e2e purge, the
-- lifecycle cleanup and the upload rollbacks still delete by-role rows with
-- everything else), the exception name learner_history_exists (the routes
-- match on that text), the detail text, and the revoke and grant. 0098 and
-- 0100 are never pasted again (header).
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
    and (not a.is_preview or a.preview_kind = 'legacy_role');
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'course_versions %s holds %s learner attempt(s). Deactivate the package or make another version current instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10; is_preview since 0100; rows flagged by role counted since ADR 0024).';
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
    and (not a.is_preview or a.preview_kind = 'legacy_role');
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'courses %s holds %s learner attempt(s). Deactivate the course instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10; is_preview since 0100; rows flagged by role counted since ADR 0024).';
  end if;
  return old;
end
$$;

revoke execute on function public.guard_learner_history_course_versions() from public, anon, authenticated;
grant execute on function public.guard_learner_history_course_versions() to service_role;
revoke execute on function public.guard_learner_history_courses() from public, anon, authenticated;
grant execute on function public.guard_learner_history_courses() to service_role;

-- 6c. record_revision_visit (step 11). The seven-argument form adds
-- p_context_key text with no default (a default would make the six-name call
-- ambiguous for PostgREST): the 0103 body (0103:656-683, grants
-- 0103:685-686) with its advisory lock and 10-second dedupe keyed (learner,
-- course, context) in place of (learner, course), and the visit row's
-- context_key written. The six-argument form keeps its signature and becomes
-- a wrapper passing 'individual': the launch code before phase 2 labels
-- every visit Individual, path and journey visits included, and for those
-- callers the dedupe answers as before. Both keep security definer; the
-- search_path is pinned (0103 set it to public alone). Grants restated on
-- both. 0103 is never pasted again (header).
create or replace function public.record_revision_visit(
  p_org uuid,
  p_user uuid,
  p_course uuid,
  p_version uuid,
  p_attempt uuid,
  p_kind text,
  p_context_key text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_course::text || ':' || p_context_key));
  if exists (
    select 1 from public.revision_visits v
     where v.user_id = p_user and v.course_id = p_course and v.context_key = p_context_key
       and v.launched_at > now() - interval '10 seconds'
  ) then
    return false;
  end if;
  insert into public.revision_visits
    (organization_id, user_id, course_id, course_version_id, attempt_id, launch_kind, context_key)
  values (p_org, p_user, p_course, p_version, p_attempt, p_kind, p_context_key);
  return true;
end;
$$;

comment on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text, text) is
  'One revision visit row, deduplicated over 10 seconds per (learner, course, context_key) (ADR 0024 step 11). Service role only.';

revoke execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text, text) to service_role;

create or replace function public.record_revision_visit(
  p_org uuid,
  p_user uuid,
  p_course uuid,
  p_version uuid,
  p_attempt uuid,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return public.record_revision_visit(p_org, p_user, p_course, p_version, p_attempt, p_kind, 'individual');
end;
$$;

revoke execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text) to service_role;

-- 6d. consume_grant (step 10; note N9): an approved grant consumed in one
-- transaction, in one context. The nine-argument form adds p_journey_day_id
-- uuid with no default (a default would make the eight-name call ambiguous
-- for PostgREST); its body is the 0103 body (0103:721-905, grants
-- 0103:907-908) with these changes and nothing else:
--   - the context is computed from the three tags with the derive trigger's
--     precedence (journey when p_journey_enrollment_id is given, the path
--     tag then ignored; else path; else individual); the journey key names
--     the day id, so a journey call whose day id is null has no key;
--   - the grant lock matches that context as well (0103 matched id,
--     learner, course and status): a grant of another context, a journey
--     call with no day id, and a day id that differs from the grant's
--     journey_day_id (it is part of the key) answer unavailable with
--     nothing written; the grant's own context_key is read only here (N9);
--   - for a journey context the enrolment row is locked after the grant, and
--     the version it is pinned to is read from that locked row; the retake
--     records it (journey_version_id) with the day id (A27);
--   - retake_live, the official result, stands and the abandon read attempt
--     rows of this context only (context_key); the live-retake test is on
--     the retake row's own context, and the grant that names it may be of
--     any context (N9);
--   - the current official result is official_attempt_in_context (section
--     5a, the one official rule), in place of 0103's chain query;
--   - stands reads instance_pass_required (section 5b) in place of
--     courses.pass_required; for a journey row it is the lenient rule of
--     step 13: journey_attempt_satisfies (section 5c) with the pinned
--     version's rule, and not failed;
--   - the insert names context_kind and the tags that kind admits (0108
--     removes the derive trigger), so a tag the context does not use is
--     never written.
-- Outcomes, in this order, under the grant row's lock: unavailable; (22023)
-- version, course or organisation mismatch, raised; used; expired;
-- retake_live; stale; stands; opened, as in 0103 (comment at 0103:690-719).
-- Lock order in both forms: the grant, then the enrolment, then
-- course_attempts rows. journey_record_completion and the re-pin lock the
-- enrolment and no grant, so no cycle exists. A preview never reaches either
-- form (step 37). 0103 is never pasted again (header).
create or replace function public.consume_grant(
  p_grant_id uuid,
  p_user_id uuid,
  p_course_id uuid,
  p_version_id uuid,
  p_org_id uuid,
  p_learning_path_id uuid,
  p_journey_enrollment_id uuid,
  p_journey_day integer,
  p_journey_day_id uuid
)
returns table (outcome text, attempt_id uuid, abandoned_ids uuid[])
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_grant         public.attempt_requests%rowtype;
  v_kind          text;
  v_key           text;
  v_pinned        uuid;
  v_pass_required boolean;
  v_has_official  boolean;
  v_off_id        uuid;
  v_off_completed timestamptz;
  v_off_started   timestamptz;
  v_off_success   text;
  v_off_when      text;
  v_abandoned     uuid[];
  v_new           uuid;
begin
  -- 0. the context the three tags name (the derive trigger's precedence); a
  -- journey key with no day id is null and matches no grant
  v_kind := case when p_journey_enrollment_id is not null then 'journey'
                 when p_learning_path_id is not null then 'path'
                 else 'individual' end;
  v_key := case v_kind
             when 'journey' then 'journey:' || p_journey_enrollment_id::text || ':' || p_journey_day_id::text
             when 'path'    then 'path:' || p_learning_path_id::text
             else 'individual'
           end;

  -- 1. the grant row, locked, in this context
  select ar.* into v_grant
    from public.attempt_requests ar
   where ar.id = p_grant_id
     and ar.user_id = p_user_id
     and ar.course_id = p_course_id
     and ar.status = 'approved'
     and ar.context_key = v_key
     for update;
  if not found then
    return query select 'unavailable'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 2. consistency (beyond the ADR; ADR 0014 addendum note)
  if v_grant.organization_id is distinct from p_org_id
     or not exists (
       select 1 from public.course_versions cv
        where cv.id = p_version_id and cv.course_id = p_course_id
     ) then
    raise exception 'consume_grant: version, course or organisation mismatch'
      using errcode = '22023';
  end if;

  -- 2b. a journey context: the enrolment row, locked after the grant, and
  -- the version it is pinned to
  if v_kind = 'journey' then
    select e.version_id into v_pinned
      from public.journey_enrollments e
     where e.id = p_journey_enrollment_id
       for update;
  end if;

  -- 3. used, expired
  if v_grant.used_at is not null then
    return query select 'used'::text, null::uuid, '{}'::uuid[];
    return;
  end if;
  if v_grant.expires_at is not null and v_grant.expires_at < now() then
    return query select 'expired'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 4. retake_live (in this context: the retake row's own context_key)
  if exists (
    select 1
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
     where ca.user_id = p_user_id
       and cv.course_id = p_course_id
       and ca.context_key = v_key
       and ca.status = 'in_progress'
       and ca.completion_status is distinct from 'completed'
       and ca.success_status is distinct from 'passed'
       and not ca.is_revision
       and exists (
         select 1 from public.attempt_requests ar2
          where ar2.used_attempt_id = ca.id
            and ar2.status = 'approved'
            and ar2.id <> p_grant_id
       )
  ) then
    return query select 'retake_live'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 5. the current official result in this context (the official rule of
  -- section 4a, through official_attempt_in_context) and its pass rule
  v_pass_required := public.instance_pass_required(p_course_id, v_key);

  v_off_id := public.official_attempt_in_context(p_user_id, p_course_id, v_key);
  select ca.completed_at, ca.started_at, ca.success_status
    into v_off_completed, v_off_started, v_off_success
    from public.course_attempts ca
   where ca.id = v_off_id;
  v_has_official := found;
  -- the date the two note suffixes name (started_at is not null, so this is
  -- never null and the suffix never empties an existing note)
  v_off_when := to_char(coalesce(v_off_completed, v_off_started) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';

  -- 6. stale (a null decided_at is never stale)
  if v_has_official
     and v_grant.decided_at is not null
     and v_off_completed is not null
     and v_grant.decided_at < v_off_completed then
    update public.attempt_requests ar
       set status = 'expired',
           decision_note = coalesce(ar.decision_note || ' ', '')
             || 'expired unused: decided before the learner''s current official result of '
             || v_off_when
     where ar.id = p_grant_id;
    return query select 'stale'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 7. stands (the SQL twin of officialDone and officialStatus <> 'failed');
  -- a journey row by the lenient rule of step 13 (R14)
  if v_has_official
     and (case when v_kind = 'journey'
               then public.journey_attempt_satisfies(v_off_id, v_pass_required)
                    and v_off_success is distinct from 'failed'
               else v_off_success = 'passed'
                    or (v_off_success is distinct from 'failed' and not v_pass_required)
          end)
     and not v_grant.override_confirmed then
    update public.attempt_requests ar
       set status = 'expired',
           decision_note = coalesce(ar.decision_note || ' ', '')
             || 'expired unused: the learner''s official result of '
             || v_off_when
             || ' stands and this grant carries no post-pass confirmation'
     where ar.id = p_grant_id;
    return query select 'stands'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 8. opened: abandon (in this context), insert, stamp (a plain update ...
  -- returning into would raise on more than one row)
  with ab as (
    update public.course_attempts ca
       set status = 'abandoned'
     where ca.user_id = p_user_id
       and ca.context_key = v_key
       and ca.status = 'in_progress'
       and ca.course_version_id in (
         select cv.id from public.course_versions cv where cv.course_id = p_course_id
       )
    returning ca.id
  )
  select coalesce(array_agg(ab.id), '{}'::uuid[]) into v_abandoned from ab;

  insert into public.course_attempts as ca
    (course_version_id, user_id, organization_id, status, cmi_data, is_revision, context_kind,
     learning_path_id, journey_enrollment_id, journey_day, journey_day_id, journey_version_id)
  values
    (p_version_id, p_user_id, p_org_id, 'in_progress', '{}'::jsonb, false, v_kind,
     case when v_kind = 'path' then p_learning_path_id end,
     case when v_kind = 'journey' then p_journey_enrollment_id end,
     case when v_kind = 'journey' then p_journey_day end,
     case when v_kind = 'journey' then p_journey_day_id end,
     case when v_kind = 'journey' then v_pinned end)
  returning ca.id into v_new;

  update public.attempt_requests ar
     set used_at = now(),
         used_attempt_id = v_new
   where ar.id = p_grant_id
     and ar.used_at is null;

  return query select 'opened'::text, v_new, v_abandoned;
end;
$$;

comment on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, uuid) is
  'An approved grant consumed in one transaction, in the context the tags name; the journey form names the day id (ADR 0024 step 10). Service role only.';

revoke execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, uuid) to service_role;

-- The eight-argument form keeps its signature (0103:721-731) for the launch
-- code before phase 2, as a wrapper. Its first statement is the grant lock
-- of 0103:748-754; only then does it lock the enrolment row of a journey
-- call and resolve p_journey_day to its day id through the version that row
-- is pinned to; then it calls the nine-argument form, which takes the same
-- two locks in the same order (the transaction already holds them). A
-- wrapper that took the enrolment lock first could deadlock two launches of
-- one learner. A journey day the pinned version does not map resolves to
-- null, and the nine-argument form answers unavailable. 0108's
-- preconditions end its use; it stays a wrapper.
create or replace function public.consume_grant(
  p_grant_id uuid,
  p_user_id uuid,
  p_course_id uuid,
  p_version_id uuid,
  p_org_id uuid,
  p_learning_path_id uuid,
  p_journey_enrollment_id uuid,
  p_journey_day integer
)
returns table (outcome text, attempt_id uuid, abandoned_ids uuid[])
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_day_id uuid;
begin
  -- 1. the grant row, locked first
  perform 1
    from public.attempt_requests ar
   where ar.id = p_grant_id
     and ar.user_id = p_user_id
     and ar.course_id = p_course_id
     and ar.status = 'approved'
     for update;

  -- 2. a journey call: the enrolment row, locked, and the day id of
  -- p_journey_day in the version it is pinned to
  if p_journey_enrollment_id is not null then
    select (jv.day_ids ->> p_journey_day::text)::uuid
      into v_day_id
      from public.journey_enrollments e
      join public.journey_versions jv on jv.id = e.version_id
     where e.id = p_journey_enrollment_id
       for update of e;
  end if;

  -- 3. the nine-argument form
  return query
    select g.outcome, g.attempt_id, g.abandoned_ids
      from public.consume_grant(p_grant_id, p_user_id, p_course_id, p_version_id, p_org_id,
                                p_learning_path_id, p_journey_enrollment_id, p_journey_day, v_day_id) g;
end;
$$;

revoke execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer) to service_role;

-- 6e. journey_save_days (steps 92 and 46; section U; spike 5): the curriculum
-- save by day identity, in one transaction. Security invoker, so the admin
-- write policy of journey_days (0058) still decides; execute is revoked from
-- public and anon and granted to authenticated and service_role (step 92).
-- p_days is a JSON array of day objects, each with the full shape (a key
-- left out reads null, so a day keeps its content only by sending it):
--   id             uuid of an existing day of this program; null = a new day
--   day_number     its number after the save (1 to 365); ignored when removed
--   course_id      the day's module; null = a rest day
--   mission_title  text or null
--   pass_required  boolean or null (null = inherit the course's rule)
--   removed        true = remove the day (it is kept, without a number)
-- In order: the save is checked (an array of objects, no new day removed, no
-- day named twice, no number given twice); the program row is read and
-- every named day is locked, and each must be a day of this program that the
-- session may change; a removed day cannot be given a number again; the
-- numbers of the days that move or are removed are cleared; removed days are
-- marked; the named days get their numbers and content; new days are
-- inserted; and the save raises if a day that is not removed is left
-- without a number. Clearing first keeps today's non-deferrable unique
-- (program_id, day_number) (0058:73), which the old editor's upsert needs
-- through the paste window (spike 5). Days not named are left as they are.
-- Every refusal is 22023 with a fixed message and writes nothing (the call
-- is one transaction). The answer counts the save: saved (entries),
-- renumbered (named days whose number changed), removed, inserted.
create or replace function public.journey_save_days(p_program_id uuid, p_days jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_org        uuid;
  v_saved      integer;
  v_named      integer;
  v_locked     integer;
  v_renumbered integer;
  v_removed    integer;
  v_inserted   integer;
begin
  -- 1. the save itself
  if jsonb_typeof(p_days) is distinct from 'array' then
    raise exception 'journey_save_days: the days must be a JSON array of day objects (ADR 0024)'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_days) as d(e) where jsonb_typeof(d.e) <> 'object') then
    raise exception 'journey_save_days: the days must be a JSON array of day objects (ADR 0024)'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_days) as x(id uuid, removed boolean)
              where x.id is null and coalesce(x.removed, false)) then
    raise exception 'journey_save_days: a new day cannot be removed (ADR 0024)'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_days) as x(id uuid)
              where x.id is not null group by x.id having count(*) > 1) then
    raise exception 'journey_save_days: a day is named twice in the save (ADR 0024)'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_days) as x(day_number integer, removed boolean)
              where x.day_number is not null and not coalesce(x.removed, false)
              group by x.day_number having count(*) > 1) then
    raise exception 'journey_save_days: two days of the save share a number (ADR 0024)'
      using errcode = '22023';
  end if;
  v_saved := jsonb_array_length(p_days);

  -- 2. the program, and every named day locked: each must be a day of this
  -- program that this session may change (the row-level policies decide)
  select jp.organization_id into v_org
    from public.journey_programs jp
   where jp.id = p_program_id;
  if not found then
    raise exception 'journey_save_days: this session reads no journey program with this id (ADR 0024)'
      using errcode = '22023';
  end if;
  select count(*) into v_named
    from (select distinct x.id from jsonb_to_recordset(p_days) as x(id uuid) where x.id is not null) n;
  select count(*) into v_locked
    from (select d.id
            from public.journey_days d
           where d.program_id = p_program_id
             and d.id in (select x.id from jsonb_to_recordset(p_days) as x(id uuid))
             for update) l;
  if v_locked <> v_named then
    raise exception 'journey_save_days: a day of the save is not a day of this program that this session may change (ADR 0024)'
      using errcode = '22023';
  end if;
  if exists (select 1
               from public.journey_days d
               join jsonb_to_recordset(p_days) as x(id uuid, removed boolean) on x.id = d.id
              where d.program_id = p_program_id
                and d.removed_at is not null
                and not coalesce(x.removed, false)) then
    raise exception 'journey_save_days: a removed day cannot be given a number again (ADR 0024)'
      using errcode = '22023';
  end if;

  -- 3. clear the numbers of the days that move or are removed
  select count(*) into v_renumbered
    from public.journey_days d
    join jsonb_to_recordset(p_days) as x(id uuid, day_number integer, removed boolean) on x.id = d.id
   where d.program_id = p_program_id
     and not coalesce(x.removed, false)
     and d.day_number is distinct from x.day_number;
  update public.journey_days d
     set day_number = null
    from jsonb_to_recordset(p_days) as x(id uuid, day_number integer, removed boolean)
   where d.id = x.id
     and d.program_id = p_program_id
     and d.day_number is not null
     and (coalesce(x.removed, false) or d.day_number is distinct from x.day_number);

  -- 4. mark the removed days (a day already removed keeps its time)
  update public.journey_days d
     set removed_at = now()
    from jsonb_to_recordset(p_days) as x(id uuid, removed boolean)
   where d.id = x.id
     and d.program_id = p_program_id
     and coalesce(x.removed, false)
     and d.removed_at is null;
  get diagnostics v_removed = row_count;

  -- 5. the named days: their numbers and their content
  update public.journey_days d
     set day_number = x.day_number,
         course_id = x.course_id,
         mission_title = x.mission_title,
         pass_required = x.pass_required
    from jsonb_to_recordset(p_days)
         as x(id uuid, day_number integer, course_id uuid, mission_title text, pass_required boolean, removed boolean)
   where d.id = x.id
     and d.program_id = p_program_id
     and not coalesce(x.removed, false);

  -- 6. the new days
  insert into public.journey_days (program_id, organization_id, day_number, course_id, mission_title, pass_required)
  select p_program_id, v_org, x.day_number, x.course_id, x.mission_title, x.pass_required
    from jsonb_to_recordset(p_days)
         as x(id uuid, day_number integer, course_id uuid, mission_title text, pass_required boolean)
   where x.id is null;
  get diagnostics v_inserted = row_count;

  -- 7. no day that is not removed is left without a number
  if exists (select 1 from public.journey_days d
              where d.program_id = p_program_id and d.removed_at is null and d.day_number is null) then
    raise exception 'journey_save_days: a day that is not removed was left without a number (ADR 0024)'
      using errcode = '22023';
  end if;

  return jsonb_build_object('saved', v_saved, 'renumbered', v_renumbered,
                            'removed', v_removed, 'inserted', v_inserted);
end
$$;

comment on function public.journey_save_days(uuid, jsonb) is
  'The journey curriculum save by day identity, in one transaction: moves, inserts and removals (a removed day is kept without a number) (ADR 0024 step 92). Security invoker: the admin write policy of journey_days decides.';

revoke execute on function public.journey_save_days(uuid, jsonb) from public, anon;
grant execute on function public.journey_save_days(uuid, jsonb) to authenticated, service_role;

-- 6f. journey_repin_enrollments (steps 94, 95 and 47; section U; decision
-- A27): the publish to all enrolled learners in one transaction, and its
-- dry run. Security definer, service role only; no argument has a default.
-- Two forms, and only these: a real run names the version to pin
-- (p_version_id, p_draft null, p_dry_run false), which must belong to the
-- program and be its current version; a dry run names no version and passes
-- the would-be version as p_draft ({"days", "day_ids", "days_total"}, as the
-- publish will freeze them; p_dry_run true). Both read the target into the
-- same locals and compare every active enrolment of the program with it by
-- the same statement, which computes every count before any write and
-- writes only in a real run, so the dry run's counts are the real run's.
-- A target is read as section 5 reads a version: a days entry's day is a
-- number of one to six digits; a day number listed twice is one day, its
-- course the first entry's that has one and its rule the first entry's; a
-- required day carries a course and is numbered 1 to days_total; a day's id
-- is its day_ids entry.
-- A real run locks the active enrolments in id order. For each one not
-- already pinned to the target:
--   the gate (step 94): an enrolment pinned to a slot_backfill version is
--     re-pinned only when the first day number at which the pinned version
--     and the target differ (the course or none, beyond days_total on one
--     side only, or the resolved pass rule of a day whose course is the
--     same) is above its furthest day (the higher of its top credited day
--     number and the top journey_day of its attempts that are not
--     previews, as Q9 reads it); otherwise it stays on its version and is
--     counted in kept_on_version. Any other enrolment is re-pinned.
--   the credits of a relaxed rule (step 95): on a re-pinned enrolment, a
--     required day of the target with no credit whose context holds an
--     official attempt that satisfies the target's rule for that day
--     (journey_attempt_satisfies with the day's rule in the target, else the
--     attempt's course's rule) and does not satisfy the pinned version's
--     rule (instance_pass_required: a day whose attempt already satisfies
--     it waits for its own writer or the sweep, through
--     journey_record_completion) is credited with that attempt (credit_kind
--     attempt; the day's number in the target; completed_at at the credit,
--     the column default; late when the credit's date in the organisation's
--     timezone is after the day's counted date in a calendar journey, the
--     counted days of 0089:126-134 from the enrolment's start date). Where
--     the context holds official attempts on two courses, the target's
--     course is taken first. No credit is removed.
-- Then a real run calls the completion core with the origin publish on
-- every active enrolment of the program (step 13), and completed_now is the
-- number it completed; a dry run computes the same set by the same rule
-- (required days above 0, each credited by day identity) on the target for
-- a re-pinned enrolment and through journey_credit_state on the pinned
-- version for any other. The counts (step 47): repinned; kept_on_version;
-- completed_now; sent_back (re-pinned enrolments whose open day moves to a
-- lower number); started_days_kept (open official attempts of re-pinned
-- enrolments on a required day of the pinned version that the target
-- removes, renumbers or gives another course; each stays resumable);
-- credits_now_history (credits of re-pinned enrolments on a required day of
-- the pinned version that the target does not require);
-- credited_by_rule_change. Completed and reset enrolments are never
-- selected. No attempt row and no credit row is updated or deleted.
-- Idempotent for the program's current version: a second real run finds
-- every enrolment pinned to it, or kept, and writes nothing new.
create or replace function public.journey_repin_enrollments(
  p_program_id uuid,
  p_version_id uuid,
  p_draft jsonb,
  p_dry_run boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days          jsonb;
  v_day_ids       jsonb;
  v_days_total    integer;
  v_calendar      boolean := false;
  v_count_sundays boolean := false;
  v_tz            text;
  v_today         date;
  v_ids           uuid[];
  v_c             record;
  v_completed     integer;
begin
  -- 1. the target
  if p_dry_run is false and p_version_id is not null and p_draft is null then
    select jv.days, coalesce(jv.day_ids, '{}'::jsonb), jv.days_total,
           coalesce(jv.unlock_mode, 'calendar') = 'calendar', jv.count_sundays
      into v_days, v_day_ids, v_days_total, v_calendar, v_count_sundays
      from public.journey_versions jv
      join public.journey_programs jp on jp.id = jv.program_id
     where jv.id = p_version_id
       and jv.program_id = p_program_id
       and jp.current_version_id = jv.id;
    if not found then
      raise exception 'journey_repin_enrollments: the version is not the current version of this program (ADR 0024)'
        using errcode = '22023';
    end if;
  elsif p_dry_run is true and p_version_id is null and p_draft is not null then
    if jsonb_typeof(p_draft -> 'days') is distinct from 'array'
       or jsonb_typeof(p_draft -> 'day_ids') is distinct from 'object'
       or coalesce(p_draft ->> 'days_total', '') !~ '^[0-9]{1,3}$' then
      raise exception 'journey_repin_enrollments: the draft needs days (an array), day_ids (an object) and days_total (a whole number) (ADR 0024)'
        using errcode = '22023';
    end if;
    v_days := p_draft -> 'days';
    v_day_ids := p_draft -> 'day_ids';
    v_days_total := (p_draft ->> 'days_total')::integer;
  else
    raise exception 'journey_repin_enrollments: a real run names a version and no draft; a dry run names a draft and no version (ADR 0024)'
      using errcode = '22023';
  end if;

  select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
    from public.journey_programs jp
    left join public.gamification_settings gs on gs.organization_id = jp.organization_id
   where jp.id = p_program_id;
  v_today := (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;

  -- 2. the program's active enrolments, in id order; a real run locks them
  if p_dry_run then
    select coalesce(array_agg(e.id order by e.id), '{}'::uuid[]) into v_ids
      from public.journey_enrollments e
     where e.program_id = p_program_id and e.status = 'active';
  else
    select coalesce(array_agg(l.id order by l.id), '{}'::uuid[]) into v_ids
      from (select e.id
              from public.journey_enrollments e
             where e.program_id = p_program_id and e.status = 'active'
             order by e.id
               for update) l;
  end if;

  -- 3. compare and count on one snapshot, and write in a real run only
  with
  ver as (
    -- the target (version_id null) and every version an enrolment is pinned to
    select null::uuid as version_id, v_days as days, coalesce(v_day_ids, '{}'::jsonb) as day_ids,
           v_days_total as days_total
    union all
    select jv.id, jv.days, coalesce(jv.day_ids, '{}'::jsonb), jv.days_total
      from public.journey_versions jv
     where jv.id in (select e.version_id from public.journey_enrollments e where e.id = any(v_ids))
  ),
  vday as (
    -- one row per (version, day number)
    select g.version_id, g.day_number, g.course_id, g.rule, g.day_id,
           (g.course_id is not null and g.day_number between 1 and g.days_total) as required
      from (
        select v.version_id, v.days_total, x.day_number,
               (array_agg(x.course_id order by x.ord) filter (where x.course_id is not null))[1] as course_id,
               (array_agg(x.rule order by x.ord))[1] as rule,
               min(v.day_ids ->> x.day_number::text)::uuid as day_id
          from ver v
          cross join lateral (
            select case when d.e ->> 'day' ~ '^[0-9]{1,6}$' then (d.e ->> 'day')::int end as day_number,
                   lower(nullif(d.e ->> 'course_id', '')) as course_id,
                   case when jsonb_typeof(d.e -> 'pass_required') = 'boolean'
                        then (d.e ->> 'pass_required')::boolean end as rule,
                   d.ord
              from jsonb_array_elements(case when jsonb_typeof(v.days) = 'array' then v.days else '[]'::jsonb end)
                   with ordinality as d(e, ord)
          ) x
         where x.day_number is not null
         group by v.version_id, v.days_total, x.day_number
      ) g
  ),
  tday as (
    select t.* from vday t where t.version_id is null
  ),
  enr as (
    select e.id, e.user_id, e.organization_id, e.version_id, e.start_date, jv.days_total,
           jv.day_ids_source = 'slot_backfill' as slot
      from public.journey_enrollments e
      join public.journey_versions jv on jv.id = e.version_id
     where e.id = any(v_ids)
  ),
  cred as (
    select p.enrollment_id, p.day_id from public.journey_day_progress p where p.enrollment_id = any(v_ids)
  ),
  old_st as (
    select s.* from public.journey_credit_state(v_ids) s
  ),
  dec as (
    select en.id, en.user_id, en.organization_id, en.version_id, en.start_date,
           not (coalesce(en.slot, false) and gt.first_diff is not null and gt.first_diff <= f.day_number) as repin
      from enr en
      cross join lateral (
        -- the furthest day (Q9's reading)
        select greatest(0,
                 coalesce((select max(p.day_number) from public.journey_day_progress p
                            where p.enrollment_id = en.id), 0),
                 coalesce((select max(a.journey_day) from public.course_attempts a
                            where a.journey_enrollment_id = en.id and not a.is_preview), 0)) as day_number
      ) f
      cross join lateral (
        -- the first day number at which the pinned version and the target differ
        select min(g.d) as first_diff
          from generate_series(1, greatest(en.days_total, v_days_total)) as g(d)
          left join vday o on o.version_id = en.version_id and o.day_number = g.d
          left join tday t on t.day_number = g.d
          left join public.courses c on c.id::text = coalesce(o.course_id, t.course_id)
         where (case when g.d <= en.days_total then coalesce(o.course_id, '') else '#beyond' end,
                case when g.d <= en.days_total and o.course_id is not null
                     then coalesce(o.rule, c.pass_required, false) end)
               is distinct from
               (case when g.d <= v_days_total then coalesce(t.course_id, '') else '#beyond' end,
                case when g.d <= v_days_total and t.course_id is not null
                     then coalesce(t.rule, c.pass_required, false) end)
      ) gt
     where p_version_id is null or en.version_id <> p_version_id
  ),
  rc as (
    -- the credits of a relaxed rule, one per (enrolment, day)
    select distinct on (d.id, t.day_id)
           d.id as enrollment_id, d.organization_id, d.user_id, t.day_number, t.day_id,
           s.course_id, s.official_attempt_id as attempt_id,
           (v_calendar
            and (select count(*)
                   from generate_series(d.start_date::timestamp, (v_today - 1)::timestamp, interval '1 day') as g(x)
                  where v_count_sundays or extract(dow from g.x) <> 0) >= t.day_number) as late
      from dec d
      join tday t on t.required and t.day_id is not null
      join public.v_context_attempt_scoring s
        on s.user_id = d.user_id
       and s.context_key = 'journey:' || d.id::text || ':' || t.day_id::text
       and s.official_attempt_id is not null
     where d.repin
       and not exists (select 1 from cred c where c.enrollment_id = d.id and c.day_id = t.day_id)
       and public.journey_attempt_satisfies(
             s.official_attempt_id,
             coalesce(t.rule, (select c.pass_required from public.courses c where c.id = s.course_id), false))
       -- a rule change only: not a day whose attempt already satisfies the
       -- pinned version's rule (its missing credit is the writer's, or the
       -- sweep's, through journey_record_completion)
       and not public.journey_attempt_satisfies(
             s.official_attempt_id, public.instance_pass_required(s.course_id, s.context_key))
     order by d.id, t.day_id, (s.course_id::text = t.course_id) desc, s.official_attempt_id
  ),
  new_day as (
    -- the target's days for each re-pinned enrolment, credited by day identity
    select d.id, t.day_number, t.required,
           (exists (select 1 from cred c where c.enrollment_id = d.id and c.day_id = t.day_id)
            or exists (select 1 from rc r where r.enrollment_id = d.id and r.day_id = t.day_id)) as credited
      from dec d
      cross join tday t
     where d.repin
  ),
  new_st as (
    select n.id,
           count(*) filter (where n.required) as required_days,
           min(n.day_number) filter (where n.required and not n.credited) as next_day
      from new_day n
     group by n.id
  ),
  upd as (
    update public.journey_enrollments e
       set version_id = p_version_id
      from dec d
     where not p_dry_run
       and d.repin
       and e.id = d.id
    returning e.id
  ),
  ins as (
    insert into public.journey_day_progress
      (enrollment_id, organization_id, user_id, day_number, day_id, course_id, attempt_id, credit_kind, late)
    select r.enrollment_id, r.organization_id, r.user_id, r.day_number, r.day_id, r.course_id, r.attempt_id,
           'attempt', r.late
      from rc r
     where not p_dry_run
    on conflict (enrollment_id, day_id) do nothing
    returning 1
  )
  select
    (select count(*) from dec d where d.repin)::integer as repinned,
    (select count(*) from dec d where not d.repin)::integer as kept_on_version,
    (select count(*)
       from dec d
       join old_st o on o.enrollment_id = d.id
       join new_st n on n.id = d.id
      where d.repin and n.next_day < o.next_day)::integer as sent_back,
    (select count(*)
       from dec d
       join public.course_attempts a
         on a.journey_enrollment_id = d.id
        and a.context_kind = 'journey'
        and a.status = 'in_progress'
        and not a.is_revision
       cross join lateral (
         select o.day_number, o.course_id from vday o
          where o.version_id = d.version_id and o.day_id = a.journey_day_id and o.required
          order by o.day_number limit 1
       ) od
       left join lateral (
         select t.day_number, t.course_id from tday t
          where t.day_id = a.journey_day_id and t.required
          order by t.day_number limit 1
       ) nd on true
      where d.repin
        and (nd.day_number is null
             or nd.day_number <> od.day_number
             or nd.course_id is distinct from od.course_id))::integer as started_days_kept,
    (select count(*)
       from dec d
       join cred c on c.enrollment_id = d.id
      where d.repin
        and exists (select 1 from vday o where o.version_id = d.version_id and o.day_id = c.day_id and o.required)
        and not exists (select 1 from tday t where t.day_id = c.day_id and t.required))::integer
      as credits_now_history,
    (select count(*) from rc)::integer as credited_by_rule_change,
    (select count(*)
       from unnest(v_ids) as u(id)
       left join dec d on d.id = u.id and d.repin
       left join new_st n on n.id = u.id
       left join old_st o on o.enrollment_id = u.id
      where case when d.id is not null
                 then coalesce(n.required_days, 0) > 0 and n.next_day is null
                 else coalesce(o.required_days, 0) > 0 and o.next_day is null
            end)::integer as completed_by_rule,
    (select count(*) from upd)::integer as written_pins,
    (select count(*) from ins)::integer as written_credits
    into v_c;

  -- 4. completion: the core in a real run (step 13), the same rule in a dry run
  if p_dry_run then
    v_completed := v_c.completed_by_rule;
  else
    select count(*)::integer into v_completed
      from public.journey_complete_enrollments_core(v_ids, 'publish');
  end if;

  return jsonb_build_object(
    'dry_run',                 p_dry_run,
    'repinned',                v_c.repinned,
    'kept_on_version',         v_c.kept_on_version,
    'completed_now',           v_completed,
    'sent_back',               v_c.sent_back,
    'started_days_kept',       v_c.started_days_kept,
    'credits_now_history',     v_c.credits_now_history,
    'credited_by_rule_change', v_c.credited_by_rule_change
  );
end
$$;

comment on function public.journey_repin_enrollments(uuid, uuid, jsonb, boolean) is
  'The publish to all enrolled learners, by day identity, in one transaction: re-pin (with the gate for slot_backfill pins), the credits of a relaxed rule, completion with the origin publish; or, with p_dry_run, the same counts with nothing written (ADR 0024 steps 47, 94, 95). Service role only.';

revoke execute on function public.journey_repin_enrollments(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.journey_repin_enrollments(uuid, uuid, jsonb, boolean) to service_role;

-- 6g. The journey completion core and its two wrappers (step 13, decision
-- A27; the owner's A20 answer for the publish): the one writer of a journey
-- completion. journey_complete_enrollments_core locks the named enrolments
-- that are active, in id order, then, in a statement that starts after the
-- locks are held, completes each one that journey_credit_state (section 5d)
-- reads complete (required_days above 0 and no open day): status completed
-- and completed_at now(), the date every surface prints. For each
-- enrolment that update changed, and for no other, the core itself inserts
-- the yoddha badge for that enrolment (period 'enr:' || enrolment id, the
-- program's id and name in metadata; user_badges keys on coalesce(period,
-- ''), 0053:233-234, so earlier lifetime rows are untouched) and takes the
-- journey claim in completion_notices with p_origin as its origin. The badge
-- and the claim are statements of the core and of nothing else, so every
-- caller shares one latch. A data-modifying statement in a with clause runs
-- once and to completion whether or not the outer select reads it. It
-- returns the ids it completed, in id order. Security definer, service role
-- only; p_origin is learner or publish, else 22023.
create or replace function public.journey_complete_enrollments_core(p_ids uuid[], p_origin text)
returns setof uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ids uuid[];
begin
  if p_origin is null or p_origin not in ('learner', 'publish') then
    raise exception 'journey_complete_enrollments_core: the origin is learner or publish (ADR 0024)'
      using errcode = '22023';
  end if;

  -- 1. the named active enrolments, locked in id order
  select coalesce(array_agg(l.id order by l.id), '{}'::uuid[]) into v_ids
    from (select e.id
            from public.journey_enrollments e
           where e.id = any(p_ids) and e.status = 'active'
           order by e.id
             for update) l;

  -- 2. the one rule, read after the locks; 3. the badge and the claim of
  -- each enrolment this update changed
  return query
    with done as (
      update public.journey_enrollments e
         set status = 'completed',
             completed_at = now()
        from public.journey_credit_state(v_ids) s
       where s.enrollment_id = e.id
         and e.status = 'active'
         and s.required_days > 0
         and s.next_day is null
      returning e.id, e.organization_id, e.user_id, e.program_id
    ),
    badge as (
      insert into public.user_badges (organization_id, user_id, badge_slug, period, metadata)
      select d.organization_id, d.user_id, 'yoddha', 'enr:' || d.id::text,
             jsonb_build_object('journey_program', d.program_id, 'program_name', jp.name)
        from done d
        left join public.journey_programs jp on jp.id = d.program_id
      on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing
      returning 1
    ),
    claim as (
      insert into public.completion_notices (organization_id, user_id, product_kind, instance_id, event_type, origin)
      select d.organization_id, d.user_id, 'journey', d.id, 'journey_completion', p_origin
        from done d
      on conflict (user_id, product_kind, instance_id) do nothing
      returning 1
    )
    select d.id from done d order by d.id;
end
$$;

comment on function public.journey_complete_enrollments_core(uuid[], text) is
  'The one writer of a journey completion (ADR 0024 step 13): completes the named active enrolments that journey_credit_state reads complete, and for each one inserts its yoddha badge (period enr:<enrolment id>) and the journey claim with the given origin. Service role only.';

revoke execute on function public.journey_complete_enrollments_core(uuid[], text) from public, anon, authenticated;
grant execute on function public.journey_complete_enrollments_core(uuid[], text) to service_role;

-- journey_complete_enrollment: one enrolment, origin learner (the writer of
-- step 12, through journey_record_completion). True only when the core's
-- update changed that row, so a second call, or a concurrent caller that
-- waited on the lock, reads false; the writer reads the claim the core made
-- from the same transaction.
create or replace function public.journey_complete_enrollment(p_enrollment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.journey_complete_enrollments_core(array[p_enrollment_id], 'learner') as c(id)
   where c.id = p_enrollment_id;
  return v_n > 0;
end
$$;

comment on function public.journey_complete_enrollment(uuid) is
  'Completes one journey enrolment through the completion core with the origin learner; true only when this call completed it (ADR 0024 step 13). Service role only.';

revoke execute on function public.journey_complete_enrollment(uuid) from public, anon, authenticated;
grant execute on function public.journey_complete_enrollment(uuid) to service_role;

-- journey_complete_enrollments: every active enrolment of one program,
-- origin publish (an admin's publish to all enrolled learners; it sends no
-- email, the owner's A20 answer). Returns the ids the core completed.
-- journey_repin_enrollments (6f) calls the core itself with the same origin.
create or replace function public.journey_complete_enrollments(p_program_id uuid)
returns setof uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
    select c.id
      from public.journey_complete_enrollments_core(
             (select coalesce(array_agg(e.id order by e.id), '{}'::uuid[])
                from public.journey_enrollments e
               where e.program_id = p_program_id and e.status = 'active'),
             'publish') as c(id);
end
$$;

comment on function public.journey_complete_enrollments(uuid) is
  'Completes every active enrolment of one journey program that the one rule reads complete, through the completion core with the origin publish; returns the completed ids (ADR 0024 step 13). Service role only.';

revoke execute on function public.journey_complete_enrollments(uuid) from public, anon, authenticated;
grant execute on function public.journey_complete_enrollments(uuid) to service_role;

-- 6h. journey_record_completion (step 13; section U; R13, R14): recreated
-- from its latest body, 0089:17-141; its grants, last stated at
-- 0058:381-382, are restated. 0081, 0088, 0089 and 0058 are never pasted
-- again (header). Changed, and nothing else:
--   - its first statement locks the attempt's enrolment row (for update) and
--     reads the owner, the status and the pinned version from that locked
--     row, so a re-pin cannot change the version between the checks and the
--     write, and two last-day credits of one enrolment run one after the
--     other;
--   - it requires a journey row (context_kind journey) that is not a
--     revision row (the routes gated it; a row of another context answers
--     skipped, so the old routes' direct calls in the paste window stay
--     harmless);
--   - the pass rule is the lenient rule of R14: journey_attempt_satisfies
--     (5c) with the day's resolved rule in the pinned version
--     (instance_pass_required, 5b), in place of the course's rule;
--   - it credits (enrolment, day id) when the attempt's journey_day_id is a
--     day of the pinned version, whatever course that day holds now (the
--     launch proved the day held it when the learner started; no course
--     check, A30); when the day is no longer a required day there (removed,
--     cleared to a rest day, or beyond days_total), the credit row is still
--     written, as history, counts towards nothing and the answer says
--     day_removed; the row carries the day id, the day's number in the
--     pinned version (else the attempt's journey_day), credit_kind attempt
--     and late (credited after that day's counted date in a calendar
--     journey, counted as journey_repin_enrollments counts it, 6f); its
--     conflict target is (enrollment_id, day_id);
--   - a completed enrolment still gets the credit row, as history, and
--     nothing else; a reset enrolment is refused as before;
--   - completion is the core's (6g), through journey_complete_enrollment,
--     after every credit, whether or not this call inserted it; the
--     count of progress rows, the lifetime badge and the untagged branch
--     with its re-tag (0089:64-112) are gone. No start-date floor and no
--     calendar ceiling on this branch, as in 0089 (A30).
-- The answer adds day_id, credited (this call inserted the credit),
-- day_removed, late and history (a completed enrolment) to 0089's keys;
-- yoddha_unlocked is true only when this call completed the enrolment.
create or replace function public.journey_record_completion(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_att record;
  v_enr record;
  v_day integer;
  v_required boolean;
  v_tz text;
  v_today date;
  v_late boolean := false;
  v_pass_required boolean;
  v_credited boolean := false;
  v_completed boolean := false;
begin
  -- 0107: the enrolment row, locked first
  select e.id, e.organization_id, e.program_id, e.user_id, e.status, e.start_date,
         v.days, v.day_ids, v.days_total, v.count_sundays, v.unlock_mode
    into v_enr
    from public.journey_enrollments e
    join public.journey_versions v on v.id = e.version_id
   where e.id = (select a.journey_enrollment_id from public.course_attempts a where a.id = p_attempt_id)
     for update of e;

  select a.id, a.user_id, a.organization_id, a.journey_enrollment_id,
         a.journey_day, a.journey_day_id, a.context_kind, a.context_key, a.is_revision,
         a.completion_status, a.success_status, cv.course_id
    into v_att
    from public.course_attempts a
    join public.course_versions cv on cv.id = a.course_version_id
   where a.id = p_attempt_id;
  if v_att.id is null then
    return jsonb_build_object('ok', true, 'skipped', 'no_attempt');
  end if;
  -- 0107: a journey row, not a revision row
  if v_att.context_kind is distinct from 'journey' then
    return jsonb_build_object('ok', true, 'skipped', 'not_journey');
  end if;
  if v_att.is_revision then
    return jsonb_build_object('ok', true, 'skipped', 'revision');
  end if;
  if v_att.completion_status <> 'completed' and v_att.success_status <> 'passed' then
    return jsonb_build_object('ok', true, 'skipped', 'not_complete');
  end if;

  -- 0107: the day's resolved rule in the pinned version, or the rule of the
  -- version the attempt was launched under (R14)
  v_pass_required := public.instance_pass_required(v_att.course_id, v_att.context_key);
  if not public.journey_attempt_satisfies(v_att.id, v_pass_required) then
    return jsonb_build_object('ok', true, 'skipped', 'pass_required');
  end if;

  -- the learner's own enrolment, active (or completed: history only)
  if v_enr.id is null or v_enr.user_id <> v_att.user_id or v_enr.status not in ('active', 'completed') then
    return jsonb_build_object('ok', true, 'skipped', 'enrollment_inactive');
  end if;

  -- 0107: the day by its identity, in the pinned version
  select j.key::integer into v_day
    from jsonb_each_text(case when jsonb_typeof(v_enr.day_ids) = 'object' then v_enr.day_ids else '{}'::jsonb end) j
   where j.key ~ '^[0-9]{1,6}$'
     and j.value::uuid = v_att.journey_day_id
   order by j.key::integer
   limit 1;
  v_required := v_day is not null
    and v_day between 1 and v_enr.days_total
    and exists (
      select 1
        from jsonb_array_elements(case when jsonb_typeof(v_enr.days) = 'array' then v_enr.days else '[]'::jsonb end) d(e)
       where d.e ->> 'day' ~ '^[0-9]{1,6}$'
         and (d.e ->> 'day')::integer = v_day
         and nullif(d.e ->> 'course_id', '') is not null);
  v_day := coalesce(v_day, v_att.journey_day);

  -- 0107: late, in a calendar journey: credited after the day's counted date
  if coalesce(v_enr.unlock_mode, 'calendar') = 'calendar' then
    select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
      from public.gamification_settings gs
     where gs.organization_id = v_enr.organization_id;
    v_today := (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
    select count(*) >= v_day into v_late
      from generate_series(v_enr.start_date::timestamp, (v_today - 1)::timestamp, interval '1 day') g(x)
     where v_enr.count_sundays or extract(dow from g.x) <> 0;
  end if;

  insert into public.journey_day_progress
    (enrollment_id, organization_id, user_id, day_number, day_id, course_id, attempt_id, credit_kind, late)
  values
    (v_enr.id, v_enr.organization_id, v_att.user_id, v_day, v_att.journey_day_id, v_att.course_id, v_att.id,
     'attempt', coalesce(v_late, false))
  on conflict (enrollment_id, day_id) do nothing;
  v_credited := found;

  -- 0107: completion by the one rule, in the core (an active enrolment only)
  if v_enr.status = 'active' then
    v_completed := public.journey_complete_enrollment(v_enr.id);
  end if;

  return jsonb_build_object('ok', true, 'day', v_day, 'day_id', v_att.journey_day_id,
                            'credited', v_credited, 'day_removed', not v_required,
                            'late', coalesce(v_late, false), 'history', v_enr.status = 'completed',
                            'yoddha_unlocked', v_completed);
end;
$$;

comment on function public.journey_record_completion(uuid) is
  'Credits a completed journey attempt to its own day by day identity (a history credit when the day is no longer required), under the lenient pass rule of R14, and completes the enrolment through the completion core (ADR 0024 step 13). Service role only.';

revoke all on function public.journey_record_completion(uuid) from public, anon, authenticated;
grant execute on function public.journey_record_completion(uuid) to service_role;

-- 6i. The XP core and its wrapper (steps 17, 33 to 36; decisions D8 and
-- D9). gamification_record_activity_core is recreated from its latest body,
-- 0084:55-349 (grants 0084:350-351), as a three-argument form, and the
-- one-argument form keeps its signature as a wrapper of it; 0053, 0073 and
-- 0084 are never pasted again (header). The two booleans say which part runs
-- (step 12's two branches; the writer and the sweep need them apart):
--   p_activity  the activity part: the streak (0084:121-133), the daily
--               points (0084:189-200), the streak milestones and the day
--               the learner was last active. False leaves the streak, its
--               start, the longest streak and last_active_day as they are.
--   p_rewards   the reward candidates of section F: the caller has
--               established that the row is complete and the official
--               attempt of its context (the writer of 6j decides that, the
--               one-argument form asks official_attempt_in_context).
-- Changed in the body, and nothing else:
--   - the scored-window ordinal and the consumed grants (v_attempt_no,
--     v_extra_grants) count within the row's context_key through the
--     official rule (not a revision row, not a preview, not abandoned; a
--     grant counts by the row its used_attempt_id names, whatever the
--     grant's own context, note N9), so each context's first official
--     attempt is attempt 1 and can earn a bonus;
--   - beside each paid candidate (course_completed, course_passed,
--     perfect_score, high_score), an event row with the same rule, xp 0,
--     event_only true and the dedupe key '<paid key>:<context_key>', written
--     outside the v_amt > 0 branches and under the same gates (the
--     anti-gaming gate of the completion, the scored window and the score
--     tier); the paid keys are unchanged, so nothing pays twice (step 36);
--   - every row it inserts names the row's context_kind and context_key.
-- An organisation with gamification off writes nothing, as before (the
-- caller's other side effects do not depend on this answer).
create or replace function public.gamification_record_activity_core(
  p_attempt_id uuid,
  p_activity boolean,
  p_rewards boolean
)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_att record;
  v_set record;
  v_day date;
  v_ug record;
  v_streak integer;
  v_streak_start date;
  v_longest integer;
  v_headroom integer;
  v_completed boolean;
  v_completion_ok boolean;
  v_inserted integer := 0;
  v_awards jsonb := '[]'::jsonb;
  v_amt integer;
  v_new_completed integer;
  v_new_perfect integer;
  v_new_passed integer;
  v_total integer;
  v_level integer;
  v_b record;
  v_earn boolean;
  v_completed_event boolean := false;
  v_perfect_event boolean := false;
  v_passed_event boolean := false;
  v_speed_minutes numeric;
  v_pol record;
  v_attempt_no integer;
  v_scored boolean := false;
  v_extra_grants integer := 0;
begin
  select ca.id, ca.organization_id, ca.user_id, ca.score,
         ca.completion_status, ca.success_status, ca.started_at, ca.completed_at,
         ca.context_kind, ca.context_key, cv.course_id
    into v_att
    from public.course_attempts ca
    join public.course_versions cv on cv.id = ca.course_version_id
   where ca.id = p_attempt_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'attempt_not_found');
  end if;

  select * into v_set from public.gamification_settings
   where organization_id = v_att.organization_id;
  if not found then
    insert into public.gamification_settings (organization_id)
    values (v_att.organization_id) on conflict (organization_id) do nothing;
    select * into v_set from public.gamification_settings
     where organization_id = v_att.organization_id;
  end if;
  if v_set.enabled is distinct from true then
    return jsonb_build_object('ok', true, 'skipped', 'disabled');
  end if;

  v_day := (now() at time zone v_set.timezone)::date;

  -- Row-lock the rollup (creates it on first activity).
  insert into public.user_gamification (organization_id, user_id)
  values (v_att.organization_id, v_att.user_id)
  on conflict (organization_id, user_id) do nothing;
  select * into v_ug from public.user_gamification
   where organization_id = v_att.organization_id and user_id = v_att.user_id
   for update;

  -- Streak math (org-local days). 0107: the activity part only; otherwise
  -- the streak stands as it is.
  if not coalesce(p_activity, false) then
    v_streak := v_ug.current_streak_days;
    v_streak_start := v_ug.streak_started_day;
  elsif v_ug.last_active_day is null then
    v_streak := 1; v_streak_start := v_day;
  elsif v_ug.last_active_day = v_day then
    v_streak := greatest(v_ug.current_streak_days, 1);
    v_streak_start := coalesce(v_ug.streak_started_day, v_day);
  elsif v_ug.last_active_day = v_day - 1 then
    v_streak := v_ug.current_streak_days + 1;
    v_streak_start := coalesce(v_ug.streak_started_day, v_day - v_ug.current_streak_days);
  else
    v_streak := 1; v_streak_start := v_day;
  end if;
  v_longest := greatest(coalesce(v_ug.longest_streak_days, 0), v_streak);

  -- Daily XP cap headroom (org-local day window).
  if v_set.daily_xp_cap > 0 then
    select v_set.daily_xp_cap - coalesce(sum(xp), 0) into v_headroom
      from public.xp_events
     where organization_id = v_att.organization_id
       and user_id = v_att.user_id
       and created_at >= (v_day::timestamp at time zone v_set.timezone);
    v_headroom := greatest(coalesce(v_headroom, v_set.daily_xp_cap), 0);
  else
    v_headroom := 2147483647;
  end if;

  -- House completion definition (R1). 0107: the reward part only.
  v_completed := coalesce(p_rewards, false)
                 and (v_att.completion_status = 'completed' or v_att.success_status = 'passed');
  -- Anti-gaming: optional minimum-duration guard for score-less completions.
  v_completion_ok := v_completed and not (
    v_set.min_completion_seconds > 0
    and v_att.score is null
    and v_att.completed_at is not null
    and extract(epoch from (v_att.completed_at - v_att.started_at)) < v_set.min_completion_seconds
  );

  -- 0073: is this one of the learner's first N completed attempts for the
  -- course? Same ordering as v_course_attempt_scoring.
  -- 0084: the window is widened by the learner's CONSUMED admin grants for the
  -- course (approved attempt_requests with a used retake), mirroring the TS
  -- scoring engine — so a granted official retake counts as a scored attempt
  -- and can earn the high/perfect bonus. The bonus dedupe keys stay per-course,
  -- so the bonus is still paid at most once for the course. Fail-soft before
  -- 0083 (no attempt_requests table) via the undefined_table guard.
  -- 0107: both count within the row's context_key through the official rule
  -- (v_context_attempt_scoring's ordering and filter); a grant counts by the
  -- row its used_attempt_id names, whatever the grant's own context (N9).
  if v_completed then
    select * into v_pol from public.effective_attempt_policy(v_att.course_id);
    select count(*) into v_attempt_no
      from public.course_attempts ca2
      join public.course_versions cv2 on cv2.id = ca2.course_version_id
     where cv2.course_id = v_att.course_id
       and ca2.user_id = v_att.user_id
       and ca2.context_key = v_att.context_key
       and not ca2.is_revision
       and ca2.context_kind <> 'preview'
       and ca2.status <> 'abandoned'
       and (ca2.completion_status = 'completed' or ca2.success_status = 'passed')
       and (coalesce(ca2.completed_at, ca2.started_at), ca2.started_at, ca2.id)
           <= (coalesce(v_att.completed_at, v_att.started_at), v_att.started_at, v_att.id);
    begin
      select count(*) into v_extra_grants
        from public.attempt_requests ar
        join public.course_attempts ca3 on ca3.id = ar.used_attempt_id
       where ar.user_id = v_att.user_id
         and ar.course_id = v_att.course_id
         and ar.status = 'approved'
         and ar.used_attempt_id is not null
         and ca3.context_key = v_att.context_key
         and not ca3.is_revision
         and ca3.context_kind <> 'preview'
         and ca3.status <> 'abandoned';
    exception when undefined_table then
      v_extra_grants := 0;
    end;
    v_scored := coalesce(v_attempt_no, 1)
                <= coalesce(v_pol.max_scored_attempts, 3) + coalesce(v_extra_grants, 0);
  end if;

  -- Candidate 1: daily activity. 0107: the activity part only.
  v_amt := case when coalesce(p_activity, false) then least(v_set.xp_daily_activity, v_headroom) else 0 end;
  if v_amt > 0 then
    insert into public.xp_events (organization_id, user_id, rule, xp, attempt_id, source_day, dedupe_key,
                                  context_kind, context_key)
    values (v_att.organization_id, v_att.user_id, 'daily_activity', v_amt, v_att.id, v_day,
            format('daily:%s:%s:%s', v_att.organization_id, v_att.user_id, v_day),
            v_att.context_kind, v_att.context_key)
    on conflict (dedupe_key) do nothing;
    if found then
      v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
      v_awards := v_awards || jsonb_build_object('rule', 'daily_activity', 'xp', v_amt);
    end if;
  end if;

  -- Candidate 2: first-ever completion of this course.
  if v_completion_ok then
    v_amt := least(v_set.xp_course_completion, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                    context_kind, context_key)
      values (v_att.organization_id, v_att.user_id, 'course_completed', v_amt, v_att.course_id, v_att.id, v_day,
              format('complete:%s:%s', v_att.user_id, v_att.course_id),
              v_att.context_kind, v_att.context_key)
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_completed_event := true;
        v_awards := v_awards || jsonb_build_object('rule', 'course_completed', 'xp', v_amt);
      end if;
    end if;
    -- 0107: the event row of this context (0 XP)
    insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                  context_kind, context_key, event_only)
    values (v_att.organization_id, v_att.user_id, 'course_completed', 0, v_att.course_id, v_att.id, v_day,
            format('complete:%s:%s:%s', v_att.user_id, v_att.course_id, v_att.context_key),
            v_att.context_kind, v_att.context_key, true)
    on conflict (dedupe_key) do nothing;

    -- Candidate 2b (0084): first genuine PASS of this course, recorded ONCE
    -- regardless of which official attempt it lands on (e.g. an admin-granted
    -- retake that finally passes). A 0-XP marker — it drives the pass counter
    -- and badge below, decoupled from the first-completion event. No XP, so
    -- completion XP stays one-time and score bonuses stay one-time.
    if v_att.success_status = 'passed' then
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                    context_kind, context_key)
      values (v_att.organization_id, v_att.user_id, 'course_passed', 0, v_att.course_id, v_att.id, v_day,
              format('passed:%s:%s', v_att.user_id, v_att.course_id),
              v_att.context_kind, v_att.context_key)
      on conflict (dedupe_key) do nothing;
      if found then
        v_passed_event := true;
      end if;
      -- 0107: the event row of this context
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                    context_kind, context_key, event_only)
      values (v_att.organization_id, v_att.user_id, 'course_passed', 0, v_att.course_id, v_att.id, v_day,
              format('passed:%s:%s:%s', v_att.user_id, v_att.course_id, v_att.context_key),
              v_att.context_kind, v_att.context_key, true)
      on conflict (dedupe_key) do nothing;
    end if;

    -- Candidate 3: score bonuses — SCORED attempts only (0073). Perfect
    -- requires a non-suspect pass (a raw SCORM score of 1/100 stores as
    -- 1.0 with success 'failed').
    if v_scored and v_att.score is not null and v_att.score >= 0.999
       and v_att.success_status is distinct from 'failed' then
      v_amt := least(v_set.xp_perfect_score_bonus, v_headroom);
      if v_amt > 0 then
        insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                      context_kind, context_key)
        values (v_att.organization_id, v_att.user_id, 'perfect_score', v_amt, v_att.course_id, v_att.id, v_day,
                format('perfect:%s:%s', v_att.user_id, v_att.course_id),
                v_att.context_kind, v_att.context_key)
        on conflict (dedupe_key) do nothing;
        if found then
          v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
          v_perfect_event := true;
          v_awards := v_awards || jsonb_build_object('rule', 'perfect_score', 'xp', v_amt);
        end if;
      end if;
      -- 0107: the event row of this context
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                    context_kind, context_key, event_only)
      values (v_att.organization_id, v_att.user_id, 'perfect_score', 0, v_att.course_id, v_att.id, v_day,
              format('perfect:%s:%s:%s', v_att.user_id, v_att.course_id, v_att.context_key),
              v_att.context_kind, v_att.context_key, true)
      on conflict (dedupe_key) do nothing;
    elsif v_scored and v_att.score is not null and v_att.score >= 0.90 and v_att.score < 0.999 then
      v_amt := least(v_set.xp_high_score_bonus, v_headroom);
      if v_amt > 0 then
        insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                      context_kind, context_key)
        values (v_att.organization_id, v_att.user_id, 'high_score', v_amt, v_att.course_id, v_att.id, v_day,
                format('high:%s:%s', v_att.user_id, v_att.course_id),
                v_att.context_kind, v_att.context_key)
        on conflict (dedupe_key) do nothing;
        if found then
          v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
          v_awards := v_awards || jsonb_build_object('rule', 'high_score', 'xp', v_amt);
        end if;
      end if;
      -- 0107: the event row of this context
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key,
                                    context_kind, context_key, event_only)
      values (v_att.organization_id, v_att.user_id, 'high_score', 0, v_att.course_id, v_att.id, v_day,
              format('high:%s:%s:%s', v_att.user_id, v_att.course_id, v_att.context_key),
              v_att.context_kind, v_att.context_key, true)
      on conflict (dedupe_key) do nothing;
    end if;
  end if;

  -- Candidate 4: streak milestones (re-earnable per streak run). 0107: the
  -- activity part only.
  if coalesce(p_activity, false) and v_streak >= 7 then
    v_amt := least(v_set.xp_streak_7_bonus, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, source_day, dedupe_key,
                                    context_kind, context_key)
      values (v_att.organization_id, v_att.user_id, 'streak_7', v_amt, v_day,
              format('streak7:%s:%s:%s', v_att.organization_id, v_att.user_id, v_streak_start),
              v_att.context_kind, v_att.context_key)
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_awards := v_awards || jsonb_build_object('rule', 'streak_7', 'xp', v_amt);
      end if;
    end if;
  end if;
  if coalesce(p_activity, false) and v_streak >= 30 then
    v_amt := least(v_set.xp_streak_30_bonus, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, source_day, dedupe_key,
                                    context_kind, context_key)
      values (v_att.organization_id, v_att.user_id, 'streak_30', v_amt, v_day,
              format('streak30:%s:%s:%s', v_att.organization_id, v_att.user_id, v_streak_start),
              v_att.context_kind, v_att.context_key)
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_awards := v_awards || jsonb_build_object('rule', 'streak_30', 'xp', v_amt);
      end if;
    end if;
  end if;

  -- Counters + level (level never demotes). The pass counter now follows the
  -- once-per-course PASS marker (0084), so a granted-retake pass credits it too.
  v_new_completed := v_ug.courses_completed + case when v_completed_event then 1 else 0 end;
  v_new_perfect := v_ug.perfect_scores + case when v_perfect_event then 1 else 0 end;
  v_new_passed := v_ug.assessments_passed + case when v_passed_event then 1 else 0 end;
  v_total := v_ug.total_xp + v_inserted;
  select l.level into v_level from public.gamification_level_for(v_total, v_set.level_thresholds) l;
  v_level := greatest(coalesce(v_level, 1), v_ug.current_level);

  update public.user_gamification set
    total_xp = v_total,
    current_level = v_level,
    current_streak_days = v_streak,
    longest_streak_days = v_longest,
    -- 0107: the activity part only
    last_active_day = case when coalesce(p_activity, false) then v_day else last_active_day end,
    streak_started_day = v_streak_start,
    courses_completed = v_new_completed,
    perfect_scores = v_new_perfect,
    assessments_passed = v_new_passed,
    updated_at = now()
  where organization_id = v_att.organization_id and user_id = v_att.user_id;

  -- Threshold badges from the resolved catalog (org override beats global).
  if v_att.completed_at is not null then
    v_speed_minutes := extract(epoch from (v_att.completed_at - v_att.started_at)) / 60.0;
  end if;
  for v_b in
    select distinct on (slug) slug, criteria_type, threshold
      from public.gamification_badges
     where enabled
       and (organization_id is null or organization_id = v_att.organization_id)
     order by slug, organization_id nulls last
  loop
    v_earn := case v_b.criteria_type
      when 'perfect_score'      then v_new_perfect >= coalesce(v_b.threshold, 1)
      when 'streak_days'        then v_streak >= coalesce(v_b.threshold, 7)
      when 'courses_completed'  then v_new_completed >= coalesce(v_b.threshold, 10)
      when 'assessments_passed' then v_new_passed >= coalesce(v_b.threshold, 5)
      when 'completion_speed'   then v_completed_event and v_speed_minutes is not null
                                     and v_speed_minutes > 0
                                     and v_speed_minutes <= coalesce(v_b.threshold, 30)
      else false
    end;
    if v_earn then
      insert into public.user_badges (organization_id, user_id, badge_slug)
      values (v_att.organization_id, v_att.user_id, v_b.slug)
      on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      if found then
        v_awards := v_awards || jsonb_build_object('badge', v_b.slug);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'awarded_xp', v_inserted, 'streak', v_streak, 'awards', v_awards,
    'scored_attempt', v_scored, 'passed_recorded', v_passed_event);
end;
$$;

comment on function public.gamification_record_activity_core(uuid, boolean, boolean) is
  'The XP engine (ADR 0024 steps 17 and 33): p_activity runs the daily points and the streak, p_rewards the reward candidates of a row the caller established as complete and official in its context; paid keys once per course, a 0-XP event row per context, every row carrying its context. Service role only.';

revoke all on function public.gamification_record_activity_core(uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.gamification_record_activity_core(uuid, boolean, boolean) to service_role;

-- The one-argument form keeps its signature (the 0058 wrapper calls it):
-- both parts, the reward part only when the row is the official attempt of
-- its context (official_attempt_in_context, the one official rule).
create or replace function public.gamification_record_activity_core(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_att record;
begin
  select ca.id, ca.user_id, ca.context_key, cv.course_id
    into v_att
    from public.course_attempts ca
    join public.course_versions cv on cv.id = ca.course_version_id
   where ca.id = p_attempt_id;
  return public.gamification_record_activity_core(
    p_attempt_id,
    true,
    coalesce(v_att.id = public.official_attempt_in_context(v_att.user_id, v_att.course_id, v_att.context_key), false));
end;
$$;

-- The wrapper (from 0058:216-246): no XP for a journey row or a preview
-- (steps 34 and 78; between phases 2 and 3 on staging the old routes call
-- this wrapper directly, and a preview must write no points, daily activity
-- or streak). The membership exemption is removed: being on a journey no
-- longer cancels points, daily activity or the streak for that course
-- elsewhere. Everything else is delegated to the core, as before.
create or replace function public.gamification_record_activity(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_att record;
begin
  select a.context_kind
    into v_att
    from public.course_attempts a
   where a.id = p_attempt_id;
  -- 0107: a journey row and a preview earn nothing here (ADR 0024 step 34)
  if v_att.context_kind = 'journey' then
    return jsonb_build_object('ok', true, 'skipped', 'journey_course');
  end if;
  if v_att.context_kind = 'preview' then
    return jsonb_build_object('ok', true, 'skipped', 'preview');
  end if;
  return public.gamification_record_activity_core(p_attempt_id);
end;
$$;

comment on function public.gamification_record_activity_core(uuid) is
  'The XP engine with both parts, the reward part only for the official attempt of its context (ADR 0024 step 17); the wrapper''s call. Service role only.';
comment on function public.gamification_record_activity(uuid) is
  'XP for an attempt through the core; nothing for a journey row or a preview (ADR 0024 step 34). Service role only.';

revoke all on function public.gamification_record_activity(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity(uuid) to service_role;
revoke all on function public.gamification_record_activity_core(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity_core(uuid) to service_role;

-- 6j. record_learning_activity (step 12; build notes N13 and O1-c, O1-e):
-- the one side-effect writer of a learner's attempt. Security definer,
-- service role only. Two forms: the one-argument form is the routes' call
-- (both branches); the two-argument form with p_activity false runs the
-- completion branch only, for the retry sweep of 6k, which must not pay
-- daily points or move a streak for a day the learner was not active. No
-- argument has a default (a default would make the one-name call ambiguous
-- for PostgREST).
--   1. Load the row. A preview, a revision row or an abandoned row answers
--      {skipped: reason} and nothing is written.
--   2. The activity branch, for a row that is not a journey row and is the
--      context's official candidate (the context has no official attempt,
--      or this row is it, or it is a live granted retake: in progress,
--      neither completed nor passed, named in used_attempt_id by an approved
--      grant, note N9): the daily points and the streak, through the XP core
--      (6i).
--   3. The completion branch, when the row is complete and side_effects_sig
--      is distinct from settle_sig. official = the row is
--      official_attempt_in_context (5a). If official, in this order: the
--      reward candidates (the XP core, not for a journey row: journey rows
--      never reach the core, step 36); for a journey row,
--      journey_record_completion (6h); for a path row, the step facts of
--      build note O1-c (every current step of this learner on this path
--      that satisfies its rule now and has no fact yet; on conflict do
--      nothing) and then, in a statement that starts after them, the path
--      completion of step 14 (a learning_path_completions row when the path
--      has at least one step and every step is done in v_path_step_status;
--      its path_score and steps from v_path_progress and v_path_step_status,
--      on conflict do nothing) with its claim; for an Individual row, its
--      claim when the official attempt is done under the resolved rule
--      (completed, or passed where a pass is required). Then the row is
--      stamped: side_effects_sig = the settle_sig this call read,
--      side_effects_at = now(), and, when the row is not official,
--      webhook_skip_reason = 'not_official' unless a reason is already
--      there. Every inner write is idempotent, so the branch runs again
--      when the settled result changes (cmi5 sends completed, then passed;
--      a SCORM verdict can move from failed to passed). The stamp names the
--      value read, never the column: a result settled after the read stays
--      a candidate.
--   4. The answer: {activity, official, attempt_number, context: {kind,
--      learning_path_id, journey_enrollment_id, journey_day, journey_day_id},
--      done, passed_ever, passed_by_rule, done_recorded_at, xp,
--      journey_credited, journey_completed, path_completed, notices}.
--      attempt_number is the context's completion order under the official
--      rule, practice rows included (the scoring view's attempt_no, note
--      N13), null for a row that is not complete. done: for a path row the
--      step's done in v_path_step_status, read after the facts (O1-c); for
--      a journey row whether the day holds a credit (note N18); for an
--      Individual row whether the context's official attempt is done under
--      the resolved rule. passed_ever, passed_by_rule and done_recorded_at
--      are set for a path row only (O1-e). journey_credited,
--      journey_completed, path_completed and each notice are true or present
--      only when this call made the insert or the transition; a notice is
--      {id, product_kind, instance_id, event_type}, and the route stamps
--      sent_at on its id after the send.
--   5. Any error raises and nothing is written.
-- It takes no row lock of its own on course_attempts before the enrolment:
-- the lock order of consume_grant (the grant, the enrolment, then attempt
-- rows) holds; the stamp is the last write.
create or replace function public.record_learning_activity(p_attempt_id uuid, p_activity boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_att               record;
  v_off               uuid;
  v_complete          boolean;
  v_candidate         boolean;
  v_activity          boolean;
  v_branch            boolean;
  v_official          boolean;
  v_rule              boolean;
  v_xp                jsonb;
  v_jr                jsonb;
  v_pp                record;
  v_passed_ever       boolean;
  v_passed_by_rule    boolean;
  v_done_recorded_at  timestamptz;
  v_notice            uuid;
  v_notices           jsonb := '[]'::jsonb;
  v_journey_credited  boolean := false;
  v_journey_completed boolean := false;
  v_path_completed    boolean := false;
  v_attempt_number    integer;
  v_done              boolean;
begin
  -- 1. the row
  select ca.id, ca.organization_id, ca.user_id, ca.status, ca.completion_status, ca.success_status,
         ca.started_at, ca.completed_at, ca.is_revision, ca.context_kind, ca.context_key,
         ca.learning_path_id, ca.journey_enrollment_id, ca.journey_day, ca.journey_day_id,
         ca.settle_sig, ca.side_effects_sig, cv.course_id
    into v_att
    from public.course_attempts ca
    join public.course_versions cv on cv.id = ca.course_version_id
   where ca.id = p_attempt_id;
  if not found then
    return jsonb_build_object('skipped', 'no_attempt');
  end if;
  if v_att.context_kind = 'preview' then
    return jsonb_build_object('skipped', 'preview');
  end if;
  if v_att.is_revision then
    return jsonb_build_object('skipped', 'revision');
  end if;
  if v_att.status = 'abandoned' then
    return jsonb_build_object('skipped', 'abandoned');
  end if;

  v_complete := v_att.completion_status = 'completed' or v_att.success_status = 'passed';
  v_off := public.official_attempt_in_context(v_att.user_id, v_att.course_id, v_att.context_key);
  v_official := v_complete and coalesce(v_off = v_att.id, false);
  v_candidate := v_off is null
                 or v_off = v_att.id
                 or (v_att.status = 'in_progress'
                     and v_att.completion_status <> 'completed'
                     and v_att.success_status <> 'passed'
                     and exists (
                       select 1 from public.attempt_requests ar
                        where ar.used_attempt_id = v_att.id and ar.status = 'approved'));
  v_activity := coalesce(p_activity, false) and v_candidate and v_att.context_kind <> 'journey';
  v_branch := v_complete and v_att.side_effects_sig is distinct from v_att.settle_sig;

  -- 2 and 3 (the reward candidates): one call of the XP core
  if v_att.context_kind <> 'journey' and (v_activity or (v_branch and v_official)) then
    v_xp := public.gamification_record_activity_core(v_att.id, v_activity, v_branch and v_official);
  end if;

  -- 3. the completion branch
  if v_branch then
    if v_official and v_att.context_kind = 'journey' then
      v_jr := public.journey_record_completion(v_att.id);
      v_journey_credited := coalesce((v_jr ->> 'credited')::boolean, false);
      v_journey_completed := coalesce((v_jr ->> 'yoddha_unlocked')::boolean, false);
      if v_journey_completed then
        -- the claim the core made in this transaction
        v_notice := null;
        select n.id into v_notice
          from public.completion_notices n
         where n.user_id = v_att.user_id
           and n.product_kind = 'journey'
           and n.instance_id = v_att.journey_enrollment_id
           and n.claimed_at = now();
        if v_notice is not null then
          v_notices := v_notices || jsonb_build_object('id', v_notice, 'product_kind', 'journey',
                                                       'instance_id', v_att.journey_enrollment_id,
                                                       'event_type', 'journey_completion');
        end if;
      end if;
    end if;

    if v_official and v_att.context_kind = 'path' then
      -- the step facts (O1-c): written the first time a step satisfies the
      -- rule in force; the view's passed_by_rule is the one rule
      insert into public.learning_path_step_completions
        (organization_id, path_id, course_id, user_id, attempt_id, rule_pass_required)
      select st.organization_id, st.path_id, st.course_id, st.user_id, st.official_attempt_id, st.pass_required
        from public.v_path_step_status st
       where st.path_id = v_att.learning_path_id
         and st.user_id = v_att.user_id
         and st.passed_by_rule
         and st.done_recorded_at is null
      on conflict (path_id, user_id, course_id) do nothing;

      -- the path completion (step 14), read after the facts
      select pp.steps_total, pp.steps_done, pp.path_score, pp.organization_id
        into v_pp
        from public.v_path_progress pp
       where pp.path_id = v_att.learning_path_id
         and pp.user_id = v_att.user_id;
      if found and v_pp.steps_total > 0 and v_pp.steps_done = v_pp.steps_total then
        insert into public.learning_path_completions (organization_id, path_id, user_id, path_score, steps)
        select v_pp.organization_id, v_att.learning_path_id, v_att.user_id, v_pp.path_score,
               coalesce(jsonb_agg(jsonb_build_object('step_number', st.step_number, 'course_id', st.course_id,
                                                     'attempt_id', st.official_attempt_id, 'score', st.latest_score)
                                  order by st.step_number, st.course_id), '[]'::jsonb)
          from public.v_path_step_status st
         where st.path_id = v_att.learning_path_id
           and st.user_id = v_att.user_id
        on conflict (path_id, user_id) do nothing;
        v_path_completed := found;
        if v_path_completed then
          v_notice := null;
          insert into public.completion_notices
            (organization_id, user_id, product_kind, instance_id, attempt_id, event_type, origin)
          values (v_pp.organization_id, v_att.user_id, 'path', v_att.learning_path_id, v_att.id,
                  'path_completion', 'learner')
          on conflict (user_id, product_kind, instance_id) do nothing
          returning id into v_notice;
          if v_notice is not null then
            v_notices := v_notices || jsonb_build_object('id', v_notice, 'product_kind', 'path',
                                                         'instance_id', v_att.learning_path_id,
                                                         'event_type', 'path_completion');
          end if;
        end if;
      end if;
    end if;

    if v_official and v_att.context_kind = 'individual' then
      v_rule := public.instance_pass_required(v_att.course_id, v_att.context_key);
      if not v_rule or v_att.success_status = 'passed' then
        v_notice := null;
        insert into public.completion_notices
          (organization_id, user_id, product_kind, instance_id, attempt_id, event_type, origin)
        values (v_att.organization_id, v_att.user_id, 'individual', v_att.course_id, v_att.id,
                'asset_completion', 'learner')
        on conflict (user_id, product_kind, instance_id) do nothing
        returning id into v_notice;
        if v_notice is not null then
          v_notices := v_notices || jsonb_build_object('id', v_notice, 'product_kind', 'individual',
                                                       'instance_id', v_att.course_id,
                                                       'event_type', 'asset_completion');
        end if;
      end if;
    end if;

    -- the stamp: the value this call read
    update public.course_attempts ca
       set side_effects_sig = v_att.settle_sig,
           side_effects_at = now(),
           webhook_skip_reason = case when v_official then ca.webhook_skip_reason
                                      else coalesce(ca.webhook_skip_reason, 'not_official') end
     where ca.id = v_att.id;
  end if;

  -- 4. the answer
  if v_complete then
    -- the scoring view's attempt_no (note N13): its ordering and its filter
    select count(*) into v_attempt_number
      from public.course_attempts ca2
      join public.course_versions cv2 on cv2.id = ca2.course_version_id
     where cv2.course_id = v_att.course_id
       and ca2.user_id = v_att.user_id
       and ca2.context_key = v_att.context_key
       and not ca2.is_revision
       and ca2.context_kind <> 'preview'
       and ca2.status <> 'abandoned'
       and (ca2.completion_status = 'completed' or ca2.success_status = 'passed')
       and (coalesce(ca2.completed_at, ca2.started_at), ca2.started_at, ca2.id)
           <= (coalesce(v_att.completed_at, v_att.started_at), v_att.started_at, v_att.id);
  end if;

  if v_att.context_kind = 'path' then
    select st.done, st.passed_ever, st.passed_by_rule, st.done_recorded_at
      into v_done, v_passed_ever, v_passed_by_rule, v_done_recorded_at
      from public.v_path_step_status st
     where st.path_id = v_att.learning_path_id
       and st.user_id = v_att.user_id
       and st.course_id = v_att.course_id;
    v_done := coalesce(v_done, false);
    v_passed_ever := coalesce(v_passed_ever, false);
    v_passed_by_rule := coalesce(v_passed_by_rule, false);
  elsif v_att.context_kind = 'journey' then
    v_done := exists (
      select 1 from public.journey_day_progress p
       where p.enrollment_id = v_att.journey_enrollment_id
         and p.day_id = v_att.journey_day_id);
  else
    v_rule := public.instance_pass_required(v_att.course_id, v_att.context_key);
    v_done := v_off is not null
              and (not v_rule
                   or exists (select 1 from public.course_attempts o
                               where o.id = v_off and o.success_status = 'passed'));
  end if;

  return jsonb_build_object(
    'activity',          v_activity,
    'official',          v_official,
    'attempt_number',    v_attempt_number,
    'context',           jsonb_build_object('kind', v_att.context_kind,
                                            'learning_path_id', v_att.learning_path_id,
                                            'journey_enrollment_id', v_att.journey_enrollment_id,
                                            'journey_day', v_att.journey_day,
                                            'journey_day_id', v_att.journey_day_id),
    'done',              v_done,
    'passed_ever',       v_passed_ever,
    'passed_by_rule',    v_passed_by_rule,
    'done_recorded_at',  v_done_recorded_at,
    'xp',                v_xp,
    'journey_credited',  v_journey_credited,
    'journey_completed', v_journey_completed,
    'path_completed',    v_path_completed,
    'notices',           v_notices);
end
$$;

comment on function public.record_learning_activity(uuid, boolean) is
  'The side-effect writer of a learner''s attempt (ADR 0024 step 12); p_activity false runs the completion branch only (the retry sweep). Service role only.';

revoke execute on function public.record_learning_activity(uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_learning_activity(uuid, boolean) to service_role;

create or replace function public.record_learning_activity(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return public.record_learning_activity(p_attempt_id, true);
end
$$;

comment on function public.record_learning_activity(uuid) is
  'The one side-effect writer of a learner''s attempt, both branches (ADR 0024 step 12): the activity branch (daily points, streak) and the completion branch (rewards, the journey credit and completion, the path step facts and completion, the completion claim, the stamp). Service role only.';

revoke execute on function public.record_learning_activity(uuid) from public, anon, authenticated;
grant execute on function public.record_learning_activity(uuid) to service_role;

-- 6k. sweep_completion_side_effects (step 16): the retry of the fail-closed
-- writer. It re-runs the completion branch (record_learning_activity with
-- p_activity false) for at most p_limit rows that are complete, not
-- revision rows, not previews, not abandoned, whose side_effects_sig is
-- distinct from settle_sig, and whose last change is older than two minutes
-- (the latest of started_at, completed_at and last_activity_at, so a route's
-- own writer call is not raced), oldest first. Each row runs in its own
-- exception block, so one failing row cannot stop the batch. The answer:
-- {candidates, handled, failed, errors}, errors being at most five
-- {attempt_id, sqlstate} (ids and codes only). p_limit below 1 or null
-- raises 22023. Rows stamped by the 0107 backfill are never candidates
-- (history). The two refresh functions call it (6m).
create or replace function public.sweep_completion_side_effects(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r         record;
  v_found   integer := 0;
  v_handled integer := 0;
  v_failed  integer := 0;
  v_errors  jsonb := '[]'::jsonb;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'sweep_completion_side_effects: p_limit must be 1 or more (ADR 0024)'
      using errcode = '22023';
  end if;

  for r in
    select ca.id
      from public.course_attempts ca
     where (ca.completion_status = 'completed' or ca.success_status = 'passed')
       and not ca.is_revision
       and ca.context_kind <> 'preview'
       and ca.status <> 'abandoned'
       and ca.side_effects_sig is distinct from ca.settle_sig
       and greatest(ca.started_at, ca.completed_at, ca.last_activity_at) < now() - interval '2 minutes'
     order by greatest(ca.started_at, ca.completed_at, ca.last_activity_at), ca.id
     limit p_limit
  loop
    v_found := v_found + 1;
    begin
      perform public.record_learning_activity(r.id, false);
      v_handled := v_handled + 1;
    exception when others then
      v_failed := v_failed + 1;
      if jsonb_array_length(v_errors) < 5 then
        v_errors := v_errors || jsonb_build_object('attempt_id', r.id, 'sqlstate', sqlstate);
      end if;
    end;
  end loop;

  return jsonb_build_object('candidates', v_found, 'handled', v_handled, 'failed', v_failed, 'errors', v_errors);
end
$$;

comment on function public.sweep_completion_side_effects(integer) is
  'The retry of the completion writer (ADR 0024 step 16): the completion branch for complete official-rule rows not yet handled and older than two minutes, each in its own exception block; answers {candidates, handled, failed, errors}. Service role only.';

revoke execute on function public.sweep_completion_side_effects(integer) from public, anon, authenticated;
grant execute on function public.sweep_completion_side_effects(integer) to service_role;

-- 6l. purge_preview_data (steps 79 and 81; the owner's R7, A36 and third
-- message of 2026-11-13): the one deletion of Preview data, started only by
-- a person. Nothing calls it on a schedule: no refresh function, no cron
-- route, no restore step (step 81). Security definer, service role only;
-- p_expect_hash is the one argument with a default (a dry run needs none).
--   Arguments. p_org and p_actor are never null; p_reason is manual or
--   product_delete; p_dry_run is true or false; p_scope is a JSON object of
--   exactly one of these shapes: {"attempt_id"}, {"run_id"}, {"user_id"},
--   one product key ({"course_id"}, {"learning_path_id"} or
--   {"journey_program_id"}), {"organization": true}, or user_id with one of
--   attempt_id, run_id or a product key; every id a uuid string. Anything
--   else (an unknown key, an empty object, a null, a key with a null value,
--   two product keys, a list) raises 22023 and deletes nothing, and so do
--   reason product_delete without exactly one product key and a real call
--   with a null p_expect_hash.
--   Selection. Preview attempts of the three new kinds only
--   (context_kind preview and preview_kind in course, path_run,
--   journey_run), in p_org, narrowed by the scope with and; a path or a
--   program scope reaches the attempts of its test runs, a course scope
--   every new-kind preview on the course's versions. No scope names a
--   legacy_role row or an age. The same predicate is repeated in the
--   delete itself.
--   Isolation. A selected attempt that a row of xp_events,
--   journey_day_progress, completion_notices, learning_path_completions
--   (its steps' attempt_id), learning_path_step_completions,
--   attempt_requests (used_attempt_id) or revision_visits points at is
--   never deleted: it is set aside with the tables that point at it, its
--   test run stays, the rest is deleted, and the answer and the audit row
--   carry it under excluded.
--   Test runs. A run is deleted when the scope names it (run_id), when the
--   scope covers it (its tester, its path, its program, the organisation),
--   or when this call deletes its last attempt, and never while an attempt
--   of it stays. A course or an attempt scope covers no run.
--   Dry run. Writes nothing, no audit row either, and answers the counts
--   per table (attempts, test runs, statements, State rows, launch tokens,
--   sessions, outbox rows) with their total, the number excluded with their
--   ids and tables, and selection_hash: sha256 over two sorted id lists,
--   each under its own label, the attempts and test runs the call would
--   delete and the attempts it would set aside.
--   Real call. The selection's own hash must equal p_expect_hash, else it
--   raises 40001 (the selection changed since the dry run; the dry run is
--   run again) and deletes nothing. Then the outbox rows of the deleted
--   attempts (they have no foreign key), the attempts (statements, State,
--   tokens and sessions go by cascade), then the runs; it asserts that the
--   attempts deleted equal the attempts selected less those set aside, and
--   raises otherwise, which rolls the whole call back. One preview_purge_log
--   row for every call that deleted or set aside anything, in the same
--   transaction: who, when, why, the scope, the counts and the ids.
create or replace function public.purge_preview_data(
  p_org uuid,
  p_scope jsonb,
  p_reason text,
  p_actor uuid,
  p_dry_run boolean,
  p_expect_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_keys     text[];
  v_narrow   integer;
  k          text;
  v_attempt  uuid;
  v_run      uuid;
  v_user     uuid;
  v_course   uuid;
  v_path     uuid;
  v_program  uuid;
  v_org_all  boolean;
  v_sel      uuid[];
  v_excl     jsonb;
  v_excl_ids uuid[];
  v_del      uuid[];
  v_runs     uuid[];
  v_hash     text;
  v_counts   jsonb;
  v_n        integer;
  v_log      uuid;
begin
  -- 1. the arguments
  if p_org is null then
    raise exception 'purge_preview_data: p_org is required (ADR 0024)' using errcode = '22023';
  end if;
  if p_actor is null then
    raise exception 'purge_preview_data: p_actor is required (ADR 0024)' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('manual', 'product_delete') then
    raise exception 'purge_preview_data: the reason is manual or product_delete (ADR 0024)' using errcode = '22023';
  end if;
  if p_dry_run is null then
    raise exception 'purge_preview_data: p_dry_run is true or false (ADR 0024)' using errcode = '22023';
  end if;
  if not p_dry_run and p_expect_hash is null then
    raise exception 'purge_preview_data: a real call needs the selection_hash of its dry run (ADR 0024)'
      using errcode = '22023';
  end if;
  if p_scope is null or jsonb_typeof(p_scope) is distinct from 'object' then
    raise exception 'purge_preview_data: the scope is a JSON object (ADR 0024)' using errcode = '22023';
  end if;
  select coalesce(array_agg(j.key order by j.key), '{}'::text[]) into v_keys
    from jsonb_object_keys(p_scope) as j(key);
  if cardinality(v_keys) = 0 then
    raise exception 'purge_preview_data: the scope is empty (ADR 0024)' using errcode = '22023';
  end if;
  foreach k in array v_keys loop
    if k not in ('attempt_id', 'run_id', 'user_id', 'course_id', 'learning_path_id', 'journey_program_id',
                 'organization') then
      raise exception 'purge_preview_data: unknown scope key % (ADR 0024)', k using errcode = '22023';
    end if;
    if k = 'organization' then
      if p_scope -> k is distinct from 'true'::jsonb then
        raise exception 'purge_preview_data: organization must be true (ADR 0024)' using errcode = '22023';
      end if;
    elsif jsonb_typeof(p_scope -> k) is distinct from 'string' or (p_scope ->> k) !~ c_uuid then
      raise exception 'purge_preview_data: the scope key % needs one uuid (ADR 0024)', k using errcode = '22023';
    end if;
  end loop;
  select count(*) into v_narrow from unnest(v_keys) as u(key) where u.key <> 'user_id';
  if v_narrow > 1 or ('organization' = any(v_keys) and cardinality(v_keys) > 1) then
    raise exception 'purge_preview_data: the scope names one of attempt_id, run_id, a product or the organisation, with user_id at most (ADR 0024)'
      using errcode = '22023';
  end if;
  if p_reason = 'product_delete'
     and not (cardinality(v_keys) = 1 and v_keys[1] in ('course_id', 'learning_path_id', 'journey_program_id')) then
    raise exception 'purge_preview_data: reason product_delete needs exactly one product key (ADR 0024)'
      using errcode = '22023';
  end if;
  v_attempt := (p_scope ->> 'attempt_id')::uuid;
  v_run     := (p_scope ->> 'run_id')::uuid;
  v_user    := (p_scope ->> 'user_id')::uuid;
  v_course  := (p_scope ->> 'course_id')::uuid;
  v_path    := (p_scope ->> 'learning_path_id')::uuid;
  v_program := (p_scope ->> 'journey_program_id')::uuid;
  v_org_all := p_scope ? 'organization';

  -- 2. the selection: preview attempts of the three new kinds, in p_org,
  -- narrowed by the scope
  select coalesce(array_agg(ca.id order by ca.id), '{}'::uuid[]) into v_sel
    from public.course_attempts ca
    join public.course_versions cv on cv.id = ca.course_version_id
    left join public.preview_runs pr on pr.id = ca.preview_run_id
   where ca.organization_id = p_org
     and ca.context_kind = 'preview'
     and ca.preview_kind in ('course', 'path_run', 'journey_run')
     and (v_attempt is null or ca.id = v_attempt)
     and (v_run is null or ca.preview_run_id = v_run)
     and (v_user is null or ca.user_id = v_user)
     and (v_course is null or cv.course_id = v_course)
     and (v_path is null or pr.learning_path_id = v_path)
     and (v_program is null or pr.journey_program_id = v_program);

  -- 3. the isolation check: an attempt an official row points at is set aside
  with ptr as (
    select e.attempt_id, 'xp_events'::text as tbl
      from public.xp_events e where e.attempt_id = any(v_sel)
    union all
    select p.attempt_id, 'journey_day_progress'
      from public.journey_day_progress p where p.attempt_id = any(v_sel)
    union all
    select n.attempt_id, 'completion_notices'
      from public.completion_notices n where n.attempt_id = any(v_sel)
    union all
    select (s.e ->> 'attempt_id')::uuid, 'learning_path_completions'
      from public.learning_path_completions lc
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(lc.steps) = 'array' then lc.steps else '[]'::jsonb end) as s(e)
     where (s.e ->> 'attempt_id') = any(v_sel::text[])
    union all
    select f.attempt_id, 'learning_path_step_completions'
      from public.learning_path_step_completions f where f.attempt_id = any(v_sel)
    union all
    select ar.used_attempt_id, 'attempt_requests'
      from public.attempt_requests ar where ar.used_attempt_id = any(v_sel)
    union all
    select v.attempt_id, 'revision_visits'
      from public.revision_visits v where v.attempt_id = any(v_sel)
  ),
  g as (
    select ptr.attempt_id, array_agg(distinct ptr.tbl order by ptr.tbl) as tables
      from ptr
     group by ptr.attempt_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('attempt_id', g.attempt_id, 'tables', to_jsonb(g.tables))
                            order by g.attempt_id), '[]'::jsonb),
         coalesce(array_agg(g.attempt_id order by g.attempt_id), '{}'::uuid[])
    into v_excl, v_excl_ids
    from g;

  v_del := array(select s.id from unnest(v_sel) as s(id) where s.id <> all(v_excl_ids) order by s.id);

  -- 4. the test runs: named, covered or emptied by this call, and never one
  -- that keeps an attempt
  select coalesce(array_agg(pr.id order by pr.id), '{}'::uuid[]) into v_runs
    from public.preview_runs pr
   where pr.organization_id = p_org
     and (
       -- named or covered by the scope
       (v_attempt is null and v_course is null
        and (v_user is null or pr.user_id = v_user)
        and (v_run is null or pr.id = v_run)
        and (v_path is null or pr.learning_path_id = v_path)
        and (v_program is null or pr.journey_program_id = v_program))
       -- emptied by this call
       or exists (select 1 from public.course_attempts ca where ca.preview_run_id = pr.id and ca.id = any(v_del))
     )
     and not exists (
       select 1 from public.course_attempts ca where ca.preview_run_id = pr.id and ca.id <> all(v_del));

  -- 5. the hash and the counts
  v_hash := encode(sha256(convert_to(
              'delete:' || coalesce((select string_agg(x.v, ',' order by x.v)
                                       from (select 'attempt:' || d::text as v from unnest(v_del) as d
                                             union all
                                             select 'run:' || r::text from unnest(v_runs) as r) x), '')
              || '|set_aside:' || coalesce(array_to_string(v_excl_ids, ','), ''),
              'UTF8')), 'hex');

  select jsonb_build_object(
           'attempts',      cardinality(v_del),
           'test_runs',     cardinality(v_runs),
           'statements',    c.statements,
           'state',         c.state,
           'launch_tokens', c.launch_tokens,
           'sessions',      c.sessions,
           'outbox',        c.outbox,
           'total',         cardinality(v_del) + cardinality(v_runs)
                            + c.statements + c.state + c.launch_tokens + c.sessions + c.outbox)
    into v_counts
    from (select (select count(*) from public.xapi_statements s where s.attempt_id = any(v_del))::integer as statements,
                 (select count(*) from public.xapi_state s where s.attempt_id = any(v_del))::integer as state,
                 (select count(*) from public.cmi5_launch_tokens t where t.attempt_id = any(v_del))::integer
                   as launch_tokens,
                 (select count(*) from public.learning_sessions l where l.attempt_id = any(v_del))::integer
                   as sessions,
                 (select count(*) from public.lrs_forward_outbox o where o.attempt_id = any(v_del))::integer
                   as outbox) c;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'reason', p_reason, 'scope', p_scope, 'counts', v_counts,
                              'excluded', cardinality(v_excl_ids), 'excluded_attempts', v_excl,
                              'selection_hash', v_hash);
  end if;

  -- 6. the real call: the dry run's selection, or nothing
  if p_expect_hash <> v_hash then
    raise exception 'purge_preview_data: the selection changed since the dry run; nothing was deleted (ADR 0024)'
      using errcode = '40001';
  end if;

  delete from public.lrs_forward_outbox o where o.attempt_id = any(v_del);

  with d as (
    delete from public.course_attempts ca
     where ca.id = any(v_del)
       and ca.organization_id = p_org
       and ca.context_kind = 'preview'
       and ca.preview_kind in ('course', 'path_run', 'journey_run')
    returning 1
  )
  select count(*) into v_n from d;
  if v_n <> cardinality(v_sel) - cardinality(v_excl_ids) then
    raise exception 'purge_preview_data: % attempt(s) deleted, % expected; nothing was deleted (ADR 0024)',
      v_n, cardinality(v_sel) - cardinality(v_excl_ids)
      using errcode = 'P0001';
  end if;

  delete from public.preview_runs pr
   where pr.id = any(v_runs)
     and pr.organization_id = p_org;

  -- 7. the audit row, for every call that deleted or set aside anything
  if cardinality(v_del) + cardinality(v_runs) + cardinality(v_excl_ids) > 0 then
    insert into public.preview_purge_log
      (organization_id, reason, actor_user_id, scope, counts, attempt_ids, run_ids, excluded)
    values
      (p_org, p_reason, p_actor, p_scope, v_counts, v_del, v_runs, v_excl)
    returning id into v_log;
  end if;

  return jsonb_build_object('dry_run', false, 'reason', p_reason, 'scope', p_scope, 'counts', v_counts,
                            'excluded', cardinality(v_excl_ids), 'excluded_attempts', v_excl,
                            'selection_hash', v_hash, 'log_id', v_log);
end
$$;

comment on function public.purge_preview_data(uuid, jsonb, text, uuid, boolean, text) is
  'The one deletion of Preview data, started by a person (ADR 0024 steps 79 and 81): preview attempts of the kinds course, path_run and journey_run (never legacy_role) in one organisation and scope, with their test runs; a dry run answers the counts and selection_hash, a real call must carry that hash; set-aside attempts are never deleted; one preview_purge_log row per deletion. Nothing calls it on a schedule. Service role only.';

revoke execute on function public.purge_preview_data(uuid, jsonb, text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.purge_preview_data(uuid, jsonb, text, uuid, boolean, text) to service_role;

-- 6m. The two refresh functions (step 16): recreated from their latest
-- bodies, refresh_report_views() from 0035:82-124 (its privileges from
-- 0049:54 and :59) and refresh_gamification_views() from 0056:179-206, with
-- these changes and nothing else: the pinned search_path of section B's
-- header; the completion sweep (6k) runs first, inside an exception block of
-- its own, so the matviews refreshed after it read the points and the
-- completions it wrote; and its answer is appended as the last entry,
-- {view: 'completion_sweep', ms, rows, error, sweep}, so every view entry
-- keeps its place. rows is the number of rows the sweep handled; error is
-- the sweep's own error, null when it ran (a row that fails is counted in
-- sweep.failed, step 16, and is not an error of the refresh); sweep is its
-- answer, or null when it raised. Each call handles at most 200 rows (the
-- record names no limit; the next call takes the rest, oldest first).
-- Neither function calls purge_preview_data: nothing deletes Preview data on
-- a schedule (step 81). The matview lists are unchanged; 0109 recreates both
-- functions again with its own (step 21).
create or replace function public.refresh_report_views()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb := '[]'::jsonb;
  view_name text;
  t0 timestamptz;
  rowcount bigint;
  ms numeric;
  err text;
  sweep jsonb;
  sweep_ms numeric;
  sweep_err text;
begin
  -- 0107: the completion sweep first (ADR 0024 step 16)
  t0 := clock_timestamp();
  begin
    sweep := public.sweep_completion_side_effects(200);
  exception when others then
    sweep_err := sqlerrm;
  end;
  sweep_ms := extract(milliseconds from (clock_timestamp() - t0));

  foreach view_name in array array[
    'mv_course_enrollment_status',
    'mv_path_enrollment_status',
    'mv_course_performance',
    'mv_path_performance',
    'mv_course_interaction_breakdown',
    'mv_course_interaction_top_wrong'
  ]
  loop
    t0 := clock_timestamp();
    err := null;
    rowcount := null;
    begin
      execute format('refresh materialized view concurrently public.%I', view_name);
      execute format('select count(*) from public.%I', view_name) into rowcount;
    exception when others then
      err := sqlerrm;
    end;
    ms := extract(milliseconds from (clock_timestamp() - t0));
    result := result || jsonb_build_object(
      'view', view_name,
      'ms', ms,
      'rows', rowcount,
      'error', err
    );
  end loop;

  -- 0107: the sweep's entry, last
  result := result || jsonb_build_object(
    'view', 'completion_sweep',
    'ms', sweep_ms,
    'rows', (sweep ->> 'handled')::bigint,
    'error', sweep_err,
    'sweep', sweep
  );
  return result;
end;
$$;

comment on function public.refresh_report_views() is
  'Refreshes the six report matviews, each in its own exception block, after one run of the completion sweep (ADR 0024 step 16), whose answer is the last entry, completion_sweep. Never deletes Preview data. Service role only.';

revoke execute on function public.refresh_report_views() from public, anon, authenticated;
grant execute on function public.refresh_report_views() to service_role;

create or replace function public.refresh_gamification_views()
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  view_name text;
  t0 timestamptz;
  ms numeric;
  rowcount bigint;
  err text;
  result jsonb := '[]'::jsonb;
  sweep jsonb;
  sweep_ms numeric;
  sweep_err text;
begin
  -- 0107: the completion sweep first (ADR 0024 step 16)
  t0 := clock_timestamp();
  begin
    sweep := public.sweep_completion_side_effects(200);
  exception when others then
    sweep_err := sqlerrm;
  end;
  sweep_ms := extract(milliseconds from (clock_timestamp() - t0));

  foreach view_name in array array['mv_leaderboard', 'mv_learner_metrics']
  loop
    t0 := clock_timestamp(); err := null; rowcount := null;
    begin
      execute format('refresh materialized view concurrently public.%I', view_name);
      execute format('select count(*) from public.%I', view_name) into rowcount;
    exception when others then
      err := sqlerrm;
    end;
    ms := extract(milliseconds from (clock_timestamp() - t0));
    result := result || jsonb_build_object('view', view_name, 'ms', ms, 'rows', rowcount, 'error', err);
  end loop;

  -- 0107: the sweep's entry, last
  result := result || jsonb_build_object('view', 'completion_sweep', 'ms', sweep_ms,
                                         'rows', (sweep ->> 'handled')::bigint, 'error', sweep_err,
                                         'sweep', sweep);
  return result;
end;
$$;

comment on function public.refresh_gamification_views() is
  'Refreshes mv_leaderboard and mv_learner_metrics, each in its own exception block, after one run of the completion sweep (ADR 0024 step 16), whose answer is the last entry, completion_sweep. Never deletes Preview data. Service role only.';

revoke all on function public.refresh_gamification_views() from public, anon, authenticated;
grant execute on function public.refresh_gamification_views() to service_role;

-- 6n. gamification_close_month (steps 17 and 35): recreated from the whole
-- of its latest body, 0073:824-1022 (grants :1023-1024; never from 0053),
-- with two changes and nothing else: the pinned search_path, and the
-- highest_scorer chain (0073:905-939), which decided the official attempts
-- per (learner, course) by its own window over every row, abandoned,
-- revision and preview rows included (ADR 0024 "What the code does today",
-- row 1). It now reads the per-context summary over the Individual and path
-- contexts (step 35): the average of the official scores
-- (v_context_attempt_summary.official_score, one per course and context)
-- whose official attempt was completed in the month. So a practice row, a
-- revision row, an abandoned row, a preview and a journey row never count,
-- and the window logic exists once, in the scoring view (step 9). Every
-- other category is the 0073 logic as it stands.
create or replace function public.gamification_close_month()
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org record;
  v_period text;
  v_start timestamptz;
  v_end timestamptz;
  v_row record;
  v_written integer := 0;
  v_result jsonb := '[]'::jsonb;
begin
  for v_org in
    select gs.organization_id, gs.timezone, gs.allow_opt_out
      from public.gamification_settings gs
     where gs.enabled
  loop
    v_period := to_char(((now() at time zone v_org.timezone)::date - interval '1 month'), 'YYYY-MM');
    v_start := date_trunc('month', (now() at time zone v_org.timezone)::date - interval '1 month')::timestamp
               at time zone v_org.timezone;
    v_end := (date_trunc('month', (now() at time zone v_org.timezone)::date - interval '1 month')
              + interval '1 month')::timestamp at time zone v_org.timezone;

    -- top_overall (+ monthly badges for its winners).
    v_written := 0;
    for v_row in
      select e.user_id, sum(e.xp) as metric,
             row_number() over (order by sum(e.xp) desc, min(e.created_at) asc, e.user_id) as rn
        from public.xp_events e
        join public.user_gamification ug
          on ug.organization_id = e.organization_id and ug.user_id = e.user_id
       where e.organization_id = v_org.organization_id
         and e.created_at >= v_start and e.created_at < v_end
         and not (ug.opted_out and v_org.allow_opt_out)
       group by e.user_id
       order by 2 desc, e.user_id
       limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'top_overall', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'xp', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
      if found then v_written := v_written + 1; end if;

      insert into public.user_badges (organization_id, user_id, badge_slug, period, metadata)
      values (v_org.organization_id, v_row.user_id, 'top_3', v_period,
              jsonb_build_object('rank', v_row.rn))
      on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      if v_row.rn = 1 then
        insert into public.user_badges (organization_id, user_id, badge_slug, period)
        values (v_org.organization_id, v_row.user_id, 'learning_champion', v_period)
        on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      end if;
    end loop;

    -- most_active: distinct active days in the month.
    for v_row in
      select e.user_id, count(distinct e.source_day) as metric,
             row_number() over (order by count(distinct e.source_day) desc, e.user_id) as rn
        from public.xp_events e
        join public.user_gamification ug
          on ug.organization_id = e.organization_id and ug.user_id = e.user_id
       where e.organization_id = v_org.organization_id and e.rule = 'daily_activity'
         and e.created_at >= v_start and e.created_at < v_end
         and not (ug.opted_out and v_org.allow_opt_out)
       group by e.user_id order by 2 desc, e.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'most_active', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'active_days', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- highest_scorer (0107, ADR 0024 step 35): the average official score of
    -- the learner's Individual and path contexts whose official attempt was
    -- completed in the month, read from the per-context summary (one row
    -- per course and context; the official rule of step 9).
    for v_row in
      select s.user_id, avg(s.official_score) as metric,
             row_number() over (order by avg(s.official_score) desc, s.user_id) as rn
        from public.v_context_attempt_summary s
        join public.course_attempts ca on ca.id = s.official_attempt_id
        join public.user_gamification ug
          on ug.organization_id = v_org.organization_id and ug.user_id = s.user_id
       where ca.organization_id = v_org.organization_id
         and s.context_kind in ('individual', 'path')
         and ca.completed_at >= v_start and ca.completed_at < v_end
         and s.official_score is not null
         and not (ug.opted_out and v_org.allow_opt_out)
       group by s.user_id order by 2 desc, s.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'highest_scorer', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'avg_score', round(v_row.metric * 100))
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- most_improved: month XP vs previous month XP (qualifier: prev >= 50).
    for v_row in
      with month_xp as (
        select e.user_id,
          sum(e.xp) filter (where e.created_at >= v_start and e.created_at < v_end) as cur_xp,
          sum(e.xp) filter (where e.created_at >= v_start - interval '1 month'
                              and e.created_at < v_start) as prev_xp
          from public.xp_events e
          join public.user_gamification ug
            on ug.organization_id = e.organization_id and ug.user_id = e.user_id
         where e.organization_id = v_org.organization_id
           and e.created_at >= v_start - interval '1 month' and e.created_at < v_end
           and not (ug.opted_out and v_org.allow_opt_out)
         group by e.user_id
      )
      select user_id, (coalesce(cur_xp,0) - coalesce(prev_xp,0)) as metric,
             row_number() over (order by (coalesce(cur_xp,0) - coalesce(prev_xp,0)) desc, user_id) as rn
        from month_xp
       where coalesce(prev_xp, 0) >= 50
       order by 2 desc, user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'most_improved', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'xp_gain', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
      if v_row.rn = 1 then
        insert into public.user_badges (organization_id, user_id, badge_slug, period)
        values (v_org.organization_id, v_row.user_id, 'most_improved', v_period)
        on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      end if;
    end loop;

    -- longest_streak: streak state as of close (v1 approximation, documented).
    for v_row in
      select ug.user_id, ug.current_streak_days as metric,
             row_number() over (order by ug.current_streak_days desc, ug.longest_streak_days desc, ug.user_id) as rn
        from public.user_gamification ug
       where ug.organization_id = v_org.organization_id
         and ug.current_streak_days > 0
         and not (ug.opted_out and v_org.allow_opt_out)
       order by ug.current_streak_days desc, ug.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'longest_streak', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'streak_days', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- team_top: month XP summed per team.
    for v_row in
      select t.id as team_id, t.name as team_name, sum(e.xp) as metric,
             row_number() over (order by sum(e.xp) desc, t.id) as rn
        from public.teams t
        join public.team_members tm on tm.team_id = t.id
        join public.xp_events e
          on e.user_id = tm.user_id and e.organization_id = t.organization_id
       where t.organization_id = v_org.organization_id
         and e.created_at >= v_start and e.created_at < v_end
       group by t.id, t.name order by 3 desc, t.id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, team_id, metric_value, snapshot)
      values (v_org.organization_id, v_period, 'team_top', v_row.rn, v_row.team_id, v_row.metric,
              jsonb_build_object('team_name', v_row.team_name, 'xp', v_row.metric))
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    v_result := v_result || jsonb_build_object(
      'organization_id', v_org.organization_id, 'period', v_period, 'written', v_written);
  end loop;

  return v_result;
end;
$$;
revoke all on function public.gamification_close_month() from public, anon, authenticated;
grant execute on function public.gamification_close_month() to service_role;

-- 6o. journey_auto_enroll (step 8; decisions D15 and D17): recreated from
-- its latest body, 0096:158-186, with two changes and nothing else: the
-- pinned search_path, and the enrolment it inserts names source =
-- 'audience', so an audience enrolment is told from an admin's and a
-- self-enrolment (journey_enrollments.source, section 1r). The trigger
-- organization_members_journey_enroll (0063:101-104) stays bound: this is
-- create or replace. Its execute is revoked from the API roles, as every
-- function of this file (section B's header); a trigger's function is not
-- checked for execute when the trigger fires.
create or replace function public.journey_auto_enroll()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_prog record;
  v_tz text;
begin
  select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
    from public.gamification_settings gs
   where gs.organization_id = new.organization_id;
  for v_prog in
    select id, current_version_id
      from public.journey_programs
     where organization_id = new.organization_id
       and is_active and auto_enroll_new_users
       and current_version_id is not null
       and public.journey_audience_matches(
             audience, new.designation, new.job_role, new.city,
             new.business_vertical, new.branch, new.department)
  loop
    insert into public.journey_enrollments
      (program_id, version_id, organization_id, user_id, start_date, enrolled_by, source)
    values
      (v_prog.id, v_prog.current_version_id, new.organization_id, new.user_id,
       (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date, null, 'audience')
    on conflict do nothing;
  end loop;
  return new;
end;
$$;

comment on function public.journey_auto_enroll() is
  'Trigger on organization_members: enrols a new member on every active auto-enrol journey whose audience matches, with source audience (0096; ADR 0024 step 8).';

revoke execute on function public.journey_auto_enroll() from public, anon, authenticated;
grant execute on function public.journey_auto_enroll() to service_role;

-- 6p. launch_context (step 18; build note N15; twins contract B7, A10): the
-- facts the launch's pure resolver needs (step 22), in one call, for the
-- subrequest budget (step 70). Facts only: it decides nothing. Created last
-- among the objects of this file, after the path views it reads. Stable,
-- plpgsql, security definer, service role only; the page passes the
-- session's user id and asserts the organisation. Every read is filtered by
-- p_org and p_user, because a definer reads past row-level security.
-- The answer is the frozen key tree of note N15 (the rehearsal compares it
-- as jsonb, which ignores key order and not array order):
--   v             1
--   member        {active}: an organization_members row of p_org with
--                 status active
--   course        {found, is_active, visibility, individual {enrolled,
--                 upcoming_at}}; found is the course in p_org; enrolled is a
--                 released direct enrolment (v_course_enrollments_expanded);
--                 upcoming_at the earliest future release_at among the
--                 direct assignments that reach the learner (the four arms
--                 of that view), null when none
--   path          null without p_path; else {found, is_active, visibility,
--                 sequence_mode, enrolled, self_row, course_step, steps[]};
--                 found is the path in p_org; enrolled a recorded enrolment
--                 (v_path_enrollments_expanded); self_row a user row with
--                 source self; course_step p_course's step_number, null when
--                 it is not a step; steps[] {course_id, step_number,
--                 release_at, done} by step_number, done from
--                 v_path_step_status (false when the learner has no row)
--   journey       null without p_enrollment; else {found, status,
--                 program_id, program_is_active, start_date, version_id,
--                 unlock_mode, count_sundays, days_total, timezone, day,
--                 day_credit, day_open_attempt, required_days,
--                 credited_days, next_day, next_day_id, resumable_day_ids};
--                 found is the enrolment in p_org and p_user's; the version
--                 facts are the pinned version's; timezone is
--                 gamification_settings.timezone, default Asia/Kolkata
--                 (0089:92-95). day {id, number, in_version, removed,
--                 course_id}: id is p_day_id, else p_day resolved through the
--                 pinned version's day_ids (an old link, step 93), null when
--                 neither resolves; number its number in the pinned version
--                 and in_version whether it has one; removed whether the
--                 program's journey_days row is removed (false for a day of
--                 another program); course_id the course the pinned version
--                 holds that day (its first entry), null on a rest day or
--                 outside the version. day_credit {course_id, attempt_id,
--                 credit_kind, day_number} of that day's credit, null when
--                 none. day_open_attempt {attempt_id, course_id}: an open
--                 official journey attempt on that day (in progress, not a
--                 revision row), the one of p_course first, then the oldest;
--                 null when none. The counts, next_day, next_day_id and
--                 resumable_day_ids (ascending uuid) are journey_credit_state's
--                 (5d).
--   holders       {paths[], journey_days[]}: paths [{path_id, step_number}]
--                 by path_id, the active paths of p_org that hold p_course
--                 and the learner is enrolled on; journey_days [{enrollment_id,
--                 day_id, day_number, credited}] by enrollment_id, then
--                 day_number, the required days (5d's definition) that hold
--                 p_course in the pinned versions of the learner's active
--                 enrolments of p_org
--   run           null, reserved for phase P
-- found: false carries no other key. Arrays are always present.
create or replace function public.launch_context(
  p_user uuid,
  p_org uuid,
  p_course uuid,
  p_path uuid,
  p_enrollment uuid,
  p_day_id uuid,
  p_day integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  c_uuid      constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_course    record;
  v_path      record;
  v_enr       record;
  v_ver       record;
  v_cs        record;
  v_day_ids   jsonb;
  v_days      jsonb;
  v_day_id    uuid;
  v_day_no    integer;
  v_day_crs   uuid;
  v_removed   boolean := false;
  j_member    jsonb;
  j_course    jsonb;
  j_path      jsonb;
  j_journey   jsonb;
  j_holders   jsonb;
begin
  -- member
  j_member := jsonb_build_object('active', exists (
    select 1 from public.organization_members om
     where om.organization_id = p_org and om.user_id = p_user and om.status = 'active'));

  -- course
  select c.id, c.is_active, c.visibility into v_course
    from public.courses c
   where c.id = p_course and c.organization_id = p_org;
  if not found then
    j_course := jsonb_build_object('found', false);
  else
    j_course := jsonb_build_object(
      'found', true,
      'is_active', v_course.is_active,
      'visibility', v_course.visibility,
      'individual', jsonb_build_object(
        'enrolled', exists (
          select 1 from public.v_course_enrollments_expanded e
           where e.course_id = p_course and e.user_id = p_user),
        'upcoming_at', (
          select min(u.release_at) from (
            select ca.release_at
              from public.course_assignments ca
             where ca.course_id = p_course and ca.assignee_type = 'user' and ca.user_id = p_user
               and ca.release_at > now()
            union all
            select ca.release_at
              from public.course_assignments ca
              join public.team_members tm on tm.team_id = ca.team_id
             where ca.course_id = p_course and ca.assignee_type = 'team' and ca.team_id is not null
               and tm.user_id = p_user and ca.release_at > now()
            union all
            select ca.release_at
              from public.course_assignments ca
              join public.courses c on c.id = ca.course_id
              join public.organization_members om on om.organization_id = c.organization_id
             where ca.course_id = p_course and ca.assignee_type = 'org'
               and om.user_id = p_user and ca.release_at > now()
            union all
            select ca.release_at
              from public.course_assignments ca
             cross join lateral public.group_member_ids(ca.group_id) as x
             where ca.course_id = p_course and ca.assignee_type = 'group' and ca.group_id is not null
               and x.user_id = p_user and ca.release_at > now()
          ) u)));
  end if;

  -- path
  if p_path is not null then
    select lp.id, lp.is_active, lp.visibility, lp.sequence_mode into v_path
      from public.learning_paths lp
     where lp.id = p_path and lp.organization_id = p_org;
    if not found then
      j_path := jsonb_build_object('found', false);
    else
      j_path := jsonb_build_object(
        'found', true,
        'is_active', v_path.is_active,
        'visibility', v_path.visibility,
        'sequence_mode', v_path.sequence_mode,
        'enrolled', exists (
          select 1 from public.v_path_enrollments_expanded pe
           where pe.path_id = p_path and pe.user_id = p_user),
        'self_row', exists (
          select 1 from public.learning_path_assignments pa
           where pa.path_id = p_path and pa.assignee_type = 'user' and pa.user_id = p_user
             and pa.source = 'self'),
        'course_step', (
          select lpc.step_number from public.learning_path_courses lpc
           where lpc.path_id = p_path and lpc.course_id = p_course),
        'steps', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'course_id', lpc.course_id,
                   'step_number', lpc.step_number,
                   'release_at', lpc.release_at,
                   'done', coalesce(s.done, false))
                 order by lpc.step_number)
            from public.learning_path_courses lpc
            left join public.v_path_step_status s
              on s.path_id = lpc.path_id and s.course_id = lpc.course_id and s.user_id = p_user
           where lpc.path_id = p_path), '[]'::jsonb));
    end if;
  end if;

  -- journey
  if p_enrollment is not null then
    select en.id, en.status, en.program_id, en.start_date, en.version_id, jp.is_active as program_is_active
      into v_enr
      from public.journey_enrollments en
      join public.journey_programs jp on jp.id = en.program_id
     where en.id = p_enrollment and en.organization_id = p_org and en.user_id = p_user;
    if not found then
      j_journey := jsonb_build_object('found', false);
    else
      select jv.unlock_mode, jv.count_sundays, jv.days_total, jv.days, jv.day_ids into v_ver
        from public.journey_versions jv
       where jv.id = v_enr.version_id;
      v_day_ids := case when jsonb_typeof(v_ver.day_ids) = 'object' then v_ver.day_ids else '{}'::jsonb end;
      v_days    := case when jsonb_typeof(v_ver.days) = 'array' then v_ver.days else '[]'::jsonb end;

      -- the day: by its id, else an old link's number through the pinned
      -- version's day_ids (step 93)
      v_day_id := p_day_id;
      if v_day_id is null and p_day is not null and (v_day_ids ->> p_day::text) ~ c_uuid then
        v_day_id := (v_day_ids ->> p_day::text)::uuid;
      end if;
      if v_day_id is not null then
        select min(k.key::integer) into v_day_no
          from jsonb_each_text(v_day_ids) as k(key, value)
         where k.key ~ '^[0-9]{1,6}$' and lower(k.value) = v_day_id::text;
        if v_day_no is not null then
          select case when (d.e ->> 'course_id') ~ c_uuid then (d.e ->> 'course_id')::uuid end
            into v_day_crs
            from jsonb_array_elements(v_days) with ordinality as d(e, i)
           where d.e ->> 'day' ~ '^[0-9]{1,6}$' and (d.e ->> 'day')::integer = v_day_no
           order by d.i
           limit 1;
        end if;
        v_removed := exists (
          select 1 from public.journey_days jd
           where jd.id = v_day_id and jd.program_id = v_enr.program_id and jd.removed_at is not null);
      end if;

      select cs.required_days, cs.credited_days, cs.next_day, cs.next_day_id, cs.resumable_day_ids
        into v_cs
        from public.journey_credit_state(array[p_enrollment]) cs;

      j_journey := jsonb_build_object(
        'found', true,
        'status', v_enr.status,
        'program_id', v_enr.program_id,
        'program_is_active', v_enr.program_is_active,
        'start_date', v_enr.start_date,
        'version_id', v_enr.version_id,
        'unlock_mode', v_ver.unlock_mode,
        'count_sundays', v_ver.count_sundays,
        'days_total', v_ver.days_total,
        'timezone', coalesce((select gs.timezone from public.gamification_settings gs
                               where gs.organization_id = p_org), 'Asia/Kolkata'),
        'day', jsonb_build_object(
                 'id', v_day_id,
                 'number', v_day_no,
                 'in_version', v_day_no is not null,
                 'removed', v_removed,
                 'course_id', v_day_crs),
        'day_credit', (
          select jsonb_build_object('course_id', p.course_id, 'attempt_id', p.attempt_id,
                                    'credit_kind', p.credit_kind, 'day_number', p.day_number)
            from public.journey_day_progress p
           where p.enrollment_id = p_enrollment and p.day_id = v_day_id),
        'day_open_attempt', (
          select jsonb_build_object('attempt_id', ca.id, 'course_id', cv.course_id)
            from public.course_attempts ca
            join public.course_versions cv on cv.id = ca.course_version_id
           where ca.journey_enrollment_id = p_enrollment
             and ca.context_kind = 'journey'
             and ca.journey_day_id = v_day_id
             and ca.status = 'in_progress'
             and not ca.is_revision
           order by (cv.course_id is not distinct from p_course) desc, ca.started_at, ca.id
           limit 1),
        'required_days', v_cs.required_days,
        'credited_days', v_cs.credited_days,
        'next_day', v_cs.next_day,
        'next_day_id', v_cs.next_day_id,
        'resumable_day_ids', to_jsonb(coalesce(v_cs.resumable_day_ids, '{}'::uuid[])));
    end if;
  end if;

  -- holders: the paths and journey days in which the learner holds the course
  j_holders := jsonb_build_object(
    'paths', coalesce((
      select jsonb_agg(jsonb_build_object('path_id', lpc.path_id, 'step_number', lpc.step_number)
                       order by lpc.path_id)
        from public.learning_path_courses lpc
        join public.learning_paths lp on lp.id = lpc.path_id
       where lpc.course_id = p_course
         and lp.organization_id = p_org
         and lp.is_active
         and exists (select 1 from public.v_path_enrollments_expanded pe
                      where pe.path_id = lpc.path_id and pe.user_id = p_user)), '[]'::jsonb),
    'journey_days', coalesce((
      select jsonb_agg(jsonb_build_object(
               'enrollment_id', r.enrollment_id,
               'day_id', r.day_id,
               'day_number', r.day_number,
               'credited', exists (select 1 from public.journey_day_progress p
                                    where p.enrollment_id = r.enrollment_id and p.day_id = r.day_id))
             order by r.enrollment_id, r.day_number)
        from (
          select distinct
                 en.id as enrollment_id,
                 x.day_number,
                 case when (jv.day_ids ->> x.day_number::text) ~ c_uuid
                      then (jv.day_ids ->> x.day_number::text)::uuid end as day_id
            from public.journey_enrollments en
            join public.journey_versions jv on jv.id = en.version_id
            cross join lateral (
              select case when d.e ->> 'day' ~ '^[0-9]{1,6}$' then (d.e ->> 'day')::integer end as day_number,
                     lower(nullif(d.e ->> 'course_id', '')) as course_id
                from jsonb_array_elements(
                       case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end) as d(e)
            ) x
           where en.user_id = p_user
             and en.organization_id = p_org
             and en.status = 'active'
             and x.course_id = lower(p_course::text)
             and x.day_number between 1 and jv.days_total
        ) r), '[]'::jsonb));

  return jsonb_build_object(
    'v', 1,
    'member', j_member,
    'course', j_course,
    'path', j_path,
    'journey', j_journey,
    'holders', j_holders,
    'run', null);
end
$$;

comment on function public.launch_context(uuid, uuid, uuid, uuid, uuid, uuid, integer) is
  'The facts of one launch in one call (ADR 0024 step 18, note N15): membership, the course and its Individual enrolment, the path and its steps, the journey enrolment and its day, and the paths and journey days that hold the course. Facts only; the launch''s resolver decides. Service role only.';

revoke execute on function public.launch_context(uuid, uuid, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.launch_context(uuid, uuid, uuid, uuid, uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Restated grants, the after-checks A1 to A24 and notify pgrst (ADR 0024
--    section B, creation order item 7; step 19)
-- ---------------------------------------------------------------------------

-- 7a. Restated policies and grants (step 8): attempt_requests keeps its two
-- select policies and its grants as 0083:49-65 wrote them, and
-- revision_visits its deny-all policy and grants as 0103:334-347 wrote them.
-- The columns section 1 added to them take each table's privileges.
alter table public.attempt_requests enable row level security;

drop policy if exists "learners read their own attempt requests" on public.attempt_requests;
create policy "learners read their own attempt requests"
  on public.attempt_requests for select
  using (user_id = auth.uid());

drop policy if exists "admins read org attempt requests" on public.attempt_requests;
create policy "admins read org attempt requests"
  on public.attempt_requests for select
  using (public.is_org_admin(organization_id));

grant select on public.attempt_requests to authenticated, service_role;
grant insert, update, delete on public.attempt_requests to service_role;

alter table public.revision_visits enable row level security;
drop policy if exists "no direct access to revision_visits" on public.revision_visits;
create policy "no direct access to revision_visits" on public.revision_visits
  for all
  using (false)
  with check (false);

revoke all on public.revision_visits from anon, authenticated, service_role;
grant select, insert on public.revision_visits to service_role;

-- 7b. The after-checks A1 to A24 (step 19). Each raises, and a raise rolls
-- the whole file back: "0107 after-check failed: ... Nothing changed." They
-- read the database as this file left it and the table of section 0b. The
-- record lists A1 to A16 as one sentence; they are numbered here in its
-- order. The first paste is the one section 0b found without
-- journey_day_progress.day_id (Q8.paste); the checks that count backfilled
-- rows run on the first paste only (A9, A17's existing keys, A19's
-- equality, A21's counts, A22's zeros). What the record says is counted and
-- reported is a notice, never a raise: A9 on a later paste, A18's
-- enrolments with every required day credited and no completion. Catalog
-- reads follow note N3: not-null from pg_attribute.attnotnull, privileges
-- from has_*_privilege per privilege, never 'MAINTAIN' (it raises on 15 and
-- 16) and never the raw ACL text. The checks that run as anon or
-- authenticated set the role inside their block and set it back to the role
-- that runs the file before they raise; a learner's session there is a
-- request.jwt.claims setting, set and cleared inside the transaction.
--   A1   the new indexes present; the open-row and open-request indexes of
--        0062 and 0083 absent
--   A2   both attempt foreign keys on delete no action
--   A3   both attempt triggers present, enabled and bound
--   A4   the recreated function bodies name context_key
--   A5   the privilege matrix: every new relation (the six tables and the
--        six views; with A23, the two terms views and the two path views
--        among them) and the three restated views, every function this
--        file creates or recreates (its arguments, security definer or
--        invoker, the pinned search_path in proconfig, and execute for the
--        roles that hold it); three new columns hold no privilege of their
--        own; and a real 42501 as anon on every new relation and on every
--        function that is not a trigger function
--   A6   both refresh functions answer with every error null and a
--        completion_sweep entry; they run inside a block rolled back on
--        purpose, so the paste keeps neither the sweep's writes nor the
--        refreshed matviews (a later paste writes no row)
--   A7   counts by context_kind equal Q1
--   A8   Q2 unchanged
--   A9   on the first paste, no completed row with side_effects_sig
--        distinct from settle_sig; on a later paste they are counted only
--   A10  the two old-name views keep their column lists (0103)
--   A11  v_course_attempt_summary: one row per (course, learner)
--   A12  v_context_attempt_summary: one row per (course, learner,
--        context_key)
--   A13  as authenticated, a write naming org_api_keys.contract_version
--        raises 42501; the route's insert columns and its deactivate are
--        still granted
--   A14  as authenticated, a member reads 0 rows of another organisation
--        from the terms views, the path views, learning_path_completions
--        and learning_path_step_completions, and an insert, update or
--        delete of either table raises 42501 (build note O1-f)
--   A15  context_derive_log exists with RLS on
--   A16  every new table with organization_id has RLS on and a policy
--   A17  org_api_keys.contract_version defaults to 2; on the first paste
--        every existing key reads 1
--   A18  journey_credit_state answers for every active enrolment; active
--        enrolments with required_days > 0 and next_day null are counted
--   A19  every journey attempt has a journey_day_id, every credit a day_id,
--        every version a day_ids entry for each of its days; on the first
--        paste the counts of Q8 and Q9 a to d read again by day id equal
--        the counts by (program, day number)
--   A20  unique (enrollment_id, day_id) present, unique (enrollment_id,
--        day_number) absent
--   A21  every preview_kind belongs to an is_preview row; on the first
--        paste every is_preview row reads legacy_role and their count
--        equals Q10
--   A22  purge_preview_data in dry-run mode, once per organisation with a
--        fixed check actor, writes no log row; on the first paste every
--        count and excluded read 0
--   A23  preview_runs, preview_purge_log and learning_path_step_completions
--        have RLS on with a policy; as anon and as authenticated a read of
--        preview_runs and preview_purge_log raises 42501; neither refresh
--        function names purge_preview_data; the append-only triggers of
--        preview_purge_log and learning_path_step_completions are bound;
--        the twenty foreign-key indexes of step 7 (build note O1-a) are
--        present; both delete guards are security definer, name
--        legacy_role, keep the service-role return and their two 0098
--        triggers; v_path_step_status has its columns, the two of O1-d
--        among them
--   A24  journey_save_days, journey_repin_enrollments and both forms of
--        consume_grant are in the privilege matrix

-- A1 to A4 and A7 to A12, A15 to A21, A23 (the catalog and the rows)
do $$
declare
  v_first boolean := (select b.refuses from pg_temp.adr0024_0107_before b where b.q = 'Q8.version_days');
  bad     text[] := '{}';
  r       record;
  n       bigint;
  got     text;
  src     text;
begin
  -- A1
  for r in
    select * from (values
      ('course_attempts_one_in_progress_ctx_idx', true),
      ('course_attempts_user_version_ctx_idx',    false),
      ('course_attempts_org_kind_completed_idx',  false),
      ('course_attempts_ctx_user_idx',            false),
      ('attempt_requests_one_open_ctx_idx',       true),
      ('xp_events_org_ctx_created_idx',           false)
    ) as t(idx, uniq)
  loop
    if not exists (select 1 from pg_index i
                    where i.indexrelid = to_regclass('public.' || r.idx)
                      and i.indisvalid and i.indisunique = r.uniq) then
      bad := bad || format('A1 index %s is missing, invalid or not %s', r.idx,
                           case when r.uniq then 'unique' else 'as defined' end);
    end if;
  end loop;
  if to_regclass('public.course_attempts_one_in_progress_idx') is not null
     or to_regclass('public.attempt_requests_one_open_idx') is not null then
    bad := bad || 'A1 an open-row index of 0062 or 0083 is still present'::text;
  end if;

  -- A2
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.course_attempts'::regclass and c.contype = 'f' and c.confdeltype = 'a'
     and c.conname in ('course_attempts_learning_path_id_fkey', 'course_attempts_journey_enrollment_id_fkey');
  if n <> 2 then
    bad := bad || format('A2 %s of the two attempt foreign keys read on delete no action', n);
  end if;

  -- A3
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.course_attempts'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
     and ((t.tgname = 'course_attempts_context_immutable'
           and t.tgfoid = 'public.course_attempts_context_immutable()'::regprocedure)
       or (t.tgname = 'course_attempts_context_derive'
           and t.tgfoid = 'public.course_attempts_context_derive()'::regprocedure));
  if n <> 2 then
    bad := bad || format('A3 %s of the two attempt triggers are present, enabled and bound', n);
  end if;

  -- A4: each recreated body that reads attempts names their context; a
  -- recreated wrapper calls the form that does
  for r in
    select * from (values
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)', 'context_key'),
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)',
       'public\.consume_grant\((\s*[a-z_]+\s*,){8}\s*[a-z_]+\s*\)'),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text,text)',      'context_key'),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)',
       'public\.record_revision_visit\([^)]*''individual''\)'),
      ('public.journey_record_completion(uuid)',                                'context_key'),
      ('public.gamification_record_activity_core(uuid,boolean,boolean)',        'context_key'),
      ('public.gamification_record_activity_core(uuid)',                        'context_key'),
      ('public.gamification_record_activity(uuid)',                             'context_kind'),
      ('public.gamification_close_month()',                                     'context_kind')
    ) as t(fn, pattern)
  loop
    select p.prosrc into src from pg_proc p where p.oid = to_regprocedure(r.fn);
    if src is null or src !~ r.pattern then
      bad := bad || format('A4 %s does not read the context', r.fn);
    end if;
  end loop;

  -- A7
  select string_agg(format('%s %s/%s', k.kind, coalesce(a.n, 0), coalesce(b.n, 0)), ', ' order by k.kind) into got
    from (values ('individual'), ('path'), ('journey'), ('preview')) as k(kind)
    left join (select ca.context_kind, count(*) as n from public.course_attempts ca group by 1) a
      on a.context_kind = k.kind
    left join pg_temp.adr0024_0107_before b on b.q = 'Q1.kind.' || k.kind
   where coalesce(a.n, 0) <> coalesce(b.n, 0);
  if got is not null
     or (select count(*) from public.course_attempts)
        <> (select b.n from pg_temp.adr0024_0107_before b where b.q = 'Q1.total') then
    bad := bad || format('A7 counts by context_kind differ from Q1 (after/before): %s', coalesce(got, 'the total'));
  end if;

  -- A8
  select string_agg(format('%s %s/%s', v.q, v.n, coalesce(b.n, -1)), ', ' order by v.q) into got
    from (
      select x.q, x.n from (
        select
          count(*) filter (where not ca.is_preview and ca.learning_path_id is not null
                                 and ca.journey_enrollment_id is not null) as both_tags,
          count(*) filter (where not ca.is_preview and ca.journey_enrollment_id is not null
                                 and ca.journey_day is null) as journey_null_day,
          count(*) filter (where not ca.is_preview and ca.journey_day is not null
                                 and ca.journey_enrollment_id is null) as orphan_day,
          count(*) filter (where ca.is_preview and (ca.learning_path_id is not null
                                 or ca.journey_enrollment_id is not null or ca.journey_day is not null)) as preview_tagged,
          count(*) filter (where ca.status = 'abandoned'
                                 and (ca.completion_status = 'completed' or ca.success_status = 'passed')) as abandoned_done
        from public.course_attempts ca) c
      cross join lateral (values
        ('Q2.both_tags', c.both_tags), ('Q2.journey_null_day', c.journey_null_day), ('Q2.orphan_day', c.orphan_day),
        ('Q2.preview_tagged', c.preview_tagged), ('Q2.abandoned_done', c.abandoned_done)) as x(q, n)
    ) v
    left join pg_temp.adr0024_0107_before b on b.q = v.q
   where b.n is distinct from v.n;
  if got is not null then
    bad := bad || format('A8 Q2 changed (after/before): %s', got);
  end if;

  -- A9
  select count(*) into n from public.course_attempts ca
   where (ca.completion_status = 'completed' or ca.success_status = 'passed')
     and ca.side_effects_sig is distinct from ca.settle_sig;
  if v_first and n > 0 then
    bad := bad || format('A9 %s completed row(s) with side_effects_sig distinct from settle_sig on the first paste', n);
  elsif n > 0 then
    raise notice '0107 after-check A9 (counted): % completed row(s) not yet handled by the completion writer (the sweep''s candidates).', n;
  end if;

  -- A10
  for r in
    select * from (values
      ('v_course_attempt_scoring',
       'course_id, user_id, max_scored_attempts, official_basis, official_attempt_number, completed_attempts, '
       || 'scored_attempts, practice_attempts, first_score, best_score, latest_score, official_score, '
       || 'official_status, official_attempt_id'),
      ('v_course_attempt_summary',
       'course_id, user_id, latest_completion, latest_success, best_score, total_time_seconds, attempt_count, '
       || 'ever_completed, ever_passed, official_score, first_score, latest_score, scored_attempts, '
       || 'practice_attempts, official_basis, max_scored_attempts, first_completed_passed, official_status, '
       || 'official_attempt_id, live_attempt_count, latest_live_completion, latest_live_success')
    ) as t(v, cols)
  loop
    select string_agg(a.attname::text, ', ' order by a.attnum) into got
      from pg_attribute a
     where a.attrelid = ('public.' || r.v)::regclass and a.attnum > 0 and not a.attisdropped;
    if got is distinct from r.cols then
      bad := bad || format('A10 %s reads (%s)', r.v, got);
    end if;
  end loop;

  -- A11, A12
  select count(*) - count(distinct (s.course_id, s.user_id)) into n from public.v_course_attempt_summary s;
  if n <> 0 then
    bad := bad || format('A11 v_course_attempt_summary repeats %s (course, learner)', n);
  end if;
  select count(*) - count(distinct (s.course_id, s.user_id, s.context_key)) into n from public.v_context_attempt_summary s;
  if n <> 0 then
    bad := bad || format('A12 v_context_attempt_summary repeats %s (course, learner, context_key)', n);
  end if;

  -- A15
  if to_regclass('public.context_derive_log') is null
     or not (select c.relrowsecurity from pg_class c where c.oid = 'public.context_derive_log'::regclass) then
    bad := bad || 'A15 context_derive_log is missing or has RLS off'::text;
  end if;

  -- A16
  for r in
    select c.oid::regclass::text as rel, c.relrowsecurity as rls,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
     where c.oid in (to_regclass('public.preview_runs'), to_regclass('public.context_derive_log'),
                     to_regclass('public.learning_path_completions'),
                     to_regclass('public.learning_path_step_completions'),
                     to_regclass('public.completion_notices'), to_regclass('public.preview_purge_log'))
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
  loop
    if not r.rls or r.policies = 0 then
      bad := bad || format('A16 %s has RLS %s and %s polic(ies)', r.rel, case when r.rls then 'on' else 'off' end, r.policies);
    end if;
  end loop;

  -- A17
  select pg_get_expr(d.adbin, d.adrelid) into got
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.org_api_keys'::regclass and a.attname = 'contract_version';
  if got is distinct from '2' then
    bad := bad || format('A17 org_api_keys.contract_version defaults to %s, not 2', coalesce(got, 'nothing'));
  end if;
  if v_first and exists (select 1 from public.org_api_keys k where k.contract_version is distinct from 1) then
    bad := bad || 'A17 an existing org_api_keys row does not read contract_version 1 on the first paste'::text;
  end if;

  -- A18
  select count(*) into n
    from public.journey_enrollments en
   where en.status = 'active'
     and not exists (select 1 from public.journey_credit_state(array[en.id]) cs where cs.enrollment_id = en.id);
  if n > 0 then
    bad := bad || format('A18 journey_credit_state does not answer for %s active enrolment(s)', n);
  end if;
  select count(*) into n
    from public.journey_credit_state(array(select en.id from public.journey_enrollments en where en.status = 'active')) cs
   where cs.required_days > 0 and cs.next_day is null;
  if n > 0 then
    raise notice '0107 after-check A18 (counted): % active enrolment(s) hold a credit on every required day and are not completed.', n;
  end if;

  -- A19
  select count(*) into n from public.course_attempts ca
   where ca.context_kind = 'journey' and ca.journey_day_id is null;
  if n > 0 then
    bad := bad || format('A19 %s journey attempt(s) without a journey_day_id', n);
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.journey_day_progress'::regclass and a.attname = 'day_id' and not a.attnotnull) then
    bad := bad || 'A19 journey_day_progress.day_id is not not null'::text;
  end if;
  select count(*) into n
    from public.journey_versions jv
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end) as d(e)
   where d.e ->> 'day' ~ '^[0-9]{1,6}$'
     and not coalesce(jsonb_typeof(jv.day_ids) = 'object' and jv.day_ids ? ((d.e ->> 'day')::integer)::text, false);
  if n > 0 then
    bad := bad || format('A19 %s version day(s) without a day_ids entry', n);
  end if;
  if v_first then
    select string_agg(format('%s %s/%s', v.q, v.n, coalesce(b.n, -1)), ', ' order by v.q) into got
      from (
        with vday as (
          select jv.id as version_id, jv.program_id, jv.days_total, jv.day_ids,
                 case when d.e ->> 'day' ~ '^[0-9]{1,6}$' then (d.e ->> 'day')::integer end as day_number,
                 lower(nullif(d.e ->> 'course_id', '')) as course_id
            from public.journey_versions jv
           cross join lateral jsonb_array_elements(
                   case when jsonb_typeof(jv.days) = 'array' then jv.days else '[]'::jsonb end) as d(e)
        ),
        pin as (
          select e.id as enrollment_id, e.program_id, e.version_id, e.status
            from public.journey_enrollments e
        ),
        pin_day as (
          select p.enrollment_id, vd.day_number, vd.course_id,
                 (vd.day_ids ->> vd.day_number::text) as day_id,
                 coalesce(vd.day_number between 1 and vd.days_total and vd.course_id is not null, false) as required
            from pin p
            join vday vd on vd.version_id = p.version_id
        ),
        credit as (
          select pr.enrollment_id, pr.day_id::text as day_id, lower(pr.course_id::text) as course_id
            from public.journey_day_progress pr
        ),
        jatt as (
          select ca.id, ca.journey_enrollment_id, ca.journey_day_id::text as day_id, lower(cv.course_id::text) as course_id
            from public.course_attempts ca
            join public.course_versions cv on cv.id = ca.course_version_id
           where ca.context_kind = 'journey' and ca.status = 'in_progress'
        ),
        open_day as (
          select distinct on (pd.enrollment_id) pd.enrollment_id, pd.day_id
            from pin_day pd
           where pd.required
             and not exists (select 1 from credit c where c.enrollment_id = pd.enrollment_id and c.day_id = pd.day_id)
           order by pd.enrollment_id, pd.day_number
        )
        select x.q, x.n from (
          select
            (select count(*) from vday v
              where v.day_number is not null
                and not exists (select 1 from public.journey_days jd
                                 where jd.program_id = v.program_id
                                   and jd.id::text = (v.day_ids ->> v.day_number::text))) as version_days,
            (select count(*) from public.course_attempts ca
              where ca.context_kind = 'journey' and ca.journey_day_id is null) as journey_attempts,
            (select count(*) from public.journey_day_progress pr where pr.day_id is null) as progress_rows,
            (select count(*) from credit c join pin p on p.enrollment_id = c.enrollment_id
              where c.course_id is distinct from
                    (select max(pd.course_id) from pin_day pd
                      where pd.enrollment_id = c.enrollment_id and pd.day_id = c.day_id)) as a,
            (select count(*) from credit c join pin p on p.enrollment_id = c.enrollment_id
              where not exists (select 1 from pin_day pd
                                 where pd.enrollment_id = c.enrollment_id and pd.day_id = c.day_id and pd.required)) as b,
            (select count(*) from jatt a
               left join pin p on p.enrollment_id = a.journey_enrollment_id
               left join open_day od on od.enrollment_id = a.journey_enrollment_id
              where p.enrollment_id is null or a.day_id is distinct from od.day_id) as c_not_open_day,
            (select count(*) from jatt a
               left join pin p on p.enrollment_id = a.journey_enrollment_id
              where p.enrollment_id is null
                 or a.course_id is distinct from
                    (select max(pd.course_id) from pin_day pd
                      where pd.enrollment_id = a.journey_enrollment_id and pd.day_id = a.day_id)) as c_other_course,
            (select count(*) from jatt a
               left join pin p on p.enrollment_id = a.journey_enrollment_id
               left join open_day od on od.enrollment_id = a.journey_enrollment_id
              where p.enrollment_id is null
                 or a.day_id is distinct from od.day_id
                 or a.course_id is distinct from
                    (select max(pd.course_id) from pin_day pd
                      where pd.enrollment_id = a.journey_enrollment_id and pd.day_id = a.day_id)) as c_either,
            (select count(*) from pin p
              where p.status = 'active'
                and exists (
                  select 1 from pin_day rq
                   where rq.enrollment_id = p.enrollment_id and rq.required
                     and not exists (select 1 from credit c
                                      where c.enrollment_id = rq.enrollment_id and c.day_id = rq.day_id)
                     and exists (select 1 from pin_day l
                                   join credit c on c.enrollment_id = l.enrollment_id and c.day_id = l.day_id
                                  where l.enrollment_id = rq.enrollment_id and l.required
                                    and l.day_number > rq.day_number))) as d
        ) c
        cross join lateral (values
          ('Q8.version_days', c.version_days), ('Q8.journey_attempts', c.journey_attempts),
          ('Q8.progress_rows', c.progress_rows), ('Q9.a', c.a), ('Q9.b', c.b),
          ('Q9.c_not_open_day', c.c_not_open_day), ('Q9.c_other_course', c.c_other_course),
          ('Q9.c', c.c_either), ('Q9.d', c.d)) as x(q, n)
      ) v
      left join pg_temp.adr0024_0107_before b on b.q = v.q
     where b.n is distinct from v.n;
    if got is not null then
      bad := bad || format('A19 counts by day id differ from the counts by (program, day number) (by id/by number): %s', got);
    end if;
  end if;

  -- A20
  if not exists (
       select 1 from pg_index i
        where i.indrelid = 'public.journey_day_progress'::regclass and i.indisunique and i.indisvalid
          and i.indnatts = 2
          and (select array_agg(a.attname::text order by k.o)
                 from unnest(i.indkey::int2[]) with ordinality as k(attnum, o)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = array['enrollment_id', 'day_id'])
     or exists (
       select 1 from pg_index i
        where i.indrelid = 'public.journey_day_progress'::regclass and i.indisunique
          and (select array_agg(a.attname::text order by k.o)
                 from unnest(i.indkey::int2[]) with ordinality as k(attnum, o)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = array['enrollment_id', 'day_number']) then
    bad := bad || 'A20 journey_day_progress lacks unique (enrollment_id, day_id) or still has unique (enrollment_id, day_number)'::text;
  end if;

  -- A21
  if exists (select 1 from public.course_attempts ca where ca.preview_kind is not null and not ca.is_preview) then
    bad := bad || 'A21 a row that is not is_preview carries a preview_kind'::text;
  end if;
  if v_first then
    select count(*) into n from public.course_attempts ca where ca.is_preview;
    if exists (select 1 from public.course_attempts ca
                where ca.is_preview and ca.preview_kind is distinct from 'legacy_role')
       or n <> (select b.n from pg_temp.adr0024_0107_before b where b.q = 'Q10.rows') then
      bad := bad || format('A21 on the first paste %s is_preview row(s), not every one legacy_role, or not Q10''s %s', n,
                           (select b.n from pg_temp.adr0024_0107_before b where b.q = 'Q10.rows'));
    end if;
  end if;

  -- A23 (the catalog half; the reads as anon and authenticated are below)
  for r in
    select * from (values ('public.preview_runs'), ('public.preview_purge_log'),
                          ('public.learning_path_step_completions')) as t(rel)
  loop
    if not (select c.relrowsecurity from pg_class c where c.oid = r.rel::regclass)
       or not exists (select 1 from pg_policy p where p.polrelid = r.rel::regclass) then
      bad := bad || format('A23 %s has RLS off or no policy', r.rel);
    end if;
  end loop;
  if exists (select 1 from pg_proc p
              where p.oid in (to_regprocedure('public.refresh_report_views()'),
                              to_regprocedure('public.refresh_gamification_views()'))
                and p.prosrc ~* 'purge_preview_data') then
    bad := bad || 'A23 a refresh function names purge_preview_data'::text;
  end if;
  select count(*) into n from pg_trigger t
   where not t.tgisinternal and t.tgenabled <> 'D'
     and ((t.tgrelid = 'public.preview_purge_log'::regclass and t.tgname = 'preview_purge_log_no_mutation'
           and t.tgfoid = 'public.preview_purge_log_append_only()'::regprocedure)
       or (t.tgrelid = 'public.learning_path_step_completions'::regclass
           and t.tgname = 'learning_path_step_completions_no_mutation'
           and t.tgfoid = 'public.learning_path_step_completions_append_only()'::regprocedure));
  if n <> 2 then
    bad := bad || format('A23 %s of the two append-only triggers (preview_purge_log, learning_path_step_completions) are bound', n);
  end if;
  for r in
    select * from (values
      ('course_attempts',                'course_attempts_journey_version_idx',             'journey_version_id'),
      ('course_attempts',                'course_attempts_preview_run_idx',                 'preview_run_id'),
      ('course_attempts',                'course_attempts_journey_day_idx',                 'journey_day_id'),
      ('attempt_requests',               'attempt_requests_journey_day_idx',                'journey_day_id'),
      ('attempt_requests',               'attempt_requests_learning_path_idx',              'learning_path_id'),
      ('attempt_requests',               'attempt_requests_journey_enrollment_idx',         'journey_enrollment_id'),
      ('journey_day_progress',           'journey_day_progress_day_idx',                    'day_id'),
      ('preview_runs',                   'preview_runs_organization_idx',                   'organization_id'),
      ('preview_runs',                   'preview_runs_user_idx',                           'user_id'),
      ('preview_runs',                   'preview_runs_learning_path_idx',                  'learning_path_id'),
      ('preview_runs',                   'preview_runs_journey_program_idx',                'journey_program_id'),
      ('preview_runs',                   'preview_runs_journey_version_idx',                'journey_version_id'),
      ('learning_path_completions',      'learning_path_completions_organization_idx',      'organization_id'),
      ('learning_path_completions',      'learning_path_completions_user_idx',              'user_id'),
      ('learning_path_step_completions', 'learning_path_step_completions_organization_idx', 'organization_id'),
      ('learning_path_step_completions', 'learning_path_step_completions_user_idx',         'user_id'),
      ('learning_path_step_completions', 'learning_path_step_completions_course_idx',       'course_id'),
      ('completion_notices',             'completion_notices_organization_idx',             'organization_id'),
      ('completion_notices',             'completion_notices_attempt_idx',                  'attempt_id'),
      ('preview_purge_log',              'preview_purge_log_organization_idx',              'organization_id')
    ) as t(tbl, idx, col)
  loop
    if not exists (
      select 1 from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indexrelid = to_regclass('public.' || r.idx)
        and i.indrelid = ('public.' || r.tbl)::regclass
        and a.attname = r.col and i.indisvalid
    ) then
      bad := bad || format('A23 foreign-key index %s on %s (%s) is missing', r.idx, r.tbl, r.col);
    end if;
  end loop;
  for r in
    select * from (values
      ('public.guard_learner_history_course_versions()', 'public.course_versions', 'course_versions_guard_learner_history'),
      ('public.guard_learner_history_courses()',         'public.courses',         'courses_guard_learner_history')
    ) as t(fn, rel, trg)
  loop
    select p.prosrc into src from pg_proc p where p.oid = to_regprocedure(r.fn) and p.prosecdef;
    if src is null or strpos(src, 'legacy_role') = 0 or src !~ 'claim_role\s*=\s*''service_role''\s+then\s+return\s+old'
       or not exists (select 1 from pg_trigger t
                       where t.tgrelid = r.rel::regclass and t.tgname = r.trg and not t.tgisinternal
                         and t.tgenabled <> 'D' and t.tgfoid = to_regprocedure(r.fn)) then
      bad := bad || format('A23 %s is not security definer, does not name legacy_role, lost its service-role return or its trigger %s', r.fn, r.trg);
    end if;
  end loop;
  select string_agg(a.attname::text, ', ' order by a.attnum) into got
    from pg_attribute a where a.attrelid = 'public.v_path_step_status'::regclass and a.attnum > 0 and not a.attisdropped;
  if got is distinct from 'path_id, user_id, course_id, organization_id, step_number, release_at, pass_required, '
                          || 'passed_ever, passed_by_rule, done_recorded_at, latest_result, latest_score, done, '
                          || 'official_attempt_id, retake_live, failed, open_attempt' then
    bad := bad || format('A23 v_path_step_status reads (%s)', got);
  end if;

  if cardinality(bad) > 0 then
    raise exception '0107 after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 19. The file rolled back whole; correct the cause and paste it again.';
  end if;
end
$$;

-- A5 (the privilege matrix) and A24. The function list is every function
-- this file creates or recreates; the rehearsal's static step checks it
-- against the file's own create statements, so a function added later and
-- left out of the list fails there.
do $$
declare
  bad    text[] := '{}';
  r      record;
  g      record;
  p      text;
  hold   boolean;
  want   boolean;
  v_role text;
begin
  -- relations: the privileges each role holds, read per privilege
  for r in
    select * from (values
      -- (relation, anon, authenticated, service_role, is_strict): is_strict
      -- reads every privilege; otherwise only select is read for
      -- authenticated and service_role, because the three restated views keep
      -- the grants of 0103 and 0105, which revoke nothing from authenticated;
      -- anon null = not read (the two old-name views keep whatever 0073 to
      -- 0103 left anon; they are invoker views over tables anon reads no row
      -- of)
      ('public.preview_runs',                   '', '',       'SELECT,INSERT,UPDATE', true),
      ('public.context_derive_log',             '', '',       'SELECT,INSERT,UPDATE', true),
      ('public.learning_path_completions',      '', 'SELECT', 'SELECT',               true),
      ('public.learning_path_step_completions', '', 'SELECT', 'SELECT',               true),
      ('public.completion_notices',             '', '',       'SELECT,UPDATE',        true),
      ('public.preview_purge_log',              '', '',       'SELECT',               true),
      ('public.v_context_attempt_scoring',      '', 'SELECT', 'SELECT',               true),
      ('public.v_context_attempt_summary',      '', 'SELECT', 'SELECT',               true),
      ('public.v_course_enrollment_terms',      '', 'SELECT', 'SELECT',               true),
      ('public.v_path_enrollment_terms',        '', 'SELECT', 'SELECT',               true),
      ('public.v_path_step_status',             '', 'SELECT', 'SELECT',               true),
      ('public.v_path_progress',                '', 'SELECT', 'SELECT',               true),
      ('public.v_course_attempt_scoring',       null, 'SELECT', 'SELECT',             false),
      ('public.v_course_attempt_summary',       null, 'SELECT', 'SELECT',             false),
      ('public.v_course_enrollments_expanded',  '', 'SELECT', 'SELECT',               false)
    ) as t(rel, anon_p, auth_p, svc_p, is_strict)
  loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      -- anon holds nothing on every relation it is read for
      if r.anon_p is not null and has_table_privilege('anon', r.rel, p) then
        bad := bad || format('A5 anon holds %s on %s', p, r.rel);
      end if;
      if r.is_strict or p = 'SELECT' then
        want := p = any(string_to_array(r.auth_p, ','));
        if has_table_privilege('authenticated', r.rel, p) <> want then
          bad := bad || format('A5 authenticated %s %s on %s', case when want then 'lacks' else 'holds' end, p, r.rel);
        end if;
        want := p = any(string_to_array(r.svc_p, ','));
        if has_table_privilege('service_role', r.rel, p) <> want then
          bad := bad || format('A5 service_role %s %s on %s', case when want then 'lacks' else 'holds' end, p, r.rel);
        end if;
      end if;
    end loop;
  end loop;

  -- three new columns hold no privilege of their own: each role holds on
  -- the column exactly what it holds on its table (section B)
  for r in
    select * from (values
      ('public.course_attempts',   'journey_version_id'),
      ('public.preview_runs',      'done_activity_day_ids'),
      ('public.preview_purge_log', 'excluded')
    ) as t(rel, col)
  loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
        if has_column_privilege(v_role, r.rel, r.col, p) <> has_table_privilege(v_role, r.rel, p) then
          bad := bad || format('A5 %s holds %s on %s.%s apart from its table', v_role, p, r.rel, r.col);
        end if;
      end loop;
    end loop;
  end loop;

  -- functions: every function this file creates or recreates
  -- after-check function list: begin
  for r in
    select * from (values
      ('public.course_attempts_context_immutable()',                            false, false),
      ('public.course_attempts_context_derive()',                               true,  false),
      ('public.learning_path_completions_append_only()',                        false, false),
      ('public.learning_path_step_completions_append_only()',                   false, false),
      ('public.preview_purge_log_append_only()',                                false, false),
      ('public.official_attempt_in_context(uuid,uuid,text)',                    false, false),
      ('public.instance_pass_required(uuid,text)',                              false, false),
      ('public.journey_attempt_satisfies(uuid,boolean)',                        false, false),
      ('public.journey_credit_state(uuid[])',                                   false, false),
      ('public.journey_reminder_counts(uuid[])',                                true,  false),
      ('public.journey_versions_derive_day_ids()',                              false, false),
      ('public.guard_learner_history_course_versions()',                        true,  false),
      ('public.guard_learner_history_courses()',                                true,  false),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text,text)',      true,  false),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)',           true,  false),
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)', true,  false),
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)',      true,  false),
      ('public.journey_save_days(uuid,jsonb)',                                  false, true),
      ('public.journey_repin_enrollments(uuid,uuid,jsonb,boolean)',             true,  false),
      ('public.journey_complete_enrollments_core(uuid[],text)',                 true,  false),
      ('public.journey_complete_enrollment(uuid)',                              true,  false),
      ('public.journey_complete_enrollments(uuid)',                             true,  false),
      ('public.journey_record_completion(uuid)',                                true,  false),
      ('public.gamification_record_activity_core(uuid,boolean,boolean)',        true,  false),
      ('public.gamification_record_activity_core(uuid)',                        true,  false),
      ('public.gamification_record_activity(uuid)',                             true,  false),
      ('public.record_learning_activity(uuid,boolean)',                         true,  false),
      ('public.record_learning_activity(uuid)',                                 true,  false),
      ('public.sweep_completion_side_effects(integer)',                         true,  false),
      ('public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)',          true,  false),
      ('public.refresh_report_views()',                                         true,  false),
      ('public.refresh_gamification_views()',                                   true,  false),
      ('public.gamification_close_month()',                                     true,  false),
      ('public.journey_auto_enroll()',                                          true,  false),
      ('public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)',          true,  false)
    ) as t(fn, definer, auth_exec)
  -- after-check function list: end
  loop
    select pr.prosecdef, pr.proconfig into g from pg_proc pr where pr.oid = to_regprocedure(r.fn);
    if not found then
      bad := bad || format('A5 %s is missing', r.fn);
      continue;
    end if;
    if g.prosecdef <> r.definer then
      bad := bad || format('A5 %s is security %s', r.fn, case when g.prosecdef then 'definer' else 'invoker' end);
    end if;
    if g.proconfig is distinct from array['search_path=pg_catalog, public'] then
      bad := bad || format('A5 %s has proconfig %s', r.fn, coalesce(g.proconfig::text, 'null'));
    end if;
    if has_function_privilege('anon', to_regprocedure(r.fn), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(r.fn), 'EXECUTE') <> r.auth_exec
       or not has_function_privilege('service_role', to_regprocedure(r.fn), 'EXECUTE') then
      bad := bad || format('A5 %s: execute anon %s, authenticated %s, service_role %s', r.fn,
                           has_function_privilege('anon', to_regprocedure(r.fn), 'EXECUTE'),
                           has_function_privilege('authenticated', to_regprocedure(r.fn), 'EXECUTE'),
                           has_function_privilege('service_role', to_regprocedure(r.fn), 'EXECUTE'));
    end if;
  end loop;

  -- A24
  if (select count(*) from pg_proc pr
       where pr.oid in (to_regprocedure('public.journey_save_days(uuid,jsonb)'),
                        to_regprocedure('public.journey_repin_enrollments(uuid,uuid,jsonb,boolean)'),
                        to_regprocedure('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)'),
                        to_regprocedure('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)'))
         and pr.proconfig = array['search_path=pg_catalog, public']
         and not has_function_privilege('anon', pr.oid, 'EXECUTE')
         and has_function_privilege('service_role', pr.oid, 'EXECUTE')) <> 4 then
    bad := bad || 'A24 journey_save_days, journey_repin_enrollments or a form of consume_grant is not in the privilege matrix'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception '0107 after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 19 (the privilege matrix). The file rolled back whole; correct the cause and paste it again.';
  end if;
end
$$;

-- A5 (a real 42501 as anon) and A23 (the reads as anon and authenticated).
-- The role is set inside the block and set back before any raise; the
-- statements touch no row (where false, or a call refused before it runs).
do $$
declare
  v_me    text := current_user;
  bad     text[] := '{}';
  r       record;
  st      text;
  v_role  text;
begin
  if not has_schema_privilege('anon', 'public', 'USAGE')
     or not has_schema_privilege('authenticated', 'public', 'USAGE') then
    raise exception '0107 after-check failed: A5 anon or authenticated holds no usage on schema public, so a 42501 below would prove nothing. Nothing changed.';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', v_role);
    for r in
      select x.what, x.stmt from (
        -- as anon: every new relation, and every function that is not a
        -- trigger function; as authenticated: preview_runs and
        -- preview_purge_log (A23)
        select c.oid::regclass::text as what, format('select 1 from %s where false', c.oid::regclass) as stmt,
               (v_role = 'anon' or c.oid in (to_regclass('public.preview_runs'), to_regclass('public.preview_purge_log'))) as wanted
          from pg_class c
         where c.oid in (to_regclass('public.preview_runs'), to_regclass('public.context_derive_log'),
                         to_regclass('public.learning_path_completions'),
                         to_regclass('public.learning_path_step_completions'),
                         to_regclass('public.completion_notices'), to_regclass('public.preview_purge_log'),
                         to_regclass('public.v_context_attempt_scoring'), to_regclass('public.v_context_attempt_summary'),
                         to_regclass('public.v_course_enrollment_terms'), to_regclass('public.v_path_enrollment_terms'),
                         to_regclass('public.v_path_step_status'), to_regclass('public.v_path_progress'))
        union all
        select pr.oid::regprocedure::text,
               format('select %s.%s(%s)', quote_ident(n.nspname), quote_ident(pr.proname),
                      (select coalesce(string_agg('null::' || format_type(t.oid, null), ', ' order by k.o), '')
                         from unnest(pr.proargtypes::oid[]) with ordinality as k(oid, o)
                         join pg_type t on t.oid = k.oid)),
               v_role = 'anon'
          from pg_proc pr
          join pg_namespace n on n.oid = pr.pronamespace
         where pr.oid in (
                 to_regprocedure('public.official_attempt_in_context(uuid,uuid,text)'),
                 to_regprocedure('public.instance_pass_required(uuid,text)'),
                 to_regprocedure('public.journey_attempt_satisfies(uuid,boolean)'),
                 to_regprocedure('public.journey_credit_state(uuid[])'),
                 to_regprocedure('public.journey_reminder_counts(uuid[])'),
                 to_regprocedure('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text,text)'),
                 to_regprocedure('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)'),
                 to_regprocedure('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)'),
                 to_regprocedure('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)'),
                 to_regprocedure('public.journey_save_days(uuid,jsonb)'),
                 to_regprocedure('public.journey_repin_enrollments(uuid,uuid,jsonb,boolean)'),
                 to_regprocedure('public.journey_complete_enrollments_core(uuid[],text)'),
                 to_regprocedure('public.journey_complete_enrollment(uuid)'),
                 to_regprocedure('public.journey_complete_enrollments(uuid)'),
                 to_regprocedure('public.journey_record_completion(uuid)'),
                 to_regprocedure('public.gamification_record_activity_core(uuid,boolean,boolean)'),
                 to_regprocedure('public.gamification_record_activity_core(uuid)'),
                 to_regprocedure('public.gamification_record_activity(uuid)'),
                 to_regprocedure('public.record_learning_activity(uuid,boolean)'),
                 to_regprocedure('public.record_learning_activity(uuid)'),
                 to_regprocedure('public.sweep_completion_side_effects(integer)'),
                 to_regprocedure('public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)'),
                 to_regprocedure('public.refresh_report_views()'),
                 to_regprocedure('public.refresh_gamification_views()'),
                 to_regprocedure('public.gamification_close_month()'),
                 to_regprocedure('public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)'))
      ) x
      where x.wanted
    loop
      st := null;
      begin
        execute r.stmt;
      exception when others then
        st := sqlstate;
      end;
      if st is distinct from '42501' then
        bad := bad || format('%s as %s answered %s, not 42501', r.what, v_role, coalesce(st, 'no error'));
      end if;
    end loop;
    execute format('set local role %I', v_me);
  end loop;

  if cardinality(bad) > 0 then
    raise exception '0107 after-check failed: A5/A23 %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 19 (a real 42501 as anon). The file rolled back whole; correct the cause and paste it again.';
  end if;
end
$$;

-- A13 and A14: as authenticated. A14 reads as a member of some
-- organisation who is not a platform owner (the first by user id); with no
-- such member there is nobody to read as and A14 is skipped with a notice.
do $$
declare
  v_me     text := current_user;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_user   uuid;
  v_orgs   uuid[];
  bad      text[] := '{}';
  r        record;
  st       text;
  n        bigint;
begin
  -- A13: no claims; the statements touch no row
  execute 'set local role authenticated';
  for r in
    select * from (values
      ('update naming contract_version', 'update public.org_api_keys set contract_version = 1 where false', '42501'),
      ('insert naming contract_version',
       'insert into public.org_api_keys (organization_id, name, key_prefix, key_hash, contract_version) '
       || 'select null, null, null, null, 1 where false', '42501'),
      ('the route''s insert columns',
       'insert into public.org_api_keys (organization_id, name, key_prefix, key_hash, is_active, created_by) '
       || 'select null, null, null, null, null, null where false', 'ok'),
      ('the route''s deactivate', 'update public.org_api_keys set is_active = false where false', 'ok')
    ) as t(what, stmt, want)
  loop
    st := 'ok';
    begin
      execute r.stmt;
    exception when others then
      st := sqlstate;
    end;
    if st <> r.want then
      bad := bad || format('A13 %s as authenticated answered %s, not %s', r.what, st, r.want);
    end if;
  end loop;
  execute format('set local role %I', v_me);

  -- A14: a member's session
  select om.user_id into v_user
    from public.organization_members om
   where to_regclass('public.platform_owners') is null
      or not exists (select 1 from public.platform_owners po where po.user_id = om.user_id)
   order by om.user_id
   limit 1;
  if v_user is null then
    raise notice '0107 after-check A14 skipped: no organisation member to read as.';
  else
    select array_agg(om.organization_id) into v_orgs from public.organization_members om where om.user_id = v_user;
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    -- auth.uid() reads request.jwt.claim.sub first when it is set; it is
    -- touched only then, so the file leaves no such setting behind
    if nullif(v_sub, '') is not null then
      perform set_config('request.jwt.claim.sub', v_user::text, true);
    end if;
    execute 'set local role authenticated';
    for r in
      select * from (values
        ('v_course_enrollment_terms'), ('v_path_enrollment_terms'), ('v_path_step_status'), ('v_path_progress'),
        ('learning_path_completions'), ('learning_path_step_completions')
      ) as t(rel)
    loop
      st := null;
      begin
        execute format('select count(*) from public.%I where organization_id <> all ($1)', r.rel) into n using v_orgs;
      exception when others then
        st := sqlstate;
      end;
      if st is not null then
        bad := bad || format('A14 a member''s read of %s raised %s', r.rel, st);
      elsif n <> 0 then
        bad := bad || format('A14 a member reads %s row(s) of another organisation from %s', n, r.rel);
      end if;
    end loop;
    for r in
      select * from (values
        ('learning_path_completions', 'insert into public.learning_path_completions (organization_id, path_id, user_id) select null, null, null where false'),
        ('learning_path_completions', 'update public.learning_path_completions set path_score = null where false'),
        ('learning_path_completions', 'delete from public.learning_path_completions where false'),
        ('learning_path_step_completions', 'insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, rule_pass_required) select null, null, null, null, null where false'),
        ('learning_path_step_completions', 'update public.learning_path_step_completions set attempt_id = null where false'),
        ('learning_path_step_completions', 'delete from public.learning_path_step_completions where false')
      ) as t(rel, stmt)
    loop
      st := 'ok';
      begin
        execute r.stmt;
      exception when others then
        st := sqlstate;
      end;
      if st <> '42501' then
        bad := bad || format('A14 a member''s write of %s answered %s, not 42501', r.rel, st);
      end if;
    end loop;
    execute format('set local role %I', v_me);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    if nullif(v_sub, '') is not null then
      perform set_config('request.jwt.claim.sub', v_sub, true);
    end if;
  end if;

  if cardinality(bad) > 0 then
    raise exception '0107 after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 19 (as authenticated). The file rolled back whole; correct the cause and paste it again.';
  end if;
end
$$;

-- A6: both refresh functions, once each, inside a block that is rolled back
-- on purpose once they have answered: the paste keeps neither the
-- completion sweep's writes nor the refreshed matviews, so a later paste
-- writes no row (step 63, "the second paste changes nothing"); the next
-- scheduled refresh does both. A plpgsql variable keeps its value when its
-- block rolls back.
do $$
declare
  bad      text[] := '{}';
  res_rep  jsonb;
  res_gam  jsonb;
  r        record;
begin
  begin
    res_rep := public.refresh_report_views();
    res_gam := public.refresh_gamification_views();
    raise exception 'adr0024_0107_a6_undo' using errcode = 'P0001';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'adr0024_0107_a6_undo' then
      raise;
    end if;
  end;
  for r in select * from (values ('refresh_report_views', res_rep), ('refresh_gamification_views', res_gam)) as t(fn, res) loop
    if jsonb_typeof(r.res) is distinct from 'array'
       or exists (select 1 from jsonb_array_elements(r.res) e where e ->> 'error' is not null)
       or (select count(*) from jsonb_array_elements(r.res) e where e ->> 'view' = 'completion_sweep') <> 1 then
      bad := bad || format('A6 %s() answered %s', r.fn, coalesce(r.res::text, 'null'));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception '0107 after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 19 (the refresh functions and the completion sweep). The file rolled back whole.';
  end if;
end
$$;

-- A22: a dry run per organisation, with a fixed check actor; it must write
-- no log row, and on the first paste find nothing to delete
do $$
declare
  v_first boolean := (select b.refuses from pg_temp.adr0024_0107_before b where b.q = 'Q8.version_days');
  v_logs  bigint := (select count(*) from public.preview_purge_log);
  bad     text[] := '{}';
  r       record;
  a       jsonb;
begin
  for r in select o.id from public.organizations o order by o.id loop
    a := public.purge_preview_data(r.id, '{"organization": true}'::jsonb, 'manual',
                                   '00000000-0000-0000-0000-000000000000'::uuid, true);
    if (a ->> 'dry_run')::boolean is distinct from true then
      bad := bad || format('A22 the dry run of an organisation answered %s', a);
    elsif v_first and ((a -> 'counts' ->> 'total')::integer <> 0 or (a ->> 'excluded')::integer <> 0) then
      bad := bad || format('A22 on the first paste the dry run of an organisation found %s, excluded %s',
                           a -> 'counts', a ->> 'excluded');
    end if;
  end loop;
  if (select count(*) from public.preview_purge_log) <> v_logs then
    bad := bad || 'A22 a dry run wrote a preview_purge_log row'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception '0107 after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 19 (the purge dry run). The file rolled back whole.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
