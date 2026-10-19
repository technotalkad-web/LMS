-- 0100_alds_core.sql — ALDS core (P4; ADR 0005 §4 step 10 and its note of
-- 2026-10-19 (a)–(c); ADR 0006 step 17; ADR 0003 step 10). Numbered by ADR
-- 0008 decision 2 (written as 0099 in ADR 0003/0005/0006). Hand-apply in the
-- SQL editor, staging first; never `supabase db push` (the CLI is linked to
-- production).
--
-- ORDER: 0098 → 0099 → 0100 everywhere. Production: only after v1.3.0 is
-- live and 0099 is applied there, never in the P1 sitting (ADR 0007 step 2:
-- the v1.3.0 audit's B0100a–d probes STOP the sitting when they read
-- present; ADR 0008 step 20; ADR 0009 step 10).
--
-- Deploy-safe in both orders with the P4 code: the flag ALDS_P4 defaults off
-- (lib/alds/flag.ts) and every reader tolerates the absent columns, so the
-- habit "code first, then the file" is kept but not load-bearing (unlike
-- 0099). One window to know: between this apply and switching ALDS_P4 on,
-- the launch page does not name is_preview, so a staff launch is stored with
-- the default false and then counts as learner history for the section 9
-- delete guards (it fails conservative: SQL-editor deletes are refused more
-- often, never less; app deletes carry the service_role claim and are not
-- affected). The §6d backfill is idempotent: re-paste this file (or run its
-- is_preview update alone) just before switching the flag on, or switch the
-- flag on in the same sitting as the apply (ADR 0005 note (k) of
-- 2026-10-19).
--
-- Before the apply (read-only):
--   select count(*) from public.course_attempts;
--     The §6d backfill is one unbatched update over the attempts while this
--     transaction holds course_versions and course_attempts; a large count
--     means a quiet window (no upload, few learners), not a busy hour.
--
-- NEVER paste 0098 again after this file: it would restore the membership
-- rule of the two delete guards (section 9 below). 0098's header says so
-- under the old number 0099.
--
-- Idempotent and retry-safe: every statement is guarded (`if not exists`,
-- `drop … if exists`, named-constraint checks, `create or replace`); a second
-- paste changes nothing and its backfill updates zero rows. One transaction:
-- on a lock timeout or a deadlock nothing changed, paste it again. Staging:
-- paste when no spec or CI e2e run is in progress. Production: paste at a
-- minute clear of the crons' :03 / :07 quarter-hour offsets and of 03:30 UTC.
-- No dependence on the dashboard-made updated_at trigger function (the
-- rehearsal's "Repository gap").
--
-- Row writes: only the §6d backfill of two new metadata columns,
-- course_attempts.served_language and course_attempts.is_preview (section 6).
-- No attempt status, score, statement or stored package is touched.
--
-- PREREQUISITES (the DO block below refuses to run without them):
--   0004  public.cmi5_launch_tokens (learning_sessions.fetch_token)
--   0030  course_versions.package_id (the served_language backfill)
--   0077  course_versions.upload_status
--   0098  index course_versions_storage_prefix_key and function
--         guard_learner_history_course_versions() (section 9 replaces it)
--   0099  v_course_attempt_summary.live_attempt_count
--
-- What it does:
--   1. package_certifications: one row per Package Guardian run; deny-all,
--      written by the service role only, never deleted by the app.
--   2. course_versions: manifest, standard, engine, conformance level, tier,
--      tier reason and certification columns.
--   3. Guard trigger: the four tier and the four manifest columns move only
--      through the writer.
--   4. alds_set_version_tier(): the writer, executable by service_role only.
--   5. learning_sessions (cmi5/xAPI only); deny-all, service role only.
--   6. course_attempts: served_language, launch_mode, is_preview,
--      alds_ingested_at, and the §6d backfill.
--   7. xapi_statements: session_id, standard_version (plain columns,
--      unwritten until P5; the session_id foreign key and index: 0101).
--   8. organizations.question_analytics_v2 (no reader until P5).
--   9. The two 0098 delete guards: a learner attempt is `not is_preview`.
--
-- Grants: both new tables carry RLS, a deny-all policy, `revoke all … from
-- anon, authenticated` and a literal service_role grant (docs/MIGRATIONS.md,
-- scripts/check-migration-grants.mjs); function execute grants follow the
-- BLUEPRINT Conventions paragraph.
--
-- After the apply (read-only, once):
--   select is_preview, count(*) from public.course_attempts group by 1;
--   select analytics_tier, count(*) from public.course_versions group by 1;
--     (every row unverified)
--   select count(*) from public.package_certifications;   (0)
--   select count(*) from public.learning_sessions;        (0)
--   select proname from pg_proc
--   where proname in ('alds_set_version_tier', 'alds_guard_version_tier');
--     (2 rows)

begin;

-- A lock wait must never queue the app's reads of course_versions or
-- course_attempts behind this file: if a lock is not granted within 5 s the
-- whole transaction rolls back cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.cmi5_launch_tokens') is null then
    raise exception '0100 refused: public.cmi5_launch_tokens is missing (apply 0004 first).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_versions' and column_name = 'package_id'
  ) then
    raise exception '0100 refused: course_versions.package_id is missing (apply 0030 first).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_versions' and column_name = 'upload_status'
  ) then
    raise exception '0100 refused: course_versions.upload_status is missing (apply 0077 first).';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'course_versions' and indexname = 'course_versions_storage_prefix_key'
  ) then
    raise exception '0100 refused: course_versions_storage_prefix_key is missing (apply 0098 first).';
  end if;
  if to_regprocedure('public.guard_learner_history_course_versions()') is null then
    raise exception '0100 refused: guard_learner_history_course_versions() is missing (apply 0098 first).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'v_course_attempt_summary' and column_name = 'live_attempt_count'
  ) then
    raise exception '0100 refused: v_course_attempt_summary.live_attempt_count is missing (apply 0099 first).';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. package_certifications (one row per certification run)
-- ---------------------------------------------------------------------------
-- History: never deleted by the app (no delete grant); the version-delete
-- cascade needs no grant. Created before the course_versions columns so that
-- certification_id can be written by the same file's function.
create table if not exists public.package_certifications (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  course_version_id uuid not null references public.course_versions(id) on delete cascade,
  status            text not null check (status in ('pending', 'certified', 'uncertified', 'revoked')),
  reason_code       text,
  reason            text,
  rules_version     text,
  rules_bundle_hash text,
  engine_digest     text,
  package_digest    text,
  static_report     jsonb,
  coverage          jsonb,
  requested_at      timestamptz not null default now(),
  finished_at       timestamptz,
  requested_by      uuid references auth.users(id) on delete set null,   -- null = the upload gate
  revoked_by        uuid references auth.users(id) on delete set null,
  revoke_reason     text,
  finding_ids       uuid[] not null default '{}',
  created_at        timestamptz not null default now()
);

create index if not exists package_certifications_version_idx
  on public.package_certifications (course_version_id, requested_at desc);

comment on table public.package_certifications is
  'One row per Package Guardian run (ADR 0005 step 10). Written by the service role only; the tier itself is written by alds_set_version_tier().';
comment on column public.package_certifications.requested_by is
  'Null = the upload gate; otherwise the super_owner who re-ran the check (ADR 0005 note (f) of 2026-10-19).';
comment on column public.package_certifications.reason_code is
  'Gate code (lib/alds/tier.ts) or rule finding code (lib/alds/rules/findings.ts) of the run''s verdict.';

alter table public.package_certifications enable row level security;
drop policy if exists "no direct access to package_certifications" on public.package_certifications;
create policy "no direct access to package_certifications" on public.package_certifications
  for all
  using (false)
  with check (false);

revoke all on public.package_certifications from anon, authenticated;
grant select, insert, update on public.package_certifications to service_role;   -- no delete: a run is history (ADR 0005 step 10)

-- ---------------------------------------------------------------------------
-- 2. course_versions: manifest, tier and certification columns
-- ---------------------------------------------------------------------------
-- Constant defaults: no table rewrite. certification_id is a plain uuid with
-- NO foreign key: an on-delete-set-null action would fire the tier guard of
-- section 3 with the writer's setting off during a version-delete cascade and
-- be reverted, leaving a dangling reference; alds_set_version_tier() checks
-- that the id names a run of that version instead.
alter table public.course_versions
  add column if not exists alds_manifest         jsonb,
  add column if not exists standard_version      text,
  add column if not exists engine_version        text,
  add column if not exists conformance_level     smallint not null default 1,
  add column if not exists analytics_tier        text not null default 'unverified',
  add column if not exists analytics_tier_reason text,
  add column if not exists certified_at          timestamptz,
  add column if not exists certification_id      uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'course_versions_conformance_level_check'
      and conrelid = 'public.course_versions'::regclass
  ) then
    alter table public.course_versions
      add constraint course_versions_conformance_level_check
      check (conformance_level in (1, 2));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'course_versions_analytics_tier_check'
      and conrelid = 'public.course_versions'::regclass
  ) then
    alter table public.course_versions
      add constraint course_versions_analytics_tier_check
      check (analytics_tier in ('unverified', 'pending', 'uncertified', 'certified', 'revoked'));
  end if;
end
$$;

create index if not exists course_versions_analytics_tier_idx
  on public.course_versions (analytics_tier)
  where analytics_tier <> 'unverified';

comment on column public.course_versions.alds_manifest is
  'The package''s alds-manifest.json as the Package Guardian read it (ADR 0005 step 10); null = no manifest. Written only by alds_set_version_tier().';
comment on column public.course_versions.standard_version is
  'ALDS standard version the package declares (e.g. 2.0); null = no manifest. Written only by alds_set_version_tier().';
comment on column public.course_versions.engine_version is
  'Authoring engine version from the ALDS manifest; null = no manifest. Written only by alds_set_version_tier().';
comment on column public.course_versions.conformance_level is
  'ALDS conformance level: 1 = no or unparsed manifest (SCORM, third-party, pre-2.0 KIVO), 2 = the manifest passed the U1 shape check (ADR 0005 note (e) of 2026-10-19). Written only by alds_set_version_tier().';
comment on column public.course_versions.analytics_tier is
  'ADR 0005 step 1: unverified | pending | uncertified | certified | revoked. Written only by alds_set_version_tier(); the guard trigger reverts any other write. Never read by completion, scoring, the Report Card, CRM or journeys (D1).';
comment on column public.course_versions.analytics_tier_reason is
  'One line: <gate code> or <rule>:<finding code>: <message> for pending/uncertified/revoked (ADR 0005 note (b) of 2026-10-19). Protected by the guard trigger like the tier.';
comment on column public.course_versions.certified_at is
  'When the version was last certified; kept when it is revoked, cleared on any other tier. Written only by alds_set_version_tier().';
comment on column public.course_versions.certification_id is
  'The latest package_certifications run; no FK by design (see the DDL comment in 0100). Written only by alds_set_version_tier().';

-- ---------------------------------------------------------------------------
-- 3. Guard: the tier columns are written only through the writer (step 2)
-- ---------------------------------------------------------------------------
-- When the transaction-local setting alds.tier_writer is not 'on', an INSERT
-- gets the defaults and an UPDATE keeps the OLD values of the eight
-- protected columns (the four tier columns and the four manifest columns of
-- section 2), so the storage_driver flip, upload_status, manifest_data and
-- validation linking never touch a tier, and an org admin's direct insert
-- (0002 "admins insert versions") cannot plant a Level 2 manifest. The
-- session role is never consulted (inside a security definer function it is
-- the owner): the service client cannot set them by a plain write either.
-- Security invoker; the trigger name sorts after
-- course_versions_freeze_ready (0098), which therefore fires first.
create or replace function public.alds_guard_version_tier()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if coalesce(current_setting('alds.tier_writer', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.analytics_tier := 'unverified';
    new.analytics_tier_reason := null;
    new.certified_at := null;
    new.certification_id := null;
    new.alds_manifest := null;
    new.standard_version := null;
    new.engine_version := null;
    new.conformance_level := 1;
  else
    new.analytics_tier := old.analytics_tier;
    new.analytics_tier_reason := old.analytics_tier_reason;
    new.certified_at := old.certified_at;
    new.certification_id := old.certification_id;
    new.alds_manifest := old.alds_manifest;
    new.standard_version := old.standard_version;
    new.engine_version := old.engine_version;
    new.conformance_level := old.conformance_level;
  end if;
  return new;
end
$$;

revoke execute on function public.alds_guard_version_tier() from public, anon, authenticated;
grant execute on function public.alds_guard_version_tier() to service_role;

drop trigger if exists course_versions_guard_tier on public.course_versions;
create trigger course_versions_guard_tier
  before insert or update on public.course_versions
  for each row execute function public.alds_guard_version_tier();

-- ---------------------------------------------------------------------------
-- 4. The writer (service_role only; the only path that moves a tier)
-- ---------------------------------------------------------------------------
-- Named parameters, pinned for supabase-js rpc(). Refuses a tier outside the
-- five values (22023), a certification id that is not a run of the version
-- (23503) and an unknown version (P0002). certified_at: now() on certified,
-- kept on revoked (a revoked row keeps when it was certified), null
-- otherwise. The four manifest columns are kept when their parameter is
-- null. p_reason_code is accepted for the record and stored by the caller in
-- package_certifications.reason_code; this function does not persist it
-- separately. The setting is switched off again after the one update, so a
-- later plain update in the same transaction is guarded again.
create or replace function public.alds_set_version_tier(
  p_version_id        uuid,
  p_tier              text,
  p_reason_code       text     default null,
  p_reason            text     default null,
  p_certification_id  uuid     default null,
  p_manifest          jsonb    default null,
  p_standard_version  text     default null,
  p_engine_version    text     default null,
  p_conformance_level smallint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v public.course_versions%rowtype;
begin
  if p_tier is null or p_tier not in ('unverified', 'pending', 'uncertified', 'certified', 'revoked') then
    raise exception 'alds_set_version_tier: invalid tier %', coalesce(p_tier, '(null)')
      using errcode = '22023';
  end if;
  if p_certification_id is not null and not exists (
    select 1 from public.package_certifications c
    where c.id = p_certification_id and c.course_version_id = p_version_id
  ) then
    raise exception 'alds_set_version_tier: certification % is not a run of version %', p_certification_id, p_version_id
      using errcode = '23503';
  end if;

  perform set_config('alds.tier_writer', 'on', true);
  update public.course_versions set
    analytics_tier        = p_tier,
    analytics_tier_reason = p_reason,
    certified_at          = case
                              when p_tier = 'certified' then now()
                              when p_tier = 'revoked' then certified_at
                              else null
                            end,
    certification_id      = p_certification_id,
    alds_manifest         = coalesce(p_manifest, alds_manifest),
    standard_version      = coalesce(p_standard_version, standard_version),
    engine_version        = coalesce(p_engine_version, engine_version),
    conformance_level     = coalesce(p_conformance_level, conformance_level)
  where id = p_version_id
  returning * into v;
  perform set_config('alds.tier_writer', 'off', true);

  if v.id is null then
    raise exception 'alds_set_version_tier: version % not found', p_version_id
      using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'version_id', v.id,
    'analytics_tier', v.analytics_tier,
    'analytics_tier_reason', v.analytics_tier_reason,
    'certified_at', v.certified_at,
    'certification_id', v.certification_id
  );
end
$$;

comment on function public.alds_set_version_tier(uuid, text, text, text, uuid, jsonb, text, text, smallint) is
  'The only writer of course_versions.analytics_tier, analytics_tier_reason, certified_at and certification_id (ADR 0005 step 2, note (c) of 2026-10-19). service_role only. p_reason_code is not persisted here: the caller stores it in package_certifications.reason_code.';

revoke execute on function public.alds_set_version_tier(uuid, text, text, text, uuid, jsonb, text, text, smallint) from public, anon, authenticated;
grant execute on function public.alds_set_version_tier(uuid, text, text, text, uuid, jsonb, text, text, smallint) to service_role;

-- ---------------------------------------------------------------------------
-- 5. learning_sessions (cmi5/xAPI only; the id is the cmi5 sessionid of
--    LMS.LaunchData)
-- ---------------------------------------------------------------------------
-- No session_token (cut with SCORM journaling), no grace_until (deferred with
-- the gateway), no registration_id (P6). initialized_at, terminated_at and
-- last_statement_at exist unwritten until P5 ingest.
create table if not exists public.learning_sessions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  attempt_id        uuid not null references public.course_attempts(id) on delete cascade,
  launch_kind       text not null check (launch_kind in ('cmi5', 'xapi')),
  fetch_token       uuid references public.cmi5_launch_tokens(fetch_token) on delete set null,
  activity_id       text not null,
  launch_mode       text not null check (launch_mode in ('Normal', 'Browse', 'Review')),
  launched_at       timestamptz not null default now(),
  initialized_at    timestamptz,
  terminated_at     timestamptz,
  last_statement_at timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists learning_sessions_attempt_idx
  on public.learning_sessions (attempt_id, launched_at desc);

comment on table public.learning_sessions is
  'One row per cmi5/xAPI launch (ADR 0006 step 17); id = the cmi5 sessionid written into LMS.LaunchData. Written by the service role only.';

alter table public.learning_sessions enable row level security;
drop policy if exists "no direct access to learning_sessions" on public.learning_sessions;
create policy "no direct access to learning_sessions" on public.learning_sessions
  for all
  using (false)
  with check (false);

revoke all on public.learning_sessions from anon, authenticated;
grant select, insert, update on public.learning_sessions to service_role;

-- ---------------------------------------------------------------------------
-- 6. course_attempts: launch metadata + the §6d backfill
-- ---------------------------------------------------------------------------
alter table public.course_attempts
  add column if not exists served_language  text,
  add column if not exists launch_mode      text not null default 'Normal',
  add column if not exists is_preview       boolean not null default false,
  add column if not exists alds_ingested_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'course_attempts_launch_mode_check'
      and conrelid = 'public.course_attempts'::regclass
  ) then
    alter table public.course_attempts
      add constraint course_attempts_launch_mode_check
      check (launch_mode in ('Normal', 'Browse', 'Review'));
  end if;
end
$$;

comment on column public.course_attempts.served_language is
  'The language slot the attempt was launched in (ADR 0006 step 17); backfilled at 0100 from the version''s package language. Null = no language slot.';
comment on column public.course_attempts.launch_mode is
  'cmi5 launchMode of the attempt: Normal | Browse | Review (ADR 0006 step 17). Never read by scoring (D1).';
comment on column public.course_attempts.is_preview is
  'ADR 0005 step 10 / ADR 0006 step 17: a launch by super_owner, admin or data_analyst. Backfilled for current staff members at 0100. Excludes the attempt from the delete guards; never read by scoring (D1).';
comment on column public.course_attempts.alds_ingested_at is
  'When P5 question-analytics ingest last processed the attempt; unwritten until P5.';

-- §6d backfill (the only row writes in this file; both re-run to zero rows).
-- served_language from the language of the attempt's version's package.
update public.course_attempts a
set served_language = cp.language
from public.course_versions cv
join public.course_packages cp on cp.id = cv.package_id
where cv.id = a.course_version_id
  and a.served_language is null
  and cp.language is not null;

-- is_preview for attempts whose user currently holds a staff role in the
-- attempt's organisation (the 0098 form). Consequence (ADR 0005 note (b)):
-- such an attempt stays preview if the member later leaves, so it no longer
-- blocks a delete; a former member's attempt made while a learner stays
-- false and still blocks.
update public.course_attempts a
set is_preview = true
from public.organization_members m
where m.user_id = a.user_id
  and m.organization_id = a.organization_id
  and m.role::text in ('super_owner', 'admin', 'data_analyst')
  and a.is_preview = false;

-- ---------------------------------------------------------------------------
-- 7. xapi_statements: session and standard columns (written by P5 ingest)
-- ---------------------------------------------------------------------------
-- Plain columns only (catalog changes, no scan of xapi_statements under this
-- file's locks). The foreign key to learning_sessions and the partial index
-- on session_id come with 0101 (P5, the first writer): the index there
-- `create index concurrently` outside a transaction, then the constraint
-- `not valid` and `validate constraint`, in that order, so the on-delete-set-
-- null action is indexed from its first day. A foreign key here without the
-- index would make every learning_sessions delete (the staging CI purge, a
-- course or attempt delete) scan xapi_statements (ADR 0005 note (b) of
-- 2026-10-19, addition).
alter table public.xapi_statements
  add column if not exists session_id       uuid,
  add column if not exists standard_version text;

comment on column public.xapi_statements.session_id is
  'The learning_sessions row the statement belongs to (ADR 0006 step 17); unwritten until P5 ingest. Its foreign key to learning_sessions (on delete set null) and its index come with 0101.';
comment on column public.xapi_statements.standard_version is
  'ALDS standard version of the emitting package; unwritten until P5 ingest.';

-- ---------------------------------------------------------------------------
-- 8. organizations
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists question_analytics_v2 boolean not null default false;

comment on column public.organizations.question_analytics_v2 is
  'P5 readers switch (ADR 0005 step 14). No reader tonight.';

-- ---------------------------------------------------------------------------
-- 9. Delete guards on is_preview (ADR 0003 step 10, second definition)
-- ---------------------------------------------------------------------------
-- The 0098 bodies unchanged except the learner clause: a learner attempt is
-- one with is_preview = false (it was: the user does not currently hold a
-- staff role). The service_role claim exemption is kept verbatim: the claim
-- is transaction-local and survives security definer execution and FK
-- cascades; the session role would be the function or table owner there, so
-- it is never used for this check. nullif() matters: casting an empty
-- setting to jsonb throws. CREATE OR REPLACE keeps the two 0098 triggers
-- bound to these functions; they are not recreated.

create or replace function public.guard_learner_history_course_versions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  learner_attempts bigint;
begin
  if claim_role = 'service_role' then
    return old;
  end if;
  select count(*) into learner_attempts
  from public.course_attempts a
  where a.course_version_id = old.id
    and not a.is_preview;
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'course_versions %s holds %s learner attempt(s). Deactivate the package or make another version current instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10; is_preview since 0100).';
  end if;
  return old;
end
$$;

create or replace function public.guard_learner_history_courses()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  learner_attempts bigint;
begin
  if claim_role = 'service_role' then
    return old;
  end if;
  select count(*) into learner_attempts
  from public.course_attempts a
  join public.course_versions v on v.id = a.course_version_id
  where v.course_id = old.id
    and not a.is_preview;
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'courses %s holds %s learner attempt(s). Deactivate the course instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10; is_preview since 0100).';
  end if;
  return old;
end
$$;

revoke execute on function public.guard_learner_history_course_versions() from public, anon, authenticated;
grant execute on function public.guard_learner_history_course_versions() to service_role;
revoke execute on function public.guard_learner_history_courses() from public, anon, authenticated;
grant execute on function public.guard_learner_history_courses() to service_role;

notify pgrst, 'reload schema';

commit;
