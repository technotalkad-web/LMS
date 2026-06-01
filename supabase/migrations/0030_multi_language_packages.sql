-- Phase 11: multi-language SCORM packages per course (#158, Phase 0).
--
-- Adds the data model that supports a single course existing in multiple
-- language variants without duplicating the course shell. See the full
-- RFC at docs/roadmap/multi-language-courses.md.
--
-- Model:
--   - course_packages: one row per language variant of a course
--     (English variant, Hindi variant, etc.). For legacy single-language
--     courses migrated by this script, language IS NULL, representing
--     "no language specified — single-package course."
--   - course_versions: gets a package_id column. Each version belongs to
--     exactly one package. Within a package, version_number sequences
--     independently (admin can upload v3 of English while Hindi is still
--     on v1).
--   - course_language_preferences: per-user per-course saved choice so
--     learners don't see the picker on every launch.
--
-- Backward-compat: existing reads of course_versions.course_id continue
-- to work — we keep the column. The launch flow treats a course with
-- exactly one package (NULL or otherwise) as the legacy single-lang case
-- and skips the picker.

begin;

-- ---- 1. course_packages ----
create table public.course_packages (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null references public.courses(id) on delete cascade,
  -- ISO 639-1 code ('en', 'hi', 'ta'). NULL means "legacy single-language".
  language            text,
  -- "English", "हिन्दी" — what the picker shows to the learner. NULL
  -- means "fall back to the language code's canonical name."
  display_name        text,
  -- Admins can deactivate a package without losing learner progress.
  -- Deactivated packages don't appear in the launch picker.
  is_active           boolean not null default true,
  -- Points at the current "live" version of this package. FK added in
  -- step 4 below (deferred because course_versions doesn't yet have
  -- the rows to reference).
  current_version_id  uuid,
  created_at          timestamptz not null default now()
);

-- One package per (course, language). Use partial unique indexes so:
--   - At most one NULL-language (legacy) package per course
--   - At most one package per (course, language) for non-null languages
-- Plain UNIQUE(course_id, language) doesn't suffice because Postgres
-- treats NULL values as distinct under default unique semantics.
create unique index course_packages_course_lang_idx
  on public.course_packages (course_id, language)
  where language is not null;
create unique index course_packages_course_default_idx
  on public.course_packages (course_id)
  where language is null;

-- ---- 2. course_versions.package_id ----
alter table public.course_versions
  add column if not exists package_id uuid
  references public.course_packages(id) on delete cascade;

-- ---- 3. Backfill: one default package per existing course ----
insert into public.course_packages (course_id, language, current_version_id)
  select c.id, null, c.current_version_id
  from public.courses c
  where not exists (
    select 1 from public.course_packages cp
    where cp.course_id = c.id and cp.language is null
  );

-- Point every existing course_version at its course's default package.
update public.course_versions cv
  set package_id = cp.id
  from public.course_packages cp
  where cp.course_id = cv.course_id
    and cp.language is null
    and cv.package_id is null;

-- All existing versions are now linked. Enforce NOT NULL.
alter table public.course_versions
  alter column package_id set not null;

-- ---- 4. Deferred FK on course_packages.current_version_id ----
-- Couldn't add at CREATE TABLE time because the table needed to exist
-- before backfill could reference it. Now safe.
alter table public.course_packages
  add constraint course_packages_current_version_fk
  foreign key (current_version_id)
  references public.course_versions(id)
  on delete set null;

-- ---- 5. course_language_preferences ----
create table public.course_language_preferences (
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  language    text not null,
  set_at      timestamptz not null default now(),
  primary key (user_id, course_id)
);

-- ---- 6. RLS ----
alter table public.course_packages enable row level security;

drop policy if exists "org members read packages" on public.course_packages;
create policy "org members read packages"
  on public.course_packages for select to authenticated
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
  ));

drop policy if exists "org admins write packages" on public.course_packages;
create policy "org admins write packages"
  on public.course_packages for all to authenticated
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin')
  ))
  with check (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin')
  ));

alter table public.course_language_preferences enable row level security;

drop policy if exists "users manage own language prefs"
  on public.course_language_preferences;
create policy "users manage own language prefs"
  on public.course_language_preferences for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

notify pgrst, 'reload schema';

commit;
