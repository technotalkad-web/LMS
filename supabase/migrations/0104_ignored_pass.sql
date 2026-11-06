-- 0104_ignored_pass.sql — the record of the new-engine result guard (ADR 0017
-- step 11). Hand-apply in the SQL editor with the role selector on postgres,
-- staging first; never `supabase db push` (the CLI is linked to production).
-- Production in a sitting explained beforehand and approved.
--
-- ORDER: deploy-safe in both orders (docs/MIGRATIONS.md). The guard's code holds a
-- result without this column: updateAttemptFailSoft retries without the key and
-- logs `ignored_pass_unrecorded`, every surface reads the column deploy-safely and
-- is absent without it, and only the record is lost until this file is applied.
-- Today's code never names the column, so this file changes nothing for it.
--
-- Independent of 0100 and 0103: it names no object of either, so it applies on a
-- database at 0099, at 0103 or at 0100 alike (the rehearsal scenarios 0104-at-0099,
-- 0103-then-0104 and 0100-0103-then-0104).
--
-- Idempotent and retry-safe: every statement is guarded (`if not exists`) and the
-- comment, the grants and the revoke repeat cleanly; a second paste changes
-- nothing. One transaction: on a lock timeout or a deadlock nothing changed, wait
-- a minute and paste it again. Staging: paste when no spec, CI e2e run or harness
-- is in progress.
--
-- Row writes: none, and nothing is backfilled. The column is added empty, which is
-- quick. From the alter to the commit the file holds ACCESS EXCLUSIVE on
-- course_attempts, so reads and writes wait out the index build; the index is
-- partial on a column that is null on every row, so the scan is short and the
-- index small.
--
-- No new relation, so scripts/check-migration-grants.mjs checks nothing here; the
-- reviewer confirms by hand that this file creates no relation and restates the
-- grants. RLS on course_attempts is unchanged: members read their own attempts and
-- admins their organisation's, and no write policy exists since 0099.
--
-- After apply, on each environment, read-only: expect 0.
--   select count(*) from public.course_attempts where ignored_pass is not null;

begin;

set local lock_timeout = '5s';

alter table public.course_attempts add column if not exists ignored_pass jsonb;

comment on column public.course_attempts.ignored_pass is
  'The new-engine result guard''s record (ADR 0017): on a course version built with the KIVO A.1 engine or later, a result received after the row''s final fail and not applied (runtime, course_version_id, engine_version, the failing result, each ignored result: statement id, cmi5 session id, time, score; count = ignored passes), and a D-2 upgrade applied because a KIVO build''s stamp could not be read or the stored launch file could not be read (an entry with applied = true and its reason; never for a package read as non-KIVO). Written by the server only; never a grading input.';

-- Serves the Attention and Reports reads, newest first.
create index if not exists course_attempts_ignored_pass_idx
  on public.course_attempts (organization_id, ((ignored_pass->>'last_at')))
  where ignored_pass is not null;

-- The 0099 grants cover the new column and are restated literally.
revoke insert, update, delete on public.course_attempts from anon, authenticated;
grant select on public.course_attempts to authenticated;
grant select, insert, update, delete on public.course_attempts to service_role;

notify pgrst, 'reload schema';

commit;
