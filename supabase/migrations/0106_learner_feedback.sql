-- 0106_learner_feedback.sql — the Learner Feedback section of each course's
-- Reports page and its CSV (ADR 0021 step 1). Hand-apply in the SQL editor
-- with the role selector on postgres, staging first; never `supabase db push`
-- (the CLI is linked to production). Production in a sitting explained
-- beforehand and approved.
--
-- ORDER: deploy-safe in both orders (docs/MIGRATIONS.md). Code before the
-- file: the section shows one line ("Learner feedback is available after
-- migration 0106 is applied") and the CSV route answers 503
-- feedback_unavailable; nothing else on the Reports page changes. File before
-- the code: nothing reads the new objects until the code arrives. Recommended
-- on each environment: this file first, then the code (ADR 0021 section H).
--
-- Independent of 0105 (ADR 0020): this file names no object of 0105 and 0105
-- names none of this file's, so the two apply in either order.
--
-- REQUIRES 0100 (course_attempts.is_preview) and 0103
-- (course_attempts.is_revision). The DO block below refuses to run without
-- them. Both are applied on staging (0100 on 2026-10-20, 0103 on 2026-11-04;
-- ARCHITECTURE §1) and on production (2026-11-10, the v1.4.0 sitting).
--
-- NEVER PASTE AGAIN after this file: nothing. This file redefines no earlier
-- object; it only adds one index, one view and one function. (0004 re-pasted
-- would be a no-op: every statement there is guarded.)
--
-- Idempotent and retry-safe: `create index if not exists`, `create or
-- replace view`, `create or replace function`; the revokes and grants repeat
-- cleanly; a second paste changes nothing. One transaction: on a lock timeout
-- or a deadlock nothing changed, paste it again. Staging: paste when no spec,
-- CI e2e run or harness is in progress. Production: paste at a minute clear
-- of the crons' :03 / :07 quarter-hour offsets and of 03:30 UTC.
--
-- Row writes: none. Nothing in xapi_statements, course_attempts or profiles is
-- read into a new row, rewritten or deleted (ARCHITECTURE §3 principle 3).
--
-- Locks: the index build takes a SHARE lock on xapi_statements for one scan of
-- the table; the xAPI statements route's inserts wait for it, and the
-- learner's engine retries them (the route is write-once, ADR 0003 step 5).
-- lock_timeout 5 s: if the lock is not granted the whole file rolls back.
-- Production's table is empty on the day this file was written; staging's is
-- small. If Q1 below reads more than 1,000,000 rows, paste the index statement
-- ALONE first, as `create index concurrently if not exists …` outside any
-- transaction (the 0100 §7 preference for this table); this file then finds
-- it present and skips it. A concurrent build that fails leaves an INVALID
-- index of the same name, which `create index if not exists` would also skip:
-- if A5 below reads indisvalid = false, run
-- `drop index concurrently public.xapi_statements_responded_attempt_idx;`
-- and repeat the concurrent build before pasting this file.
--
-- Grants (literal; none relies on default privileges; docs/MIGRATIONS.md and
-- scripts/check-migration-grants.mjs, which sees the view only):
--   v_course_feedback_responses   security_invoker = on; revoke all from
--                                 public, anon, authenticated, service_role;
--                                 grant select to service_role. service_role
--                                 is named in the revoke (0103's form) so a
--                                 project's default privileges cannot leave
--                                 it insert, update, delete, truncate,
--                                 references or trigger on the view; A3 reads
--                                 exactly select. A view has no RLS: the
--                                 grant is the whole gate, and the only
--                                 readers are the Reports section and the
--                                 CSV route, both behind canManage (ADR 0021
--                                 section A).
--   course_feedback_summary(uuid) revoke all from public, anon,
--                                 authenticated, service_role; grant execute
--                                 to service_role.
--   xapi_statements               unchanged (0004: RLS on, members read their
--                                 own rows; the service role bypasses RLS).
--
-- BEFORE the apply (read-only; role postgres; record counts and ids only; on
-- production every count but Q1 is expected to be 0):
--   Q0  is this file already pasted?
--         select to_regclass('public.v_course_feedback_responses')      as has_view,
--                to_regprocedure('public.course_feedback_summary(uuid)') as has_fn,
--                exists (select 1 from pg_indexes
--                        where schemaname = 'public' and tablename = 'xapi_statements'
--                          and indexname = 'xapi_statements_responded_attempt_idx') as has_idx;
--   Q1  the table size, which decides the index path (see Locks above):
--         select count(*) from public.xapi_statements;
--   Q2  responded statements by interaction type (what the engines sent):
--         select s.raw->'object'->'definition'->>'interactionType' as interaction_type,
--                count(*) as statements,
--                count(*) filter (where s.raw->'result'->>'response' is null) as without_response
--         from public.xapi_statements s
--         where s.verb in ('http://adlnet.gov/expapi/verbs/responded', 'responded')
--         group by 1 order by 2 desc;
--   Q3  responded statements by attempt class (what the view will keep; the
--       object-id filter is the view's, so A1 equals the `eligible` row):
--         select case when ca.is_preview then 'preview'
--                     when ca.is_revision then 'revision'
--                     when ca.status = 'abandoned' then 'reset'
--                     else 'eligible' end as attempt_class,
--                count(*)
--         from public.xapi_statements s
--         join public.course_attempts ca on ca.id = s.attempt_id
--         where s.verb in ('http://adlnet.gov/expapi/verbs/responded', 'responded')
--           and s.raw->'object'->>'id' is not null
--         group by 1;
--   Q3b responded statements with no object id (the view drops them; expected 0):
--         select count(*) from public.xapi_statements s
--         where s.verb in ('http://adlnet.gov/expapi/verbs/responded', 'responded')
--           and s.raw->'object'->>'id' is null;
--   Q4  staging only: the attempt of course 89891b95 that held six responded
--       statements (ADR 0021 section G): its class decides what the page is
--       expected to show.
--         select ca.id, ca.is_preview, ca.is_revision, ca.status, m.role,
--                count(s.id) as responded
--         from public.course_attempts ca
--         join public.course_versions cv on cv.id = ca.course_version_id
--         left join public.organization_members m
--           on m.organization_id = ca.organization_id and m.user_id = ca.user_id
--         left join public.xapi_statements s
--           on s.attempt_id = ca.id
--          and s.verb in ('http://adlnet.gov/expapi/verbs/responded', 'responded')
--         where cv.course_id::text like '89891b95%'
--         group by ca.id, ca.is_preview, ca.is_revision, ca.status, m.role
--         having count(s.id) > 0;
--
-- AFTER the apply (read-only):
--   A1  the view answers, and keeps every eligible row (`rows` equals Q3's
--       `eligible` count):
--         select count(*) as rows, count(*) filter (where is_latest) as counted,
--                count(distinct course_id) as courses
--         from public.v_course_feedback_responses;
--   A2  staging only: the course of Q4. Each row is one (question, bucket);
--       expected: when Q4's class is `eligible`, sum(learners) over the rows
--       equals Q4's `responded` (one attempt, so every row is is_latest) and
--       the written comments appear as the bucket '__text__'; otherwise no row.
--         select interaction_type, response, learners, responses,
--                sum(learners) over () as learners_total
--         from public.course_feedback_summary(
--           (select id from public.courses where id::text like '89891b95%' limit 1))
--         order by interaction_id, response;
--   A3  the privilege matrix (the 0103 A5 form): every row returned is a
--       privilege that differs from the expectation, so the expected result
--       is no row; a row here is a defect in this file.
--         select r.rol, 'public.v_course_feedback_responses' as obj, p.priv
--         from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
--         where has_table_privilege(r.rol, 'public.v_course_feedback_responses', p.priv)
--               is distinct from (r.rol = 'service_role' and p.priv = 'select')
--         union all
--         select r.rol, 'public.course_feedback_summary(uuid)', 'execute'
--         from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         where has_function_privilege(r.rol, 'public.course_feedback_summary(uuid)', 'execute')
--               is distinct from (r.rol = 'service_role');
--   A4  the view keeps security_invoker (both spellings accepted):
--         select relname from pg_class
--         where relname = 'v_course_feedback_responses'
--           and not (coalesce(reloptions::text, '') ~ 'security_invoker=(on|true)');
--         no row.
--   A5  the index is present, partial and valid:
--         select indexdef from pg_indexes
--         where schemaname = 'public' and indexname = 'xapi_statements_responded_attempt_idx';
--         one row whose definition ends with the WHERE clause; and
--         select i.indisvalid from pg_index i
--         where i.indexrelid = 'public.xapi_statements_responded_attempt_idx'::regclass;
--         expected true. false means a concurrent build failed and left an
--         invalid index: drop it concurrently and repeat the build (Locks above).
--   A6  the per-course read uses the attempt path (informational; the plan
--       names xapi_statements_responded_attempt_idx or xapi_statements_attempt_idx,
--       never a sequential scan of xapi_statements, once the table has rows):
--         explain (costs off)
--         select * from public.v_course_feedback_responses
--         where course_id = (select id from public.courses limit 1);

begin;

-- A lock wait must never queue the app's reads and writes behind this file:
-- if a lock is not granted within 5 s the whole transaction rolls back
-- cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  if to_regclass('public.xapi_statements') is null then
    raise exception '0106 refused: public.xapi_statements is missing (apply 0004 first).';
  end if;
  for r in
    select * from (values
      ('course_attempts',      'is_preview',      '0100'),
      ('course_attempts',      'is_revision',     '0103'),
      ('course_attempts',      'organization_id', '0002'),
      ('course_attempts',      'status',          '0002'),
      ('course_versions',      'package_id',      '0030'),
      ('course_packages',      'language',        '0030'),
      ('course_packages',      'display_name',    '0030'),
      ('profiles',             'email',           '0027'),
      ('profiles',             'first_name',      '0011'),
      ('profiles',             'last_name',       '0011'),
      ('organization_members', 'employee_id',     '0006')
    ) as t(tbl, col, mig)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) then
      raise exception '0106 refused: %.% is missing (apply % first).', r.tbl, r.col, r.mig;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The partial index: feedback rows by attempt
-- ---------------------------------------------------------------------------
-- The view below is read per course, through the course's attempts. The
-- existing xapi_statements_attempt_idx (0004) would make every read touch
-- every statement of every attempt of the course (about 30 to 100 rows per
-- attempt) to keep the few responded ones; the existing xapi_statements_verb_idx
-- (0004) would make it touch every course's responded rows in the shared
-- database. This partial index holds only the responded rows, keyed by attempt,
-- so a course's read touches its own feedback rows and nothing else. Its
-- predicate is the view's verb filter, byte for byte, so the planner can use
-- it. It is small: feedback rows are a small share of all statements.
create index if not exists xapi_statements_responded_attempt_idx
  on public.xapi_statements (attempt_id)
  where verb in ('http://adlnet.gov/expapi/verbs/responded', 'responded');

comment on index public.xapi_statements_responded_attempt_idx is
  'Feedback statements (verb responded) by attempt, for v_course_feedback_responses (ADR 0021).';

-- ---------------------------------------------------------------------------
-- 2. v_course_feedback_responses: one row per eligible feedback statement
-- ---------------------------------------------------------------------------
-- The eligibility rule lives here and nowhere else, so the Reports section,
-- the summary function and the CSV route always agree (ADR 0021 section B):
--   verb responded          the engine's non-scored items (KIVO K-15); the bare
--                           spelling is admitted as 0031 admits it for answered
--   object id present       the question key
--   not a revision visit    a revision row stores only its session bookends
--                           (app/api/xapi/statements/route.ts, R-5); the filter
--                           is belt and braces
--   not a preview           a staff launch (0100 is_preview) is not learner
--                           feedback
--   not reset               an abandoned attempt is not shown as anything on
--                           any surface (ADR 0004 decision 9)
-- is_latest marks the learner's newest response to a question on the course
-- (a granted retake, ADR 0014, may answer the same slide again): the summary
-- counts those rows only; the CSV lists every row and carries the flag.
-- The partition includes course_id because two xAPI packages uploaded as two
-- courses can declare the same activity id.
-- The profile and member joins give the CSV its names and employee id in the
-- same read: the route must not pay one request per 150 learners (the Workers
-- plan allows 50 subrequests per request). Only service_role may select, and
-- it does so behind canManage.
create or replace view public.v_course_feedback_responses with (security_invoker = on) as
select
  s.id                                                   as statement_row_id,
  s.statement_id,
  s.attempt_id,
  ca.user_id,
  ca.organization_id,
  cv.course_id,
  ca.course_version_id,
  cv.package_id,
  cp.language                                            as slot_language,
  cp.display_name                                        as slot_display_name,
  p.email,
  p.first_name,
  p.last_name,
  m.employee_id,
  s.stored,
  nullif(s.raw->>'timestamp', '')                        as responded_at,
  s.raw->'object'->>'id'                                 as interaction_id,
  s.raw->'object'->'definition'->>'interactionType'      as interaction_type,
  s.raw->'object'->'definition'->'description'           as question,
  s.raw->'object'->'definition'->'name'                  as question_name,
  s.raw->'object'->'definition'->'scale'                 as scale,
  s.raw->'object'->'definition'->'choices'               as choices,
  s.raw->'result'->>'response'                           as response,
  coalesce(
    s.raw->'result'->'extensions'->'https://ambak.com/xapi/ext/question/unanswered' = to_jsonb(true),
    false)                                               as unanswered,
  row_number() over (
    partition by cv.course_id, ca.user_id, s.raw->'object'->>'id'
    order by s.stored desc, s.id desc
  ) = 1                                                  as is_latest
from public.xapi_statements s
join public.course_attempts ca on ca.id = s.attempt_id
join public.course_versions cv on cv.id = ca.course_version_id
left join public.course_packages cp on cp.id = cv.package_id
left join public.profiles p on p.id = ca.user_id
left join public.organization_members m
  on m.organization_id = ca.organization_id and m.user_id = ca.user_id
where s.verb in ('http://adlnet.gov/expapi/verbs/responded', 'responded')
  and s.raw->'object'->>'id' is not null
  and ca.is_revision = false
  and ca.is_preview = false
  and ca.status is distinct from 'abandoned';

alter view public.v_course_feedback_responses set (security_invoker = on);

comment on view public.v_course_feedback_responses is
  'Eligible learner feedback statements with the learner''s profile (ADR 0021): read by the service role only, behind canManage; never written.';

-- A view has no row-level security: the grant is the gate. service_role is in
-- the revoke so a project's default privileges cannot leave it more than the
-- select granted next (0103's form).
revoke all on public.v_course_feedback_responses from public, anon, authenticated, service_role;
grant select on public.v_course_feedback_responses to service_role;

-- ---------------------------------------------------------------------------
-- 3. course_feedback_summary(uuid): the section's figures, aggregated here
-- ---------------------------------------------------------------------------
-- One row per (question, bucket). A bucket is the response id the engine sent
-- (likert_0..4, star_1..n, yes, no, or a free value from another tool), the
-- marker '__text__' for a written comment (interaction type long-fill-in or
-- fill-in; its text is read separately, so the summary carries no comment
-- text from KIVO's types), or null for an item left unanswered. A third-party
-- responded item of any other type puts each distinct raw response in its own
-- bucket, so free text can reach the summary and a wordy item can fill the
-- reader's page; the reader flags a full page as capped.
-- learners = rows with is_latest in the bucket (one per learner); responses =
-- every eligible row of the question, is_latest or not, so the page can say
-- "N responses from M learners" when they differ. question, question_name,
-- scale and choices are the newest eligible statement's, whose language is
-- the package's declared language; the ids inside them are
-- language-independent. slot_languages lists the slots that contributed.
-- Bounded for KIVO's types: questions × (buckets + 1) rows, far below
-- PostgREST's 1000-row cap; the reader orders by (interaction_id, response).
create or replace function public.course_feedback_summary(p_course_id uuid)
returns table (
  interaction_id   text,
  interaction_type text,
  response         text,
  learners         bigint,
  responses        bigint,
  first_at         timestamptz,
  last_at          timestamptz,
  question         jsonb,
  question_name    jsonb,
  scale            jsonb,
  choices          jsonb,
  slot_languages   text[]
)
language sql
stable
security invoker
set search_path = public
as $$
  with eligible as (
    select v.*
    from public.v_course_feedback_responses v
    where v.course_id = p_course_id
  ),
  totals as (
    select e.interaction_id, count(*) as responses
    from eligible e
    group by e.interaction_id
  ),
  newest as (
    select distinct on (e.interaction_id)
      e.interaction_id, e.question, e.question_name, e.scale, e.choices
    from eligible e
    order by e.interaction_id, e.stored desc, e.statement_row_id desc
  ),
  latest as (
    select
      e.interaction_id,
      coalesce(e.interaction_type, 'other') as interaction_type,
      case
        when e.response is null then null
        when e.interaction_type in ('long-fill-in', 'fill-in') then '__text__'
        else e.response
      end as bucket,
      e.user_id,
      e.stored,
      e.slot_language
    from eligible e
    where e.is_latest
  )
  select
    l.interaction_id,
    l.interaction_type,
    l.bucket                                    as response,
    count(*)::bigint                            as learners,
    t.responses::bigint                         as responses,
    min(l.stored)                               as first_at,
    max(l.stored)                               as last_at,
    n.question,
    n.question_name,
    n.scale,
    n.choices,
    coalesce(
      array_agg(distinct l.slot_language) filter (where l.slot_language is not null),
      '{}'::text[])                             as slot_languages
  from latest l
  join totals t on t.interaction_id = l.interaction_id
  join newest n on n.interaction_id = l.interaction_id
  group by l.interaction_id, l.interaction_type, l.bucket, t.responses,
           n.question, n.question_name, n.scale, n.choices
  order by l.interaction_id, l.bucket;
$$;

comment on function public.course_feedback_summary(uuid) is
  'Learner feedback figures per question and bucket for one course (ADR 0021); service role only, behind canManage; KIVO comments (long-fill-in, fill-in) are bucketed as __text__, never carried as text.';

revoke all on function public.course_feedback_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.course_feedback_summary(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
