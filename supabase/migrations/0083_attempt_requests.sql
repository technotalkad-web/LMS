-- 0083: extra-attempt requests & grants (revision rule, Phase 2).
--
-- A learner who used their official attempt(s) and did not pass can REQUEST
-- another official attempt, with a reason. An admin approves or rejects (with
-- an optional note), or bulk-grants an extra attempt to all failed learners of
-- a course. An approved, unexpired, unused row is a GRANT: the learner's next
-- launch becomes a fresh OFFICIAL retake instead of a revision run, and the
-- grant is marked used. The scoring engine widens the window by the number of
-- USED grants, so the retake is scored and (0081) becomes the official result
-- while the first score is retained for L&D.
--
-- One row models both a request and a grant: source='request' carries the
-- learner reason; source='bulk' is an admin-created approved grant with no
-- request. Writes go through the API on the service-role client after
-- authorization (RLS is read-only for learners/admins), matching the
-- organization-members route.

create table if not exists public.attempt_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  course_id        uuid not null references public.courses(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  status           text not null default 'pending'
                     check (status in ('pending', 'approved', 'rejected')),
  source           text not null default 'request'
                     check (source in ('request', 'bulk')),
  reason           text,                 -- learner's reason (null for bulk)
  decided_by       uuid references auth.users(id) on delete set null,
  decision_note    text,                 -- admin's optional comment
  decided_at       timestamptz,
  expires_at       timestamptz,          -- an approved grant expires; null = never
  used_at          timestamptz,          -- when the extra official retake was started
  used_attempt_id  uuid references public.course_attempts(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists attempt_requests_org_status_idx
  on public.attempt_requests (organization_id, status, created_at desc);
create index if not exists attempt_requests_user_course_idx
  on public.attempt_requests (user_id, course_id, status);

-- At most one OPEN request per learner per course (a pending one, or an
-- approved grant not yet used) — stops bulk + request double-granting and
-- duplicate pending rows.
create unique index if not exists attempt_requests_one_open_idx
  on public.attempt_requests (user_id, course_id)
  where status = 'pending' or (status = 'approved' and used_at is null);

alter table public.attempt_requests enable row level security;

-- Learners read their own rows; admins read/manage their org's. All WRITES go
-- through the API on the service-role client after authorization.
drop policy if exists "learners read their own attempt requests" on public.attempt_requests;
create policy "learners read their own attempt requests"
  on public.attempt_requests for select
  using (user_id = auth.uid());

drop policy if exists "admins read org attempt requests" on public.attempt_requests;
create policy "admins read org attempt requests"
  on public.attempt_requests for select
  using (public.is_org_admin(organization_id));

-- Explicit Data API grants (Supabase stops auto-granting new relations 2026-10-30).
grant select on public.attempt_requests to authenticated, service_role;
grant insert, update, delete on public.attempt_requests to service_role;

notify pgrst, 'reload schema';
