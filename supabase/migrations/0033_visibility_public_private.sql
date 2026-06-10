-- Visibility control on courses + learning paths.
--
-- Today every course/path is "private": only learners with an explicit
-- assignment (user / team / org-assignment row) see it. Admins have been
-- using the assignee_type='org' assignment row as a workaround for "show
-- this to everyone in the org" — but that's an awkward fit because:
--   - It pollutes the assignments table with an N-row-per-org artifact
--   - There's no clean way to tell from the course row alone whether
--     it's intended to be org-wide or just-happens-to-have-an-org-assign
--   - Reports lump org-wide visibility under "assigned" which is wrong
--
-- This migration adds a first-class visibility column:
--   - 'private' (default, current behavior): only explicitly assigned
--     learners see it on their dashboard / library and can launch.
--   - 'org_public': every member of the org sees it on their dashboard
--     and can launch directly. No assignment row needed.
--
-- Future tiers (NOT implemented now) could include 'internet_public'
-- for a true unauthenticated landing page — column is text not enum so
-- adding values later just means relaxing the CHECK constraint.

begin;

alter table public.courses
  add column if not exists visibility text not null default 'private'
  check (visibility in ('private', 'org_public'));

alter table public.learning_paths
  add column if not exists visibility text not null default 'private'
  check (visibility in ('private', 'org_public'));

-- Filtered indexes so the learner-side "include org_public on dashboard"
-- query doesn't scan every private course on every render. Partial
-- indexes are tiny and only cover the rows that matter for the union.
create index if not exists courses_org_public_idx
  on public.courses (organization_id)
  where visibility = 'org_public';

create index if not exists learning_paths_org_public_idx
  on public.learning_paths (organization_id)
  where visibility = 'org_public';

notify pgrst, 'reload schema';

commit;
