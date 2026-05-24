-- Phase 9.3: editable metadata on courses + learning paths.
--
-- Adds two fields admins commonly need:
--   * duration_minutes — estimated time to complete (display only, optional)
--   * is_active        — whether the asset surfaces to learners
--
-- The existing `courses.status` enum (draft/published/archived) is left in
-- place for backward compatibility, but learner-facing queries should now
-- filter on `is_active` for both courses and paths.

alter table public.courses
  add column if not exists duration_minutes integer,
  add column if not exists is_active        boolean not null default true;

alter table public.learning_paths
  add column if not exists duration_minutes integer,
  add column if not exists is_active        boolean not null default true;

-- Migrate existing `status` semantics onto `is_active` for sensible defaults.
update public.courses
set is_active = (status <> 'archived')
where status = 'archived';

create index if not exists courses_active_idx
  on public.courses(organization_id, is_active);
create index if not exists learning_paths_active_idx
  on public.learning_paths(organization_id, is_active);

notify pgrst, 'reload schema';
