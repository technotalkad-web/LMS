-- 0069_group_assignments.sql
-- G4 (final phase of the Custom Groups program): assign COURSES and
-- LEARNING PATHS to a Custom Group (0067).
--
-- assignee_type gains 'group' on both assignment tables, carried by a new
-- group_id column (cascade: deleting a group removes its assignments —
-- learning already completed is untouched, matching the groups-UI warning).
-- Dynamic groups resolve membership LIVE, so joining a group grants the
-- learning instantly and leaving revokes it instantly — the entitlement
-- code paths (dashboard, course-access, launch, catalog, paths, reminder
-- cron) all resolve through lib/org/groups.
--
-- KNOWN v1 GAP (documented): the 0031 report views expand user/org/team
-- assignees in SQL and do NOT count group assignees in "assigned" totals;
-- attempt/completion analytics are unaffected. Follow-up scheduled.

-- ── course_assignments ──────────────────────────────────────────────────────
alter table public.course_assignments
  add column if not exists group_id uuid references public.org_groups(id) on delete cascade;

alter table public.course_assignments
  drop constraint if exists course_assignments_assignee_check;
alter table public.course_assignments
  add constraint course_assignments_assignee_check check (
    (assignee_type = 'user'  and user_id is not null and team_id is null     and group_id is null) or
    (assignee_type = 'org'   and user_id is null     and team_id is null     and group_id is null) or
    (assignee_type = 'team'  and team_id is not null and user_id is null     and group_id is null) or
    (assignee_type = 'group' and group_id is not null and user_id is null    and team_id is null)
  );

create unique index if not exists course_assignments_unique_group_idx
  on public.course_assignments(course_id, group_id)
  where assignee_type = 'group';

-- ── learning_path_assignments ───────────────────────────────────────────────
alter table public.learning_path_assignments
  add column if not exists group_id uuid references public.org_groups(id) on delete cascade;

alter table public.learning_path_assignments
  drop constraint if exists learning_path_assignments_assignee_type_check;
alter table public.learning_path_assignments
  add constraint learning_path_assignments_assignee_type_check
    check (assignee_type in ('user', 'org', 'team', 'group'));

create unique index if not exists learning_path_assignments_unique_group_idx
  on public.learning_path_assignments(path_id, group_id)
  where assignee_type = 'group';

notify pgrst, 'reload schema';
