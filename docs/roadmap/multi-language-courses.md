# RFC: Multi-Language SCORM Packages per Course

**Status:** Draft · **Owner:** TBD · **Created:** 2026-05-23
**Ticket:** #158 · **Estimated effort:** ~10 hours dev + ~4 hours QA
**Target window:** Post-launch, week 2+ once prod traffic is stable.

---

## 1. Goal

Allow tenants to ship a single course in multiple languages without
duplicating the course shell (title, description, assignments,
reminders, completion rules). Learners pick their preferred language at
first launch, the system remembers it, and they can switch later with
an appropriate progress-loss warning.

This is the most-requested feature in the LMS's competitive bracket
(Docebo, TalentLMS, Coursera Business all support it) and unblocks
selling to multi-region enterprises like Ambak's parent group, who
employ Hindi-, Bengali-, and Tamil-speaking learners alongside English.

## 2. User stories

### Admin
- As an admin, I can upload **multiple SCORM packages** to a single
  course, **each tagged with its language** (English, Hindi, etc.).
- I can see, on the course detail page, **which languages this course
  exists in** and their version numbers.
- I can **add** a language later (upload an additional package) without
  re-creating the course or losing assignments / progress.
- I can **deprecate** a language (mark it inactive) without deleting
  learner progress in that language.

### Learner — first launch
- If the course has **only one** language package, I launch directly
  with **no picker** (existing behavior, unchanged).
- If the course has **multiple** languages, I see a **language-picker
  modal** before the launch iframe loads. The picker shows each
  language's native name (e.g. "हिन्दी" for Hindi) and a small
  language code badge.

### Learner — re-launch
- The system **remembers** my last-used language for this course and
  defaults to it. No picker shown.
- A **"Change language"** button is visible on the course launch page
  (or course detail page). Clicking opens the same picker.
- **If I have in-progress attempts** in the current language and I try
  to switch, I see this confirmation modal:

  > *We will retain your chosen language when you continue the course.
  > If you switch languages during the course, your progress will be
  > reset.*

  Confirming archives my in-progress attempt and starts fresh with the
  new language. Cancelling closes the modal with no state change.

## 3. Current state (what we have today)

- `courses` table — one row per course, has `current_version_id`
- `course_versions` table — `(id, course_id, version_number,
  manifest_type, launch_url, manifest_data, uploaded_at)`. Many
  versions per course (admin uploads new versions over time); the
  course's `current_version_id` points at the active one.
- `course_attempts` table — `(id, user_id, course_version_id, status,
  cmi_data, completion_status, success_status, score, started_at,
  completed_at)`. Tied to a specific version.
- Launch page `app/[org]/(learner)/courses/[courseId]/launch/page.tsx`
  — fetches `current_version_id`, renders the iframe.
- Upload flow `app/api/courses/upload/route.ts` (and the admin
  `/library/upload` page) — single SCORM zip per upload.

15+ other places query `course_versions`. The shape of the change to
`course_versions` ripples through all of them.

## 4. Data model options

### Option A — Add `language` column to `course_versions`

```sql
alter table public.course_versions add column language text;
-- ISO 639-1 codes ("en", "hi", "ta") OR null (legacy single-language).

create unique index course_versions_course_lang_version_idx
  on public.course_versions (course_id, language, version_number)
  where language is not null;
```

**Pros:**
- One-line schema change. Backward-compatible (legacy rows are `NULL`
  and treated as the single language).
- Existing version-history flow ("admin uploads v2 of English")
  continues to work — `version_number` increments per language.

**Cons:**
- `courses.current_version_id` semantics break down. There's no single
  "current version" anymore — there's a current version per language.
  Options: (a) repurpose `current_version_id` as "default language's
  current version," (b) drop it entirely and compute "current" via
  `select max(version_number) … where course_id=X group by language`.
  Both are confusing.
- Conflates two orthogonal concerns: language identity (HI vs EN) and
  versioning (v1 of EN vs v2 of EN). Future features like "show me
  which languages are out-of-date" become awkward to express.

### Option B — New `course_packages` table (recommended for long term)

```sql
create table public.course_packages (
  id              uuid primary key default uuid_generate_v4(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  language        text not null,                       -- "en", "hi", "ta"
  display_name    text,                                -- "English", "हिन्दी"
  is_active       boolean not null default true,
  current_version_id uuid references public.course_versions(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (course_id, language)
);

-- course_versions gets retargeted to packages:
alter table public.course_versions add column package_id uuid
  references public.course_packages(id) on delete cascade;
-- Migrate existing rows: create a single 'default' package per course
-- with language=null, point its current_version_id at the existing
-- courses.current_version_id, and update all course_versions to point
-- at that package.
-- Eventually drop course_versions.course_id once all reads are migrated.
```

**Pros:**
- Cleanly separates language from version. "Which languages exist" =
  `select language from course_packages where course_id=X`. "Latest
  English version" = `course_packages → current_version_id`.
- Future-proofs: can add per-language metadata (display_name,
  default_for_locale, is_active, etc.) without polluting versions.
- Mirrors how Docebo / TalentLMS / SAP SuccessFactors all model this
  (researched 2026-05-23). Consistent with industry mental model.

**Cons:**
- Bigger migration. ~50 LOC of SQL plus a careful backfill that touches
  every existing course.
- Every existing query of `course_versions` that joined to `courses`
  via `course_id` needs to be audited for whether it should now join
  via `package_id`.

**Recommendation: Option B.** The cost is real (3–4 extra hours of
migration + audit work) but it's the data model the next 100 features
will rest on. Saves a much bigger refactor in 6 months.

## 5. Language preferences storage

A new lightweight table that survives across browsers (localStorage
alone is insufficient — user logs in on phone after picking on laptop):

```sql
create table public.course_language_preferences (
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  language    text not null,
  set_at      timestamptz not null default now(),
  primary key (user_id, course_id)
);

alter table public.course_language_preferences enable row level security;
create policy "users manage own language prefs"
  on public.course_language_preferences for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Read on every course launch. Defaults to the user's `profile.locale`
(future field) → org default language (future field) → first available
language alphabetically.

## 6. API surface

### POST `/api/courses/:courseId/packages`
Upload a new SCORM package as a language variant of an existing
course. Body: `multipart/form-data` with `file` + `language`.
Returns the new package_id + initial version_id.

### PATCH `/api/courses/:courseId/packages/:packageId`
Update package metadata (display_name, is_active). Used by admin to
deprecate a language or rename its display label.

### DELETE `/api/courses/:courseId/packages/:packageId`
Hard-delete a language package. Refuses if any user has in-progress
attempts in this language (admin must mark inactive instead).

### GET `/api/courses/:courseId/languages`
Returns the languages available for this course, plus the requesting
user's saved preference. Used by the launch page's language picker.

### PUT `/api/courses/:courseId/language-preference`
Body: `{ language: string, restart_if_in_progress?: boolean }`.
Saves the preference. If the user has in-progress attempts in a
different language AND `restart_if_in_progress=true`, marks them
`status='abandoned'` and lets the new launch start fresh. If
in-progress exists and `restart_if_in_progress` is false, returns
HTTP 409 with `{ requires_confirm: true, in_progress_attempts: N }`
so the client can show the warning modal.

## 7. Launch flow

```
Learner clicks "Launch course"
        │
        ▼
GET /api/courses/:courseId/languages
        │
        ▼
   ┌────────┐
   │ 1 lang │ → existing single-version launch (unchanged)
   └────────┘
        │
   ┌────────┐
   │ N lang │ → has saved preference?
   └────────┘       │
                    ├─ YES → launch the matching package
                    │
                    └─ NO  → render language picker modal
                              user picks → PUT preference → launch
```

The current launch page (`app/[org]/(learner)/courses/[courseId]/launch/page.tsx`)
needs to take an optional `?lang=` query param. The page redirects
to itself with the correct lang if a saved preference exists. The
language picker modal is a new Client Component that renders before
the iframe loads.

## 8. UI surface

### Admin
- **`/library/upload`** — rebuild as multi-file uploader. Each row:
  file input + language picker (dropdown of ISO codes with native
  names) + display-name override. "Add another language" button.
  Submit creates one course + N packages atomically.
- **`/library/[courseId]`** (course detail page) — new "Languages"
  section showing the matrix:

  | Language | Version | Last updated | Active | Actions |
  |---|---|---|---|---|
  | English | v3 | 2026-05-12 | ✓ | Upload v4 · Deactivate |
  | हिन्दी | v1 | 2026-05-20 | ✓ | Upload v2 · Deactivate |
  | + Add language | | | | |

### Learner
- **First-launch language picker modal** — full-screen modal on top
  of the course iframe. Shows each language as a card with the
  native script display name and a small ISO code badge. Click to
  pick → modal closes → iframe loads.
- **"Change language" UI** — small dropdown / button in the launch
  page header. Reuses the same picker modal.
- **Progress-reset confirmation modal** — uses the exact warning text
  specified in section 2. Two buttons: "Cancel" and "Switch and reset
  progress". Confirm fires the PUT with `restart_if_in_progress: true`.

## 9. RLS + multi-tenancy

- `course_packages` inherits org via `course_id → courses.organization_id`.
  RLS: "users in org can read; admins in org can write."
- `course_language_preferences` is per-user; the existing
  `user_id = auth.uid()` policy is sufficient — no cross-tenant risk
  because course_id is org-scoped.
- Audit script (`scripts/audit.sql`) needs a new check that every
  language package belongs to a course in the same org as any
  attempts referencing it. Add to the weekly RLS audit cron.

## 10. Migration plan

```sql
-- Migration 0029_multi_language_courses.sql
begin;

-- 1. course_packages table
create table public.course_packages (...);

-- 2. backfill: one "default" package per existing course
insert into public.course_packages (id, course_id, language, current_version_id)
  select uuid_generate_v4(), c.id, null, c.current_version_id
  from public.courses c;

-- 3. add package_id to course_versions, backfill from existing course_id
alter table public.course_versions add column package_id uuid
  references public.course_packages(id) on delete cascade;
update public.course_versions cv
  set package_id = cp.id
  from public.course_packages cp
  where cp.course_id = cv.course_id;
alter table public.course_versions alter column package_id set not null;

-- 4. course_language_preferences
create table public.course_language_preferences (...);

-- 5. RLS + indexes + notify pgrst
commit;
```

**Backward-compat strategy:**
- Existing reads of `course_versions.course_id` still work (we don't
  drop the column).
- The default package has `language = null`, which the launch logic
  treats as "single-language course, no picker."
- All existing functionality continues to work unchanged until the
  admin uploads a SECOND language package for any course.

## 11. Phased delivery

| Phase | Scope | Effort | Ship |
|---|---|---|---|
| 0 | Migration 0029 + RLS policies + backfill | 2h | Week 1 |
| 1 | Admin multi-package upload UI + APIs | 3h | Week 1 |
| 2 | Learner launch logic (lang detection, picker modal) | 2h | Week 2 |
| 3 | Saved preference + change-language UI | 2h | Week 2 |
| 4 | Progress-reset warning + abandon-and-restart endpoint | 2h | Week 2 |
| 5 | Audit script update + Playwright spec | 1h | Week 2 |
| **Total** | | **12h** | |

## 12. Open questions / decisions needed

1. **Language list scope.** Hard-coded list of 50 ISO codes? Per-org
   configurable allow-list (org settings page)? Free-form text?
   **Recommendation:** start with a hard-coded list of 20 commonly-used
   codes covering 95% of business need. Add per-org override later.
2. **Default language fallback chain.** When a user has no saved
   preference: pick from `profiles.locale` → `organizations.default_language`
   → first package alphabetically? Need profile.locale and org.default_language
   fields if so. **Recommendation:** first available alphabetically for v1;
   add profile.locale field in a follow-up.
3. **Same-language version upgrade.** When admin uploads "v2 of
   English," do learners in-progress on v1 get migrated to v2 (with
   suspend_data carry-over)? Or stay on v1 until they finish? This is
   true today for single-version courses; need to preserve the same
   semantics per language.
4. **Search & assignment behavior.** Should an "assign Hindi version
   to Hindi-speaking team" workflow exist? Or do all learners see all
   languages? **Recommendation:** all learners see all languages
   for v1; per-language assignment is a separate ticket.
5. **Email integration.** When a course has multiple languages, what
   language does the assignment-notification email use? Org default?
   User preference? **Recommendation:** use the learner's profile.locale
   (when that field exists) or the org default for v1.

## 13. Out of scope (for v1)

- Multi-language learning paths (separate RFC needed — paths are a
  client component today and need their own refactor; see ticket #153).
- Per-team language assignment.
- Auto-translation of course metadata (course title, description) into
  each supported language.
- Right-to-left language support (Arabic, Hebrew) in the SCORM
  iframe — handled by the content package itself, not by us.
- Live language switching mid-attempt without progress reset (would
  require the SCORM package to support runtime locale switching, which
  most don't).

## 14. Risks

- **Schema drift recurrence.** Same risk pattern as the
  `profiles.user_id → profiles.id` undocumented Dashboard edit (fixed
  in migration 0027). Mitigation: all schema changes go through
  numbered migration files, never through Dashboard.
- **Regression on single-language launch path.** Existing flow used
  by 100% of today's courses. Mitigation: keep the default-package
  pattern (`language=null`) so the existing path is untouched until
  admin opts in.
- **xAPI attempt-to-package linkage.** Today an attempt is tied to
  `course_version_id`; with packages, an attempt is implicitly tied
  to a package via that. Need to verify the xAPI cmi5 launch token
  flow still resolves the right package — see ticket #145.
- **Email-client preview rendering** of the language picker is N/A
  (it's an in-app modal, not email content), but the assignment email
  may want to mention the available languages, which adds template
  complexity — flagged in section 12.5.

## 15. Pre-build checklist

Before writing any code:

- [ ] Settle the 5 open questions in section 12 (write decisions here)
- [ ] Validate with 1–2 tenant admins that the picker UX matches
      their mental model (paper prototype, no engineering required)
- [ ] Confirm at least one tenant intends to use this within 90 days
      (don't build features that nobody asks for)
- [ ] Schedule a 1-hour design review with the team to argue Option A
      vs Option B before committing to migration 0029

---

**Next action when ready to start:** owner reads sections 4–6, decides
on Option B (or argues for A), updates this RFC with decisions on the
five open questions, then writes migration 0029 as Phase 0.
