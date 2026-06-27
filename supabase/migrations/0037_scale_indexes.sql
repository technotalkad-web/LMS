-- 0037: indexes for 1,000–5,000-user scale (audit C6).
--
-- Postgres does NOT auto-index foreign-key columns (only PK/UNIQUE). Several
-- hot query paths filter by organization_id / assignee_type / course_id with no
-- supporting index, forcing sequential scans that get linearly worse as the
-- attempts/assignments tables grow. These are the columns the reports, admin
-- dashboards, and the reminder cron filter on.
--
-- Plain CREATE INDEX (not CONCURRENTLY) so this runs fine inside the Supabase
-- SQL editor's transaction. Data volume is still small pre-launch, so the brief
-- lock is negligible; for very large existing tables prefer CONCURRENTLY run
-- outside a transaction.

-- Every reports/dashboard query filters attempts by org. (Highest priority.)
create index if not exists course_attempts_org_idx
  on public.course_attempts(organization_id);

-- Assignment expansion (reminders, reports, dashboard) filters by org + type.
create index if not exists course_assignments_org_type_idx
  on public.course_assignments(organization_id, assignee_type);

-- Path assignment expansion filters by org.
create index if not exists learning_path_assignments_org_idx
  on public.learning_path_assignments(organization_id);

-- Reminder cron does reminder_state .in("course_id", ...) every run; only the
-- (user_id,course_id) PK and (organization_id,last_nudge_at) index exist today.
create index if not exists reminder_state_course_idx
  on public.reminder_state(course_id);

-- Path-context attempt lookups (product decision L2) filter by learning_path_id.
create index if not exists course_attempts_path_idx
  on public.course_attempts(learning_path_id)
  where learning_path_id is not null;

notify pgrst, 'reload schema';
