-- 0103_revision_visits.sql — revision visits, the one-official-attempt clamp
-- and the one-transaction grant (ADR 0014 step 2: the owner's policy of
-- 2026-10-21, accepted 2026-10-28). Hand-apply in the SQL editor with the
-- role selector on postgres, staging first; never `supabase db push` (the
-- CLI is linked to production).
--
-- ORDER (binding, ADR 0014 step 2; the reverse of 0099's rule): this file
-- BEFORE the code of ADR 0014 PR 1a reaches any deployment that shares the
-- database. Today's code tolerates this file: nothing errors (no insert
-- names the new columns, `select *` reads them, the new source list is a
-- superset), and the policy clamp of section 4 takes effect at once on every
-- deployment of that database (the app reads the policy through the RPC; the
-- views and the XP window call the function). PR 1a's code refuses revision
-- and grant launches on a database without this file, by design (ADR 0014
-- step 3: the policy is never silently unenforced).
--   Staging: only after the KIVO A.1 real-platform runs end, and before the
--   PR 1a push (its CI e2e job runs against the staging database).
--   Production: in an owner sitting explained beforehand and approved,
--   before the tag that carries PR 1a and PR 1b together and before any
--   course goes live there.
--
-- Independent of 0100: nothing here depends on a 0100 object (Q0 below only
-- asks whether one is present), so the file applies on production at 0099
-- exactly as on staging, with or without 0100 (the rehearsal scenarios
-- 0103-no-0100, p4-0100-then-0103 and 0103-then-0100).
--
-- NEVER paste 0073, 0081, 0090, 0092, 0095 or 0099 again after this file:
--   0073 and 0081 restore the unclamped effective_attempt_policy(uuid);
--   0090 and 0099 restore v_course_attempt_scoring / v_course_attempt_summary
--   without the is_revision clause; 0092 and 0095 narrow the source check
--   and fail outright once a 'restart' row exists.
--
-- Idempotent and retry-safe: every statement is guarded (`if not exists`,
-- `drop … if exists`, `create or replace`) and the grants and revokes
-- repeat cleanly; a second paste changes nothing. One transaction: on a lock
-- timeout or a deadlock nothing changed, paste it again. Staging: paste when
-- no spec, CI e2e run or harness is in progress. Production: paste at a
-- minute clear of the crons' :03 / :07 quarter-hour offsets and of 03:30 UTC.
--
-- Row writes: none. The file takes ACCESS EXCLUSIVE locks on course_attempts,
-- attempt_requests and both views until commit; it writes no row, so it is
-- quick. The re-added source check validates every attempt_requests row
-- (the new list is a superset of 0095's, so it cannot fail).
--
-- PREREQUISITES (the DO block below refuses to run without them):
--   0034  course_attempts.learning_path_id     (consume_grant's insert)
--   0053  course_attempts.last_activity_at
--   0058  course_attempts.journey_enrollment_id and journey_day
--   0062  index course_attempts_one_in_progress_idx (consume_grant's 23505)
--   0081  courses.pass_required; effective_attempt_policy(uuid) with the
--         0081 return table (section 4 keeps it byte for byte)
--   0083  public.attempt_requests
--   0090  index attempt_requests_used_attempt_idx;
--         v_course_attempt_summary.official_attempt_id
--   0092  attempt_requests_status_check admits 'expired'
--   0095  attempt_requests_source_check admits 'ticket'
--   0099  v_course_attempt_summary.live_attempt_count (section 6 restates the
--         0099 body; an older view is refused, never given other columns)
--
-- What it does:
--   1. course_attempts.is_revision (boolean, not null, default false).
--   2. attempt_requests: source 'restart'; reissued_from; override_confirmed.
--   3. revision_visits: one row per revision visit, analytics only; deny-all,
--      the service role selects and inserts, nobody updates or deletes.
--   4. effective_attempt_policy(uuid): the Q1 clamp, one official attempt
--      (1 / first / null / true / practice) for every course; the legacy
--      rule row, when there is one, still names source and source_id.
--   5. v_course_attempt_scoring: the 0090 body; its completed CTE excludes
--      revision rows (the filter parenthesised).
--   6. v_course_attempt_summary: the 0099 body; its base CTE excludes
--      revision rows.
--   7. flag_revision_attempt(uuid): the cutover flag, one conditional update.
--   8. record_revision_visit(…): one visit row, deduplicated over 10 seconds.
--   9. consume_grant(…): a grant consumed in one transaction, with the
--      unavailable / used / expired / retake_live / stale / stands refusals.
--
-- Beyond the ADR's text (the lead's decisions of 2026-10-29, listed in the
-- ADR 0014 addendum note): consume_grant's consistency check (errcode 22023);
-- the indexes revision_visits_attempt_idx, revision_visits_user_idx and
-- attempt_requests_reissued_from_idx; service_role named in the
-- revision_visits revoke, so no role can update, delete or truncate a visit
-- whatever a project's default privileges grant.
--
-- Grants (literal, none relies on default privileges; docs/MIGRATIONS.md,
-- scripts/check-migration-grants.mjs, which sees the relations only):
--   revision_visits             revoke all from anon, authenticated,
--                               service_role; grant select, insert to
--                               service_role (the 0100 session-table
--                               pattern, without its update grant)
--   v_course_attempt_scoring,   alter view … set (security_invoker = on);
--   v_course_attempt_summary    grant select to authenticated, service_role
--   effective_attempt_policy    revoke all from public, anon; grant execute to
--                               authenticated, service_role (the invoker view
--                               calls it as the learner)
--   the three new functions     revoke execute from public, anon,
--                               authenticated; grant execute to service_role
--
-- BEFORE the apply (read-only; role postgres; record ids and counts only;
-- on production every count is expected to be 0):
--   Q0  the environment: is 0100 on this database (it decides only which
--       rehearsal scenario matches, never whether this file may apply), and
--       is this file already pasted?
--         select to_regclass('public.package_certifications') as has_0100,
--                to_regclass('public.revision_visits') as has_0103_table,
--                exists (select 1 from information_schema.columns
--                        where table_schema = 'public' and table_name = 'course_attempts'
--                          and column_name = 'is_revision') as has_0103_column;
--   Q1  legacy rules the clamp overrides (ADR 0014 step 9):
--         select id, organization_id, scope, target_id, max_scored_attempts, official_basis,
--                official_attempt_number, after_limit
--         from public.attempt_scoring_rules
--         where max_scored_attempts > 1 or official_basis <> 'first' or after_limit = 'block';
--   Q2  learners whose derived official result can change under the clamp:
--         select course_id, user_id, max_scored_attempts, official_basis,
--                completed_attempts, official_attempt_id, official_status
--         from public.v_course_attempt_scoring
--         where (max_scored_attempts > 1 or official_basis <> 'first') and completed_attempts > 1;
--   Q3  the cutover count (ADR 0014 step 3; an upper bound, it ignores slot
--       routing): unflagged in-progress rows the cutover rule would meet.
--         select count(*)
--         from public.course_attempts a
--         join public.course_versions v on v.id = a.course_version_id
--         where a.status = 'in_progress'
--           and not (a.completion_status = 'completed' or a.success_status = 'passed')
--           and not exists (select 1 from public.attempt_requests ar
--                           where ar.used_attempt_id = a.id and ar.status = 'approved')
--           and exists (select 1 from public.course_attempts b
--                       join public.course_versions bv on bv.id = b.course_version_id
--                       where b.user_id = a.user_id and bv.course_id = v.course_id
--                         and b.status <> 'abandoned'
--                         and (b.completion_status = 'completed' or b.success_status = 'passed'));
--   Q4  approved, unused grants that consume_grant would expire at the
--       learner's next launch (every grant reads override_confirmed = false
--       after this file; read together with Q2):
--         select ar.id, ar.user_id, ar.course_id, ar.decided_at, s.official_status, c.pass_required,
--                oa.completed_at as official_completed_at,
--                (ar.decided_at is not null and ar.decided_at < oa.completed_at) as would_be_stale
--         from public.attempt_requests ar
--         join public.courses c on c.id = ar.course_id
--         join public.v_course_attempt_scoring s on s.course_id = ar.course_id and s.user_id = ar.user_id
--         join public.course_attempts oa on oa.id = s.official_attempt_id
--         where ar.status = 'approved' and ar.used_at is null
--           and (ar.expires_at is null or ar.expires_at > now())
--           and (s.official_status = 'passed'
--                or (s.official_status <> 'failed' and not c.pass_required)
--                or (ar.decided_at is not null and ar.decided_at < oa.completed_at));
--   On staging, the Q3 count and the Q1 / Q2 learners are recorded under
--   ADR 0014's acceptance note (ids and counts only).
--
-- AFTER the apply (read-only except the two refreshes):
--   A1  select public.refresh_report_views();
--         six entries, every one error = null; then
--       select public.refresh_gamification_views();
--         two entries (mv_leaderboard, mv_learner_metrics), every one
--         error = null. Staging has no scheduled crons, so nothing else
--         refreshes these two.
--   A2  select is_revision, count(*) from public.course_attempts group by 1;
--         only false.
--   A3  select count(*) from public.revision_visits;
--         0.
--   A4  the views keep security_invoker (both spellings accepted):
--         select relname from pg_class
--         where relname in ('v_course_attempt_scoring', 'v_course_attempt_summary')
--           and not (coalesce(reloptions::text, '') ~ 'security_invoker=(on|true)');
--         no row.
--   A5  the privilege matrix, with the same expectations as the rehearsal
--       (scripts/migration-rehearsal/assert-0103.sql, check 2): every row it
--       returns is a privilege that differs from the expectation, so the
--       expected result is no row; a row here is a defect in this file, not
--       an environment fact to note.
--         select r.rol, 'public.revision_visits' as obj, p.priv
--         from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
--         where has_table_privilege(r.rol, 'public.revision_visits', p.priv)
--               is distinct from (r.rol = 'service_role' and p.priv in ('select', 'insert'))
--         union all
--         select r.rol, f.fn, 'execute'
--         from (values ('public.flag_revision_attempt(uuid)', false),
--                      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)', false),
--                      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)', false),
--                      ('public.effective_attempt_policy(uuid)', true)) as f(fn, learners_too)
--         cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         where has_function_privilege(r.rol, f.fn, 'execute')
--               is distinct from (r.rol = 'service_role' or (r.rol = 'authenticated' and f.learners_too));
--         no row.
--   A6  select * from public.effective_attempt_policies(array(select id from public.courses limit 5));
--         every row 1 / first / null / true / practice.

begin;

-- A lock wait must never queue the app's reads of course_attempts or
-- attempt_requests behind this file: if a lock is not granted within 5 s the
-- whole transaction rolls back cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  if to_regclass('public.attempt_requests') is null then
    raise exception '0103 refused: public.attempt_requests is missing (apply 0083 first).';
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.attempt_requests'::regclass and c.conname = 'attempt_requests_status_check'
      and pg_get_constraintdef(c.oid) like '%''expired''%'
  ) then
    raise exception '0103 refused: attempt_requests_status_check does not admit ''expired'' (apply 0092 first).';
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.attempt_requests'::regclass and c.conname = 'attempt_requests_source_check'
      and pg_get_constraintdef(c.oid) like '%''ticket''%'
  ) then
    raise exception '0103 refused: attempt_requests_source_check does not admit ''ticket'' (apply 0095 first).';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'attempt_requests' and indexname = 'attempt_requests_used_attempt_idx'
  ) then
    raise exception '0103 refused: index attempt_requests_used_attempt_idx is missing (apply 0090 first).';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'course_attempts' and indexname = 'course_attempts_one_in_progress_idx'
  ) then
    raise exception '0103 refused: index course_attempts_one_in_progress_idx is missing (apply 0062 first).';
  end if;
  for r in
    select * from (values
      ('courses',                  'pass_required',         '0081'),
      ('course_attempts',          'learning_path_id',      '0034'),
      ('course_attempts',          'last_activity_at',      '0053'),
      ('course_attempts',          'journey_enrollment_id', '0058'),
      ('course_attempts',          'journey_day',           '0058'),
      ('v_course_attempt_summary', 'official_attempt_id',   '0090'),
      ('v_course_attempt_summary', 'live_attempt_count',    '0099')
    ) as t(tbl, col, mig)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) then
      raise exception '0103 refused: %.% is missing (apply % first).', r.tbl, r.col, r.mig;
    end if;
  end loop;
  if to_regprocedure('public.effective_attempt_policy(uuid)') is null then
    raise exception '0103 refused: public.effective_attempt_policy(uuid) is missing (apply 0081 first).';
  end if;
  if pg_get_function_result(to_regprocedure('public.effective_attempt_policy(uuid)'))
     is distinct from 'TABLE(max_scored_attempts integer, official_basis text, official_attempt_number integer, retain_first_attempt boolean, after_limit text, source text, source_id uuid)' then
    raise exception '0103 refused: effective_attempt_policy(uuid) does not return the 0081 table (found %).',
      pg_get_function_result(to_regprocedure('public.effective_attempt_policy(uuid)'));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. course_attempts.is_revision
-- ---------------------------------------------------------------------------
-- A constant default is a catalog-only change (no table rewrite). No grant:
-- the table privileges of 0099 section 2 cover new columns; learners read
-- their own rows' flag, only the service role writes it (the launch page and
-- the functions below).
alter table public.course_attempts
  add column if not exists is_revision boolean not null default false;

comment on column public.course_attempts.is_revision is
  'Opened as a revision visit (owner policy 2026-10-21, ADR 0014): never derives completion, success, score or progress; never scored; never official; never counted as an attempt.';

-- ---------------------------------------------------------------------------
-- 2. attempt_requests: the restart source and the re-issue columns
-- ---------------------------------------------------------------------------
-- The 0095 list plus 'restart' (a superset: re-adding the check validates
-- every row and cannot fail). No grant: the 0083 table grants cover new
-- columns.
alter table public.attempt_requests
  drop constraint if exists attempt_requests_source_check;
alter table public.attempt_requests
  add constraint attempt_requests_source_check
  check (source in ('request', 'bulk', 'manager', 'ticket', 'restart'));
comment on column public.attempt_requests.source is
  'request = learner asked; bulk = admin bulk grant; manager = legacy Phase 1 manager grant (withdrawn 0095); ticket = admin granted from a manager''s support ticket (0095); restart = re-issued by a forced restart (0103).';

alter table public.attempt_requests
  add column if not exists reissued_from uuid references public.attempt_requests(id) on delete set null;
comment on column public.attempt_requests.reissued_from is
  'the grant this one supersedes: set by a forced restart''s re-issue (0103); the official-result history follows it';

alter table public.attempt_requests
  add column if not exists override_confirmed boolean not null default false;
comment on column public.attempt_requests.override_confirmed is
  'an admin confirmed this grant for a learner whose official result stands (ADR 0014 step 11): set by the approval route on override_passed, copied by a forced restart''s re-issue, read by consume_grant''s stands refusal';

-- Beyond the ADR (ADR 0014 addendum note): the self-referencing foreign key
-- would otherwise scan the table on every cascade delete.
create index if not exists attempt_requests_reissued_from_idx
  on public.attempt_requests (reissued_from)
  where reissued_from is not null;

-- ---------------------------------------------------------------------------
-- 3. revision_visits (one row per revision visit; analytics only)
-- ---------------------------------------------------------------------------
-- History: no update and no delete privilege for any role (a visit is
-- history); referential actions still run, as the table owner.
create table if not exists public.revision_visits (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  course_version_id uuid references public.course_versions(id) on delete set null,
  attempt_id        uuid references public.course_attempts(id) on delete set null,
  launch_kind       text not null check (launch_kind in ('scorm12', 'cmi5', 'xapi')),
  launched_at       timestamptz not null default now()
);

create index if not exists revision_visits_course_user_idx
  on public.revision_visits (course_id, user_id, launched_at desc);
create index if not exists revision_visits_org_idx
  on public.revision_visits (organization_id, launched_at desc);
-- Beyond the ADR (ADR 0014 addendum note): attempt and user deletes (the
-- staging CI purge on every push) would otherwise scan the table.
create index if not exists revision_visits_attempt_idx
  on public.revision_visits (attempt_id);
create index if not exists revision_visits_user_idx
  on public.revision_visits (user_id);

comment on table public.revision_visits is
  'One row per revision visit (ADR 0014): analytics only; written by the service role; never updated or deleted by the app.';

alter table public.revision_visits enable row level security;
drop policy if exists "no direct access to revision_visits" on public.revision_visits;
create policy "no direct access to revision_visits" on public.revision_visits
  for all
  using (false)
  with check (false);

-- service_role bypasses row-level security, so only the table privilege
-- keeps it to select and insert; it is named in the revoke (beyond the ADR's
-- text, ADR 0014 addendum note) so the matrix is the same whatever default
-- privileges a
-- project had when this file was pasted.
revoke all on public.revision_visits from anon, authenticated, service_role;
grant select, insert on public.revision_visits to service_role;

-- ---------------------------------------------------------------------------
-- 4. effective_attempt_policy(uuid): the Q1 clamp
-- ---------------------------------------------------------------------------
-- The parameter name, the return table and the function attributes are the
-- 0081 ones (create or replace cannot change them, and the 0090 view depends
-- on the function); the rule lookup is the 0081 one, byte for byte, so a
-- legacy rule row still names source and source_id. Every course resolves to
-- one official attempt, the first; legacy rule rows are kept, not rewritten,
-- and their check constraints (0073) stay. effective_attempt_policies(uuid[])
-- wraps this function and is not re-created.
create or replace function public.effective_attempt_policy(p_course_id uuid)
returns table (
  max_scored_attempts     integer,
  official_basis          text,
  official_attempt_number integer,
  retain_first_attempt    boolean,
  after_limit             text,
  source                  text,
  source_id               uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    1::integer,
    'first'::text,
    null::integer,
    true,
    'practice'::text,
    coalesce(x.scope, 'default'),
    x.target_id
  from (values (1)) as one(n)
  left join lateral (
    select r.scope, r.target_id, r.max_scored_attempts, r.official_basis,
           r.official_attempt_number, r.retain_first_attempt, r.after_limit,
           r.created_at, r.prio
    from (
      select r.*, 1 as prio
        from public.attempt_scoring_rules r
       where r.scope = 'course' and r.target_id = p_course_id
      union all
      select r.*, 2 as prio
        from public.attempt_scoring_rules r
        join public.learning_path_courses lpc on lpc.path_id = r.target_id
       where r.scope = 'path' and lpc.course_id = p_course_id
      union all
      select r.*, 3 as prio
        from public.attempt_scoring_rules r
       where r.scope = 'journey'
         and (
           exists (
             select 1 from public.journey_days jd
              where jd.program_id = r.target_id and jd.course_id = p_course_id
           )
           or exists (
             select 1 from public.journey_versions jv
              where jv.program_id = r.target_id
                and jv.days @> jsonb_build_array(
                      jsonb_build_object('course_id', p_course_id::text))
           )
         )
    ) r
    order by r.prio, r.max_scored_attempts, r.created_at
    limit 1
  ) x on true;
$$;

revoke all on function public.effective_attempt_policy(uuid) from public, anon;
grant execute on function public.effective_attempt_policy(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. v_course_attempt_scoring: revision rows are never completed attempts
-- ---------------------------------------------------------------------------
-- The 0090 body unchanged (same columns, names, order and types: CREATE OR
-- REPLACE VIEW may only append), except the completed CTE's filter, which is
-- parenthesised so `not ca.is_revision` applies to both branches. The option
-- is in the definition (the 0048 form) and restated after it, because a
-- create or replace resets view options it is not given; without it a
-- learner could read every organisation's rows through the Data API.
create or replace view public.v_course_attempt_scoring with (security_invoker = on) as
with completed as (
  select
    cv.course_id,
    ca.user_id,
    ca.id as attempt_id,
    ca.score,
    ca.success_status,
    -- A consumed admin grant marks this attempt as an official RETAKE (0083).
    exists (
      select 1 from public.attempt_requests ar
       where ar.used_attempt_id = ca.id and ar.status = 'approved'
    ) as is_retake,
    row_number() over (
      partition by cv.course_id, ca.user_id
      order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id
    ) as attempt_no
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  -- 0103: parenthesised, so a revision row leaves both branches (ADR 0014 step 2)
  where (ca.completion_status = 'completed' or ca.success_status = 'passed') and not ca.is_revision
),
ranked as (
  select
    c.*,
    -- Slot among NON-retake completed attempts (the base scored window).
    case when not c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.is_retake order by c.attempt_no)
    end as base_no,
    -- 1 = the NEWEST completed retake (it is THE official result).
    case when c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.is_retake order by c.attempt_no desc)
    end as retake_rank
  from completed c
),
policy as (
  select c.id as course_id, p.max_scored_attempts, p.official_basis, p.official_attempt_number
    from public.courses c
   cross join lateral public.effective_attempt_policy(c.id) p
),
scored as (
  select
    r.*,
    p.max_scored_attempts,
    p.official_basis,
    p.official_attempt_number,
    -- Scored window = first max_scored non-retake attempts + every completed retake.
    (r.is_retake or r.base_no <= p.max_scored_attempts) as in_window,
    bool_or(r.is_retake) over (partition by r.course_id, r.user_id) as has_retake,
    max(r.base_no) filter (where r.base_no <= p.max_scored_attempts)
      over (partition by r.course_id, r.user_id) as last_base_no
  from ranked r
  join policy p on p.course_id = r.course_id
),
official as (
  -- Exactly one row per (course, user): the official attempt. The newest
  -- completed retake wins; otherwise the basis rule over the base window.
  select distinct on (s.course_id, s.user_id)
    s.course_id, s.user_id, s.attempt_id, s.score, s.success_status
  from scored s
  where (s.has_retake and s.is_retake and s.retake_rank = 1)
     or (not s.has_retake and not s.is_retake and s.base_no <= s.max_scored_attempts
         and case s.official_basis
               when 'best'   then true
               when 'latest' then s.base_no = s.last_base_no
               when 'nth'    then s.base_no = coalesce(s.official_attempt_number, 1)
               else               s.base_no = 1
             end)
  order by s.course_id, s.user_id,
           -- 'best' keeps every base-window row: highest score first, ties → earliest.
           (case when s.official_basis = 'best' then -coalesce(s.score, -1) else 0 end),
           s.base_no
)
select
  x.course_id,
  x.user_id,
  x.max_scored_attempts,
  x.official_basis,
  x.official_attempt_number,
  (count(*))::integer as completed_attempts,
  (count(*) filter (where x.in_window))::integer as scored_attempts,
  (count(*) filter (where not x.in_window))::integer as practice_attempts,
  max(x.score) filter (where x.attempt_no = 1) as first_score,
  max(x.score) filter (where x.in_window) as best_score,
  -- Newest in the window; a completed retake is always newer than the base
  -- window (mirrors computeScoring's scored = [...baseWindow, ...retakes]).
  (array_agg(x.score order by x.is_retake desc, x.attempt_no desc) filter (where x.in_window))[1] as latest_score,
  max(o.score) as official_score,
  -- New trailing columns (0090). NULL when the policy designates no official
  -- attempt yet (e.g. an 'nth' basis beyond the completed count) — the TS
  -- engine then reports in_progress, never "completed".
  case
    when max(o.attempt_id::text) is null then null
    when max(o.success_status) = 'passed' then 'passed'
    when max(o.success_status) = 'failed' then 'failed'
    else 'completed'
  end as official_status,
  max(o.attempt_id::text)::uuid as official_attempt_id
from scored x
left join official o on o.course_id = x.course_id and o.user_id = x.user_id
group by x.course_id, x.user_id, x.max_scored_attempts, x.official_basis, x.official_attempt_number;

alter view public.v_course_attempt_scoring set (security_invoker = on);

-- Data API grants (explicit; CREATE OR REPLACE keeps existing privileges, so
-- this is idempotent).
grant select on public.v_course_attempt_scoring to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. v_course_attempt_summary: revision rows are not attempts
-- ---------------------------------------------------------------------------
-- The 0099 body unchanged (twenty-two columns, same names, order and types),
-- except `where not ca.is_revision` in the base CTE, so every column
-- aggregated from attempt rows excludes revision rows; scored_attempts and
-- practice_attempts come from v_course_attempt_scoring and follow its
-- clause. The six matviews that read this view keep working (same columns)
-- and show the new data at their own refresh (A1 above).
create or replace view public.v_course_attempt_summary with (security_invoker = on) as
with base as (
  select
    cv.course_id,
    ca.user_id,
    (array_agg(ca.completion_status order by ca.started_at desc))[1] as latest_completion,
    (array_agg(ca.success_status   order by ca.started_at desc))[1] as latest_success,
    coalesce(sum(
      extract(epoch from (ca.completed_at - ca.started_at))
    ) filter (where ca.completed_at is not null), 0) as total_time_seconds,
    count(*) as attempt_count,
    bool_or(ca.completion_status = 'completed' or ca.success_status = 'passed') as ever_completed,
    bool_or(ca.success_status = 'passed') as ever_passed,
    (array_agg(ca.success_status
       order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id)
       filter (where ca.completion_status = 'completed' or ca.success_status = 'passed')
    )[1] = 'passed' as first_completed_passed,
    -- 0099: live attempts only (a reset / force-restart / language-switch
    -- abandoned attempt is not progress).
    count(*) filter (where ca.status <> 'abandoned') as live_attempt_count,
    (array_agg(ca.completion_status order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_completion,
    (array_agg(ca.success_status   order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_success
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  -- 0103: revision rows are not attempts (ADR 0014 step 2)
  where not ca.is_revision
  group by cv.course_id, ca.user_id
)
select
  b.course_id,
  b.user_id,
  b.latest_completion,
  b.latest_success,
  s.best_score,
  b.total_time_seconds,
  b.attempt_count,
  b.ever_completed,
  b.ever_passed,
  s.official_score,
  s.first_score,
  s.latest_score,
  coalesce(s.scored_attempts, 0)   as scored_attempts,
  coalesce(s.practice_attempts, 0) as practice_attempts,
  s.official_basis,
  s.max_scored_attempts,
  coalesce(b.first_completed_passed, false) as first_completed_passed,
  -- Trailing columns (0090): the OFFICIAL verdict; null = no official attempt yet.
  s.official_status,
  s.official_attempt_id,
  -- Trailing columns (0099): live attempts; 0 / null = only reset attempts.
  b.live_attempt_count,
  b.latest_live_completion,
  b.latest_live_success
from base b
left join public.v_course_attempt_scoring s
  on s.course_id = b.course_id and s.user_id = b.user_id;

alter view public.v_course_attempt_summary set (security_invoker = on);

-- Data API grants (explicit; CREATE OR REPLACE keeps existing privileges, so
-- this is idempotent).
grant select on public.v_course_attempt_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. flag_revision_attempt(uuid): the cutover flag
-- ---------------------------------------------------------------------------
-- One conditional update; returns the row count. A row already flagged
-- counts 1; a grant retake, a completed row, a row that is not in progress
-- or a row that changed under the caller counts 0. The "not complete" test is
-- isCompletedAttempt (lib/scoring/policy.ts) negated null-safely;
-- completed_at is not consulted (the SCORM commit stamps it on any commit
-- with finished). The not exists is served by attempt_requests_used_attempt_idx.
create or replace function public.flag_revision_attempt(p_attempt_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.course_attempts ca
     set is_revision = true
   where ca.id = p_attempt_id
     and ca.status = 'in_progress'
     and ca.completion_status is distinct from 'completed'
     and ca.success_status is distinct from 'passed'
     and not exists (
       select 1 from public.attempt_requests ar
        where ar.used_attempt_id = ca.id and ar.status = 'approved'
     );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.flag_revision_attempt(uuid) from public, anon, authenticated;
grant execute on function public.flag_revision_attempt(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. record_revision_visit(…): one visit row, deduplicated over 10 seconds
-- ---------------------------------------------------------------------------
-- The transaction-level advisory lock serialises two launches of one
-- learner on one course (each RPC is its own transaction, so the lock is
-- released when the call returns); hashtext gives an int4, which widens to
-- the bigint form. Returns whether it inserted. A bad p_kind raises 23514
-- (the launch_kind check); callers pass the version's manifest_type.
create or replace function public.record_revision_visit(
  p_org uuid,
  p_user uuid,
  p_course uuid,
  p_version uuid,
  p_attempt uuid,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_course::text));
  if exists (
    select 1 from public.revision_visits v
     where v.user_id = p_user and v.course_id = p_course
       and v.launched_at > now() - interval '10 seconds'
  ) then
    return false;
  end if;
  insert into public.revision_visits
    (organization_id, user_id, course_id, course_version_id, attempt_id, launch_kind)
  values (p_org, p_user, p_course, p_version, p_attempt, p_kind);
  return true;
end;
$$;

revoke execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. consume_grant(…): an approved grant consumed in one transaction
-- ---------------------------------------------------------------------------
-- In this order, under the grant row's lock:
--   unavailable  no approved grant row for (grant, user, course); nothing written
--   (22023)      the version is not the course's, or the organisation is not
--                the grant's: raised, nothing written (beyond the ADR, ADR
--                0014 addendum note; the launch page refuses on any error)
--   used         used_at is set; nothing written
--   expired      expires_at has passed; nothing written (the row keeps its
--                one-open slot, as before this file; ADR 0014 addendum note)
--   retake_live  another approved grant's retake is in progress, not
--                complete and not a revision row; nothing written
--   stale        the grant was decided before the completed_at of the
--                learner's current official result: the grant becomes
--                expired with a note suffix, nothing else written
--   stands       that official result stands (passed, or not failed on a
--                course whose pass_required is false) and the grant carries
--                no override_confirmed: expired with a note suffix
--   opened       every in-progress row of the learner on the course's
--                versions is abandoned (revision rows included), one fresh
--                official row is inserted (empty cmi_data, never seeded, no
--                0100 column) and the grant is stamped used
-- Every outcome but opened returns a null attempt_id and no abandoned ids.
-- The current official result is the chain rule of ADR 0014 step 7, in SQL
-- (ADR 0014 addendum note): among the learner's complete, non-abandoned,
-- non-revision rows on the course, the newest of every grant-linked retake
-- and the earliest row no approved grant links, ordered as
-- v_course_attempt_scoring orders attempts (coalesce(completed_at,
-- started_at), started_at, id). A 23505 from the insert (the 0062
-- one-in-progress index) or any other error is not caught: the whole call
-- rolls back, abandon included, and the grant stays unused. Lock order: the
-- grant row, then course_attempts rows.
create or replace function public.consume_grant(
  p_grant_id uuid,
  p_user_id uuid,
  p_course_id uuid,
  p_version_id uuid,
  p_org_id uuid,
  p_learning_path_id uuid,
  p_journey_enrollment_id uuid,
  p_journey_day integer
)
returns table (outcome text, attempt_id uuid, abandoned_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant         public.attempt_requests%rowtype;
  v_pass_required boolean;
  v_has_official  boolean;
  v_off_completed timestamptz;
  v_off_started   timestamptz;
  v_off_success   text;
  v_off_when      text;
  v_abandoned     uuid[];
  v_new           uuid;
begin
  -- 1. the grant row, locked
  select ar.* into v_grant
    from public.attempt_requests ar
   where ar.id = p_grant_id
     and ar.user_id = p_user_id
     and ar.course_id = p_course_id
     and ar.status = 'approved'
     for update;
  if not found then
    return query select 'unavailable'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 2. consistency (beyond the ADR; ADR 0014 addendum note)
  if v_grant.organization_id is distinct from p_org_id
     or not exists (
       select 1 from public.course_versions cv
        where cv.id = p_version_id and cv.course_id = p_course_id
     ) then
    raise exception 'consume_grant: version, course or organisation mismatch'
      using errcode = '22023';
  end if;

  -- 3. used, expired
  if v_grant.used_at is not null then
    return query select 'used'::text, null::uuid, '{}'::uuid[];
    return;
  end if;
  if v_grant.expires_at is not null and v_grant.expires_at < now() then
    return query select 'expired'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 4. retake_live
  if exists (
    select 1
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
     where ca.user_id = p_user_id
       and cv.course_id = p_course_id
       and ca.status = 'in_progress'
       and ca.completion_status is distinct from 'completed'
       and ca.success_status is distinct from 'passed'
       and not ca.is_revision
       and exists (
         select 1 from public.attempt_requests ar2
          where ar2.used_attempt_id = ca.id
            and ar2.status = 'approved'
            and ar2.id <> p_grant_id
       )
  ) then
    return query select 'retake_live'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 5. the current official result (the chain rule)
  select coalesce(c.pass_required, false) into v_pass_required
    from public.courses c
   where c.id = p_course_id;
  v_pass_required := coalesce(v_pass_required, false);

  with chain_rows as (
    select ca.id as row_id,
           ca.completed_at as row_completed,
           ca.started_at as row_started,
           ca.success_status as row_success,
           exists (
             select 1 from public.attempt_requests ar3
              where ar3.used_attempt_id = ca.id and ar3.status = 'approved'
           ) as row_is_retake
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
     where ca.user_id = p_user_id
       and cv.course_id = p_course_id
       and ca.status <> 'abandoned'
       and not ca.is_revision
       and (ca.completion_status = 'completed' or ca.success_status = 'passed')
  ),
  first_base as (
    select cr.row_id
      from chain_rows cr
     where not cr.row_is_retake
     order by coalesce(cr.row_completed, cr.row_started), cr.row_started, cr.row_id
     limit 1
  )
  select cr.row_completed, cr.row_started, cr.row_success
    into v_off_completed, v_off_started, v_off_success
    from chain_rows cr
   where cr.row_is_retake
      or cr.row_id in (select fb.row_id from first_base fb)
   order by coalesce(cr.row_completed, cr.row_started) desc, cr.row_started desc, cr.row_id desc
   limit 1;
  v_has_official := found;
  -- the date the two note suffixes name (started_at is not null, so this is
  -- never null and the suffix never empties an existing note)
  v_off_when := to_char(coalesce(v_off_completed, v_off_started) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';

  -- 6. stale (a null decided_at is never stale)
  if v_has_official
     and v_grant.decided_at is not null
     and v_off_completed is not null
     and v_grant.decided_at < v_off_completed then
    update public.attempt_requests ar
       set status = 'expired',
           decision_note = coalesce(ar.decision_note || ' ', '')
             || 'expired unused: decided before the learner''s current official result of '
             || v_off_when
     where ar.id = p_grant_id;
    return query select 'stale'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 7. stands (the SQL twin of officialDone and officialStatus <> 'failed')
  if v_has_official
     and (v_off_success = 'passed'
          or (v_off_success is distinct from 'failed' and not v_pass_required))
     and not v_grant.override_confirmed then
    update public.attempt_requests ar
       set status = 'expired',
           decision_note = coalesce(ar.decision_note || ' ', '')
             || 'expired unused: the learner''s official result of '
             || v_off_when
             || ' stands and this grant carries no post-pass confirmation'
     where ar.id = p_grant_id;
    return query select 'stands'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 8. opened: abandon, insert, stamp (a plain update ... returning into
  -- would raise on more than one row)
  with ab as (
    update public.course_attempts ca
       set status = 'abandoned'
     where ca.user_id = p_user_id
       and ca.status = 'in_progress'
       and ca.course_version_id in (
         select cv.id from public.course_versions cv where cv.course_id = p_course_id
       )
    returning ca.id
  )
  select coalesce(array_agg(ab.id), '{}'::uuid[]) into v_abandoned from ab;

  insert into public.course_attempts as ca
    (course_version_id, user_id, organization_id, status, cmi_data, is_revision,
     learning_path_id, journey_enrollment_id, journey_day)
  values
    (p_version_id, p_user_id, p_org_id, 'in_progress', '{}'::jsonb, false,
     p_learning_path_id, p_journey_enrollment_id, p_journey_day)
  returning ca.id into v_new;

  update public.attempt_requests ar
     set used_at = now(),
         used_attempt_id = v_new
   where ar.id = p_grant_id
     and ar.used_at is null;

  return query select 'opened'::text, v_new, v_abandoned;
end;
$$;

revoke execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer) to service_role;

notify pgrst, 'reload schema';

commit;
