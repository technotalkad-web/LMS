-- 0085: record how many official attempts the learner had already USED when an
-- extra-attempt request (or bulk grant) was created.
--
-- Why: before an admin approves/rejects, they must see the learner's attempt
-- context — "1st attempt failed → Requesting 2nd attempt". For a PENDING
-- request that is computed live, but once decided the live scoring moves on
-- (the grant adds another official attempt), so the history and any report
-- would lose the context. Storing the count at request/grant time preserves it
-- for the request history and reports.
--
-- `attempts_used` = the learner's completed OFFICIAL (scored) attempts for the
-- course at the moment the row was created (base window + already-consumed
-- grants). The requested attempt number is attempts_used + 1. Nullable: old
-- rows and any fail-soft write leave it null, and the UI falls back to live
-- scoring for those.
--
-- Column only (on the existing 0083 table) — the table's Data API grants
-- already cover it; no new grant needed.

alter table public.attempt_requests
  add column if not exists attempts_used integer;

notify pgrst, 'reload schema';
