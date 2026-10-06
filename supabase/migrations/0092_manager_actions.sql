-- 0092: manager actions (Manager Report Card Phase 1, decision 6 — 2026-10-06).
--
-- An L1 manager may grant one extra official attempt to a direct report who
-- failed (the same approved-grant row the admin bulk grant creates). Grants
-- record who decided and where they came from; `source` gains 'manager' so
-- the Attempt Requests queue and reports can tell a manager's grant from an
-- admin bulk grant or a learner's request. Everything else (one open grant
-- per learner+course, expiry, used_attempt_id) is unchanged.
--
-- No new relation → no new grants. Idempotent.

alter table public.attempt_requests
  drop constraint if exists attempt_requests_source_check;
alter table public.attempt_requests
  add constraint attempt_requests_source_check
  check (source in ('request', 'bulk', 'manager'));

-- A lapsed grant (approved, never used, past expires_at) used to keep the
-- "one open row per learner+course" slot forever, so nobody could grant that
-- learner again. 'expired' closes such rows (the partial unique index only
-- covers pending / approved-unused); the manager grant sweeps them first.
alter table public.attempt_requests
  drop constraint if exists attempt_requests_status_check;
alter table public.attempt_requests
  add constraint attempt_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired'));

comment on column public.attempt_requests.source is
  'request = learner asked; bulk = admin bulk grant; manager = a line manager granted it from the Report Card (0092).';
comment on column public.attempt_requests.status is
  'pending | approved | rejected | expired (an approved grant that lapsed unused, closed so a new grant can be made — 0092).';

notify pgrst, 'reload schema';
