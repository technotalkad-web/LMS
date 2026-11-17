-- 0115_membership_status_enforced.sql — a membership counts only while it is
-- active and its organisation is live, in row security (ADR 0030 section C;
-- pull request A, the database half). Hand-apply in the SQL editor with the
-- role selector on postgres, staging first; never `supabase db push` and
-- never the Supabase CLI (the CLI is linked to production). Production in a
-- small sitting of its own, explained beforehand and approved.
--
-- THE RULE (ADR 0030 rules 1 to 5): a membership counts only when its
-- organization_members.status is 'active' and its organisation's deleted_at
-- is null. 'inactive' and 'suspended' grant nothing. An organisation
-- scheduled for deletion stays open until deleted_at is set; the
-- subscription state is not read. The rule tests the reader (auth.uid()),
-- never the person a row is about: an active administrator still reads an
-- inactive member's rows.
--
-- WHAT IT DOES (one transaction; it creates no relation, writes no row and
-- removes nothing):
--   1. create or replace of the four helpers is_org_member, is_org_admin,
--      is_org_super_owner and is_org_data_analyst: same name, same argument
--      org_id, same result, same role lists ('owner' kept), plus
--      m.status = 'active' and the organisation's deleted_at is null; sql,
--      stable, security definer, search_path pinned to pg_catalog, public.
--      The argument is written <function>.org_id, so a later column of that
--      name cannot change the answer. is_org_data_analyst is absent on some
--      databases; there this file creates it.
--   2. execute on the four for anon, authenticated and service_role
--      (literal grants; nothing revoked). Every policy that calls a helper
--      needs it.
--   3. alter policy (using, and with check where the policy has one) on the
--      seven policies that read organization_members themselves. Each keeps
--      its command, its roles and its body, and gains one conjunct:
--        public.organizations "members can read their orgs" (0001) and
--          "owners and admins can update orgs" (0019): the row's own
--          deleted_at is null, and m.status = 'active' inside the exists (a
--          read of organizations inside its own policy would recurse,
--          42P17);
--        public.tenant_subscriptions "tenant admins read own subscription"
--          (0026), public.profiles "users read profiles in shared orgs"
--          (0027; the reader's row `me` only), public.course_packages "org
--          members read packages" and "org admins write packages" (0030),
--          public.course_ratings "org admins read all ratings" (0031): a
--          call to is_org_member on the reader's own organisation. A join to
--          organizations there would depend on the reader's own row
--          security; the helper is the one definition and reads as its
--          owner.
--   Every other policy follows the helper it calls, unchanged: "admins read
--   org memberships", the storage policy "members read course content",
--   journey_day_funnel's guard, and the rest. "members can read own
--   memberships" stays: a person still reads their own rows.
--
-- SPEED (ADR 0030 section C point 5): no new index. Each helper is one
-- lookup on the primary key of organization_members (organization_id,
-- user_id) and one on the primary key of organizations (id), with no cast or
-- function on a key column. explain (analyze, buffers) of the heaviest
-- session reads of the Library list and of the learner dashboard is read on
-- staging before and after the paste and recorded with it; if either grows
-- beyond run-to-run noise the architect decides on the set form.
--
-- ORDER (ADR 0030 decision 9 and section J): staging first, then the full
-- e2e and lifecycle regression on the older code, then the app code.
-- Production: this file in a small sitting of its own once staging is
-- green, ahead of ADR 0024's sitting and without changing it. Safe in both
-- orders with the code: the file only narrows, and it reads columns that
-- every database has had since 0011 (status) and 0021 (deleted_at). It
-- touches nothing defined after 0056, so it is pasted before or after 0105
-- to 0114.
--
-- REQUIRES organization_members.status (0011), organizations.deleted_at
-- (0021) and all seven policies. Section 0a refuses without a table or a
-- column, section 0c without a policy (the file alters policies and never
-- creates one) or with a helper whose argument is not org_id (a replace
-- cannot rename it). A refusal changes nothing.
--
-- RE-PASTE. Idempotent: create or replace and alter policy set the same
-- text each time, and the grants repeat cleanly.
--
-- NEVER PASTE AGAIN (docs/MIGRATIONS.md and ops/RUNBOOK.md carry the same
-- rule): After 0115, none of 0001, 0002, 0006, 0010, 0019, 0026, 0027, 0030,
-- 0031, 0055 and 0056 is pasted again on that database. If one is pasted,
-- 0115 is pasted again directly after it, in the same sitting, and its
-- after-checks are read. Where 0110 is applied and the file was 0027, 0110
-- follows 0115. A paste of 0105, 0106, 0107, 0108 or 0112 needs nothing
-- from 0115. The after-checks of 0115 are also kept as a read-only block
-- that can be run alone (ops/0115-after-checks.sql); it is run after every
-- sitting that pastes a migration, whatever its number.
-- Each of the eleven restores an old helper body or an old policy. 0027
-- removes every policy on profiles in a loop and recreates the old one.
-- 0006 holds the old profiles policy written against profiles.user_id, which
-- 0027 renamed to id: its paste stops with 42703 and restores nothing, and
-- it is on the list all the same. tests/unit/membership-rule-migrations.test.ts
-- fails any other migration that restates a helper or one of the seven
-- policies without the rule, or that adds a function or a view reading
-- organization_members with auth.uid() without it.
--
-- ADR 0026 (0110, not written yet). The class checks below admit two named
-- policies, from this first version on: "impersonator reads profiles" on
-- public.profiles and "impersonator reads organization_members" on
-- public.organization_members, each only when its command is select, its
-- text calls is_impersonating or impersonated_org_ids, and its text holds no
-- auth.uid(). Anything else outside the expected sets still fails. Two rules
-- for 0110 travel in this header until ADR 0026's dated note is published:
-- its "a member is never an impersonator" test is written as
-- `not public.is_org_member(<the helper's organisation argument>)`, so it
-- follows whichever body of is_org_member the database holds; and its
-- helper also requires the target organisation's deleted_at is null. Neither
-- file is pasted again because of the other. Whichever of the two is pasted
-- second, the after-checks of this file are read again after it.
--
-- Row writes: none. Locks: each alter policy takes ACCESS EXCLUSIVE on its
-- table (organizations, tenant_subscriptions, profiles, course_packages,
-- course_ratings) until commit, so reads of those tables wait for the
-- commit, which follows within the same paste. lock_timeout 5 s: if a lock
-- is not granted the whole file rolls back and can simply be pasted again.
-- Staging: paste when no spec, CI e2e run or harness is in progress.
--
-- Grants: none on a relation (the file creates none, so
-- scripts/check-migration-grants.mjs has nothing to check in it). execute
-- on the four helpers, literal, for anon, authenticated and service_role
-- (ADR 0030 section C point 2; 0049 leaves them executable on purpose).
--
-- REVERSE: ops/0115-reverse.sql restores the four bodies and the seven
-- policies as the repository defined them before this file. It is for a
-- paste that went wrong only: it brings back the old rule. A code rollback
-- needs no reverse.
--
-- BEFORE the apply (read-only; role postgres; ids only, never a name or an
-- address). B1 to B11 are ONE select: section 0b below, from its line
-- `with` to its `;`. Run it alone in the SQL editor and record every row
-- (check_id, item, observed, verdict). The paste runs the same select into a
-- temporary table, and section 0c refuses on a row marked REFUSES. Every row
-- whose verdict is not ok or info goes to the owner before the paste.
-- Verdicts: ok; info; LIST (who or what loses access, for the owner to
-- read); admitted (one of ADR 0026's two named policies); DIFFERS (a stored
-- definition, command or role list that is not the repository's: the paste
-- writes 0115's text over a helper body or a policy expression and goes on,
-- but its after-check fails, and the paste rolls back, on a command of one
-- of the seven policies (A2) and on the expression or command of the two
-- policies on organization_members (A4)); UNEXPECTED (outside the expected
-- set: the after-check of this file fails on it); REFUSES (section 0c
-- refuses the paste on it).
--   B1   which files the database holds, one marker object each: 0099,
--        0100, 0103 to 0110, 0112 to 0115.
--   B2   the four helpers: the body as the repository's last definition
--        before 0115, as 0115, or differs (the stored text is printed);
--        security definer; the pinned search_path; the argument name.
--        is_org_data_analyst may be absent (info: this file creates it).
--   B3   the seven policies: absent REFUSES; command, roles and expression
--        compared with the repository's last definition before 0115 and
--        with 0115's. Postgres prints an expression in its own form, and
--        the form can change between versions: a DIFFERS row shows the
--        stored text; compare it with the file named.
--   B4a  every policy in every schema (storage included) whose using or
--        with check names organization_members. Expected: the seven.
--   B4b  every policy on public.organization_members itself (their text
--        does not name the table). Expected: "members can read own
--        memberships" and "admins read org memberships", with their
--        expressions.
--   B4c  every function whose source names organization_members together
--        with auth.uid(). Expected: the four helpers, and
--        get_my_gamification(uuid) and set_gamification_opt_out(uuid,
--        boolean) from 0053 (they answer only the caller's own figures and
--        read the status already; they take the helper when next restated).
--        The same search over a replay of the repository's files through
--        0104, and through 0107 and 0112, finds these six and nothing else.
--   B4d  every view or materialised view whose definition names
--        organization_members together with auth.uid(). Expected: none (a
--        view reads the reader's own membership row as they do, whatever
--        its status, so it takes a helper instead).
--   B5   membership rows by status.
--   B6   deleted organisations (ids).
--   B7   live organisations with no active administrator (ids).
--   B8   people who hold a membership row and none that counts (ids): they
--        lose access at the paste.
--   B9   platform owners who hold a membership row: user, organisation and
--        the row's status (ids). A platform owner whose own row in a tenant
--        is not active no longer enters it by impersonation (ADR 0030
--        decision 6(c)); the platform console is not affected.
--   B10  policies that call one of the helpers, and on how many relations
--        (a replay of the repository reads 82 policies on 49 relations
--        through 0104, production's baseline, and 84 on 51 with 0105 to 0107
--        and 0112, staging's; after 0115 five more, on four more relations:
--        87 on 53 and 89 on 55). No count is asserted.
--   B11  the whole stored definition of each helper present (as
--        pg_get_functiondef prints it) and of each of the seven policies
--        (as an alter policy statement with its using and with check), not
--        cut short: the source of ops/0115-reverse.sql for an object that B2
--        or B3 marks DIFFERS. Keep these rows whole with the record of the
--        sitting.
--
-- AFTER the apply: section 4 runs inside this file and raises on failure,
-- which rolls the whole file back. ops/0115-after-checks.sql is the same
-- block, read-only, to run alone at any time. It checks:
--   A1  each helper: present, security definer, stable, boolean, argument
--       org_id, search_path pinned, a body (its comments dropped) with
--       status = 'active', deleted_at is null and auth.uid(), and its role
--       list ('admin' never in is_org_super_owner or is_org_data_analyst).
--   A2  the seven policies: present with their command; both tests in the
--       two organizations policies (using, and with check for the update);
--       is_org_member in the other five (using, and with check for "org
--       admins write packages").
--   A3  anon, authenticated and service_role execute the four helpers.
--   A4  the lists of B4a to B4d hold nothing outside their expected sets
--       (ADR 0026's two named policies admitted as above).
--   A5  a member's session: an active member of a live organisation reads
--       it; where a membership row that does not count exists, its holder
--       reads no row of that organisation and none of its courses. Each is
--       the first such person by user id who is not a platform owner. No
--       test data is created; with nobody to read as, that part is skipped
--       with a notice.
-- A1 and A2 test that the rule's words are there, not that the text is
-- 0115's: a later file may restate a helper with the rule (ADR 0030 section
-- C point 5 foresees a set form), and the block stays as it is. To compare
-- the exact text, run the before-check select again: B2 and B3 print "as
-- 0115" for each helper and policy that holds 0115's text, and print the
-- stored text where it differs.

begin;

-- A lock wait must never queue the app's reads behind this file: if a lock
-- is not granted within 5 s the whole transaction rolls back cleanly and
-- can simply be pasted again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0a. Prerequisites: the tables and the two columns the rule reads
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text[] := '{}';
  r record;
begin
  for r in
    select * from (values
      ('organizations', null), ('organizations', 'deleted_at'),
      ('organization_members', null), ('organization_members', 'status'),
      ('tenant_subscriptions', null), ('profiles', null), ('courses', null),
      ('course_packages', null), ('course_ratings', null), ('platform_owners', null)
    ) as t(tbl, col)
  loop
    if to_regclass('public.' || r.tbl) is null then
      v_missing := v_missing || format('public.%s', r.tbl);
    elsif r.col is not null and not exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass('public.' || r.tbl) and a.attname = r.col
         and a.attnum > 0 and not a.attisdropped) then
      v_missing := v_missing || format('public.%s.%s', r.tbl, r.col);
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception '0115 refused: % missing. Nothing changed.', array_to_string(v_missing, ', ')
      using hint = 'ADR 0030 section C: status comes with 0011 and deleted_at with 0021.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 0b. Before-checks B1 to B11 (read-only; the header's BEFORE)
-- ---------------------------------------------------------------------------
-- One select, kept in a temporary table for the refusals of section 0c. The
-- owner's before-check is the same select, run alone. It reads catalogs and
-- three tables, and prints ids only. The expected texts are compared as
-- md5 of the text in lower case with its white space collapsed.
drop table if exists pg_temp.adr0030_0115_before;
create temporary table adr0030_0115_before on commit drop as
-- before-check select: begin
with
helper(fn, origin, md5_repo, md5_0115) as (
  values ('is_org_member',       '0002', 'b1bfa9ecf05c64f07c58dfcd68949d4c',  'e294cd64bba69115cc0b9d6d999e0028'),
         ('is_org_admin',        '0056', '2fe3b5a93df173449052a6063e5773bb',   'f4804ccefbe6dc8bccf8df37bd91014e'),
         ('is_org_super_owner',  '0055', 'd1468d0fba3b44da11dad2ccf9fbdc8a',   'ab785236a3fce63866cca94fae265370'),
         ('is_org_data_analyst', '0010', '2fb9d680feceb714468cdcb79b75238e', '6b954045ccb6524c279a1be15c507d1e')
),
pol(tbl, name, cmd, roles, origin, md5_repo, md5_0115) as (
  values ('organizations',        'members can read their orgs',         'r', 'public',        '0001', '091a0d9cc756b601fa447c813a420e35',  'a1cedd889e717e9c4b8f383c054af5b0'),
         ('organizations',        'owners and admins can update orgs',   'w', 'public',        '0019', '86c25ccc1b8aa17428f20b4bdf825c41',   '039df1f296181e75be331dfa44e9e3e4'),
         ('tenant_subscriptions', 'tenant admins read own subscription', 'r', 'authenticated', '0026', 'b5a52832dbf5f3f8c1010922cc0016f9',       'fa0272ad26a535ca95226b5a1136e80e'),
         ('profiles',             'users read profiles in shared orgs',  'r', 'authenticated', '0027', '348201839f56254c9807114cb2b1eb70',      'd4fc137aa600479a12e8a1984a2f4afb'),
         ('course_packages',      'org members read packages',           'r', 'authenticated', '0030', '0c3b966735367f545bdbe7191ab6c96d',  '9c60cb44cff5a225173656226544bb6d'),
         ('course_packages',      'org admins write packages',           '*', 'authenticated', '0030', 'c9aab67fc3302cefbd6800d995c79a77', 'c812f61eb213ae814d303c26d4d32c7e'),
         ('course_ratings',       'org admins read all ratings',         'r', 'authenticated', '0031', '82b28c6d7dee9e0458d8de52312beba4',      '81a9c06023219ac7bd27428d4ab5bbe5')
),
member_pol(name, md5_expr) as (
  values ('members can read own memberships', '153ad695b1ce1787370c0be009eda7e4'),
         ('admins read org memberships',      '873efa157f721135f8faa51a8f534343')
),
member_fn(sig) as (
  values ('public.is_org_member(uuid)'), ('public.is_org_admin(uuid)'), ('public.is_org_super_owner(uuid)'),
         ('public.is_org_data_analyst(uuid)'), ('public.get_my_gamification(uuid)'),
         ('public.set_gamification_opt_out(uuid, boolean)')
),
admitted(tbl, name) as (
  values ('profiles', 'impersonator reads profiles'),
         ('organization_members', 'impersonator reads organization_members')
),
policies as (
  select n.nspname::text as sch, c.relname::text as tbl, p.polname::text as name, p.polcmd::text as cmd,
         (select string_agg(q.rn, ',' order by q.rn)
            from (select case when x = 0 then 'public' else pg_get_userbyid(x)::text end as rn
                    from unnest(p.polroles) x) q) as roles,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') as qual,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as chk
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
),
fns as (
  select n.nspname::text || '.' || p.proname::text || '(' || oidvectortypes(p.proargtypes) || ')' as sig,
         p.prosrc, p.prosecdef, p.proconfig, p.proargnames
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
),
live_member as (
  select m.user_id, m.organization_id, m.status, m.role::text as role, o.deleted_at,
         (m.status = 'active' and o.deleted_at is null) as counts
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
),
grid(check_id, item, observed, verdict) as (
  -- B1: one marker object for each file
  select 'B1', f, case when yes then 'present' else 'absent' end, 'info'
  from (values
    ('0099', exists (select 1 from pg_policy where polname = 'admins read package validations'
                      and polrelid = to_regclass('public.package_validations'))),
    ('0100', to_regclass('public.learning_sessions') is not null),
    ('0103', to_regclass('public.revision_visits') is not null),
    ('0104', exists (select 1 from pg_attribute where attrelid = to_regclass('public.course_attempts')
                      and attname = 'ignored_pass' and not attisdropped)),
    ('0105', to_regprocedure('public.group_member_ids(uuid)') is not null),
    ('0106', to_regprocedure('public.course_feedback_summary(uuid)') is not null),
    ('0107', to_regprocedure('public.record_learning_activity(uuid,boolean)') is not null),
    ('0108', to_regprocedure('public.record_learning_activity(uuid,boolean)') is not null
             and to_regclass('public.context_derive_log') is null),
    ('0109', to_regclass('public.v_individual_enrollment_status') is not null),
    ('0110', exists (select 1 from pg_proc where proname = 'is_impersonating'
                      and pronamespace = 'public'::regnamespace)),
    ('0112', to_regprocedure('public.sweep_completion_side_effects_timed(integer,integer)') is not null),
    ('0113', to_regclass('public.platform_email_log') is not null),
    ('0114', to_regclass('public.tenant_smtp_state') is not null),
    ('0115', exists (select 1 from fns where sig = 'public.is_org_member(uuid)'
                      and prosrc ~* 'status\s*=\s*''active'''))
  ) as m(f, yes)
  union all
  -- B2: the four helpers
  select 'B2', h.fn,
         case when f.sig is null then
                'absent' || case when h.fn = 'is_org_data_analyst' then '; this file creates it' else '' end
              else concat_ws('; ',
                case md5(btrim(regexp_replace(lower(f.prosrc), '\s+', ' ', 'g')))
                  when h.md5_repo then 'body as ' || h.origin
                  when h.md5_0115 then 'body as 0115'
                  else 'body differs: ' || left(btrim(regexp_replace(f.prosrc, '\s+', ' ', 'g')), 500) end,
                case when f.prosecdef then 'security definer' else 'not security definer' end,
                coalesce(array_to_string(f.proconfig, ','), 'no pinned search_path'),
                'argument ' || coalesce(array_to_string(f.proargnames, ','), '(unnamed)'))
         end,
         case when f.sig is null and h.fn = 'is_org_data_analyst' then 'info'
              when f.sig is null then 'DIFFERS'
              when f.proargnames is distinct from array['org_id'] then 'REFUSES'
              when md5(btrim(regexp_replace(lower(f.prosrc), '\s+', ' ', 'g'))) in (h.md5_repo, h.md5_0115)
                   and f.prosecdef then 'ok'
              else 'DIFFERS' end
  from helper h
  left join fns f on f.sig = 'public.' || h.fn || '(uuid)'
  union all
  -- B3: the seven policies
  select 'B3', 'public.' || x.tbl || ': ' || x.name,
         case when p.name is null then 'absent: this file alters it and never creates it'
              else concat_ws('; ',
                case md5(btrim(regexp_replace(lower(p.qual || ' | ' || p.chk), '\s+', ' ', 'g')))
                  when x.md5_repo then 'as ' || x.origin
                  when x.md5_0115 then 'as 0115'
                  else 'differs: ' || left(btrim(regexp_replace(p.qual || ' | ' || p.chk, '\s+', ' ', 'g')), 800) end,
                'command ' || p.cmd, 'roles ' || p.roles)
         end,
         case when p.name is null then 'REFUSES'
              when p.cmd <> x.cmd or p.roles <> x.roles then 'DIFFERS'
              when md5(btrim(regexp_replace(lower(p.qual || ' | ' || p.chk), '\s+', ' ', 'g')))
                   in (x.md5_repo, x.md5_0115) then 'ok'
              else 'DIFFERS' end
  from pol x
  left join policies p on p.sch = 'public' and p.tbl = x.tbl and p.name = x.name
  union all
  -- B4a: every policy whose using or with check names organization_members
  select 'B4a', p.sch || '.' || p.tbl || ': ' || p.name, 'command ' || p.cmd || '; roles ' || p.roles,
         case when p.sch = 'public' and exists (select 1 from pol x where x.tbl = p.tbl and x.name = p.name) then 'ok'
              when p.sch = 'public' and exists (select 1 from admitted a where a.tbl = p.tbl and a.name = p.name)
                   and p.cmd = 'r'
                   and (p.qual || ' ' || p.chk) ~* '(is_impersonating|impersonated_org_ids)\s*\('
                   and (p.qual || ' ' || p.chk) !~* 'auth\.uid\s*\(' then 'admitted'
              else 'UNEXPECTED' end
  from policies p
  where (p.qual || ' ' || p.chk) ~* 'organization_members'
  union all
  -- B4b: every policy on public.organization_members itself
  select 'B4b', p.name, 'command ' || p.cmd || '; roles ' || p.roles,
         case when exists (select 1 from member_pol mp where mp.name = p.name
                            and mp.md5_expr = md5(btrim(regexp_replace(lower(p.qual || ' | ' || p.chk), '\s+', ' ', 'g'))))
                   and p.cmd = 'r' then 'ok'
              when exists (select 1 from member_pol mp where mp.name = p.name) then 'DIFFERS'
              when exists (select 1 from admitted a where a.tbl = p.tbl and a.name = p.name)
                   and p.cmd = 'r'
                   and (p.qual || ' ' || p.chk) ~* '(is_impersonating|impersonated_org_ids)\s*\('
                   and (p.qual || ' ' || p.chk) !~* 'auth\.uid\s*\(' then 'admitted'
              else 'UNEXPECTED' end
  from policies p
  where p.sch = 'public' and p.tbl = 'organization_members'
  union all
  -- B4c: every function whose source names organization_members and auth.uid()
  select 'B4c', f.sig, case when f.prosecdef then 'security definer' else 'security invoker' end,
         case when f.sig in (select sig from member_fn) then 'ok' else 'UNEXPECTED' end
  from fns f
  where f.prosrc ~* 'organization_members' and f.prosrc ~* 'auth\.uid\s*\('
  union all
  -- B4d: every view or materialised view whose definition names
  -- organization_members and auth.uid() (none is expected)
  select 'B4d', v.sch || '.' || v.name, v.kind, 'UNEXPECTED'
  from (select schemaname::text as sch, viewname::text as name, 'view' as kind, definition from pg_views
        union all
        select schemaname::text, matviewname::text, 'materialized view', definition from pg_matviews) v
  where v.definition ~* 'organization_members' and v.definition ~* 'auth\.uid\s*\('
  union all
  -- B5: membership rows by status
  select 'B5', s.status, (select count(*) from public.organization_members m where m.status = s.status)::text, 'info'
  from (values ('active'), ('inactive'), ('suspended')) as s(status)
  union all
  -- B6: deleted organisations
  select 'B6', 'deleted organisations',
         count(*)::text || coalesce(': ' || string_agg(o.id::text, ', ' order by o.id), ''),
         case when count(*) = 0 then 'ok' else 'LIST' end
  from public.organizations o
  where o.deleted_at is not null
  union all
  -- B7: live organisations with no active administrator
  select 'B7', 'live organisations with no active administrator',
         count(*)::text || coalesce(': ' || string_agg(o.id::text, ', ' order by o.id), ''),
         case when count(*) = 0 then 'ok' else 'LIST' end
  from public.organizations o
  where o.deleted_at is null
    and not exists (select 1 from public.organization_members m
                     where m.organization_id = o.id and m.status = 'active'
                       and m.role::text in ('owner', 'super_owner', 'admin'))
  union all
  -- B8: people who hold a membership row and none that counts
  select 'B8', 'people with no membership that counts',
         count(*)::text || coalesce(': ' || string_agg(q.user_id::text, ', ' order by q.user_id), ''),
         case when count(*) = 0 then 'ok' else 'LIST' end
  from (select lm.user_id from live_member lm group by lm.user_id having not bool_or(lm.counts)) q
  union all
  -- B9: platform owners who hold a membership row
  select 'B9', 'platform owners holding a membership row',
         count(*)::text || coalesce(': ' || string_agg(
           lm.user_id::text || ' in ' || lm.organization_id::text || ' ' || lm.status
           || case when lm.deleted_at is not null then ' (organisation deleted)' else '' end,
           ', ' order by lm.user_id, lm.organization_id), ''),
         case when count(*) = 0 then 'ok' else 'LIST' end
  from live_member lm
  where exists (select 1 from public.platform_owners po where po.user_id = lm.user_id)
  union all
  -- B10: the callers of the helpers
  select 'B10', 'policies that call a helper',
         count(*)::text || ' policies on ' || count(distinct p.sch || '.' || p.tbl)::text || ' relations', 'info'
  from policies p
  where (p.qual || ' ' || p.chk) ~* 'is_org_(member|admin|super_owner|data_analyst)\s*\('
  union all
  -- B11: the whole stored definitions, as statements that put them back
  select 'B11', 'public.' || h.fn || '(uuid)', pg_get_functiondef(to_regprocedure('public.' || h.fn || '(uuid)')), 'info'
  from helper h
  where to_regprocedure('public.' || h.fn || '(uuid)') is not null
  union all
  select 'B11', 'public.' || x.tbl || ': ' || x.name,
         format('alter policy %I on public.%I', x.name, x.tbl)
         || case when p.qual <> '' then format(' using (%s)', p.qual) else '' end
         || case when p.chk <> '' then format(' with check (%s)', p.chk) else '' end || ';',
         'info'
  from pol x
  join policies p on p.sch = 'public' and p.tbl = x.tbl and p.name = x.name
)
select check_id, item, observed, verdict
from grid
order by check_id, item;
-- before-check select: end

-- ---------------------------------------------------------------------------
-- 0c. Refusals: a missing policy, or a helper whose argument is not org_id
-- ---------------------------------------------------------------------------
do $$
declare
  v_refused text;
begin
  select string_agg(check_id || ' ' || item || ' (' || observed || ')', '; ' order by check_id, item)
    into v_refused
    from pg_temp.adr0030_0115_before
   where verdict = 'REFUSES';
  if v_refused is not null then
    raise exception '0115 refused: %. Nothing changed.', v_refused
      using hint = 'ADR 0030 section C point 3: the file alters the seven policies and never creates one; '
                   'a replace cannot rename a helper''s argument. Answer the before-check rows with the owner first.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The four helpers (ADR 0030 section C point 1): the rule on the reader's
--    own row; same name, argument, result and role list as before
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = is_org_member.org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and o.deleted_at is null
  );
$$;

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = is_org_admin.org_id
      and m.user_id = auth.uid()
      and m.role::text in ('owner', 'super_owner', 'admin')
      and m.status = 'active'
      and o.deleted_at is null
  );
$$;

create or replace function public.is_org_super_owner(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = is_org_super_owner.org_id
      and m.user_id = auth.uid()
      and m.role::text in ('owner', 'super_owner')
      and m.status = 'active'
      and o.deleted_at is null
  );
$$;

create or replace function public.is_org_data_analyst(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = is_org_data_analyst.org_id
      and m.user_id = auth.uid()
      and m.role::text = 'data_analyst'
      and m.status = 'active'
      and o.deleted_at is null
  );
$$;

-- 2. Literal grants, nothing revoked (section C point 2): every policy that
--    calls a helper fails for a role without execute.
grant execute on function public.is_org_member(uuid)       to anon, authenticated, service_role;
grant execute on function public.is_org_admin(uuid)        to anon, authenticated, service_role;
grant execute on function public.is_org_super_owner(uuid)  to anon, authenticated, service_role;
grant execute on function public.is_org_data_analyst(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The seven policies that read organization_members themselves (section
--    C point 3): alter policy keeps the command and the roles; each body is
--    its last definition with one conjunct added
-- ---------------------------------------------------------------------------
-- 0001:39-48, plus the row's own deleted_at and the status of the reader's row
alter policy "members can read their orgs"
  on public.organizations
  using (
    organizations.deleted_at is null
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- 0019:13-31, the same two in using and in with check
alter policy "owners and admins can update orgs"
  on public.organizations
  using (
    organizations.deleted_at is null
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.role::text = any (array['super_owner', 'owner', 'admin'])
        and m.status = 'active'
    )
  )
  with check (
    organizations.deleted_at is null
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.role::text = any (array['super_owner', 'owner', 'admin'])
        and m.status = 'active'
    )
  );

-- 0026:36-49, plus the helper on the subscription's organisation; the role
-- list stays ('owner', 'admin')
alter policy "tenant admins read own subscription"
  on public.tenant_subscriptions
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = tenant_subscriptions.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
    and public.is_org_member(tenant_subscriptions.organization_id)
  );

-- 0027:106-116, plus the helper on the reader's row `me` only; nothing is
-- asked of the row of the person read (`them`)
alter policy "users read profiles in shared orgs"
  on public.profiles
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.organization_members me
      join public.organization_members them on them.organization_id = me.organization_id
      where me.user_id = auth.uid() and them.user_id = profiles.id
        and public.is_org_member(me.organization_id)
    )
  );

-- 0030:104-113, plus the helper on the course's organisation
alter policy "org members read packages"
  on public.course_packages
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
      and public.is_org_member(c.organization_id)
  ));

-- 0030:115-133, the same in using and in with check
alter policy "org admins write packages"
  on public.course_packages
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin')
      and public.is_org_member(c.organization_id)
  ))
  with check (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin')
      and public.is_org_member(c.organization_id)
  ));

-- 0031:70-80, the same; the role list keeps data_analyst
alter policy "org admins read all ratings"
  on public.course_ratings
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_ratings.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin', 'data_analyst')
      and public.is_org_member(c.organization_id)
  ));

-- ---------------------------------------------------------------------------
-- 4. After-checks A1 to A5 (catalog reads and one member's session; any
--    failure rolls the file back). ops/0115-after-checks.sql holds the same
--    block, between the same two marker lines, to run alone.
-- ---------------------------------------------------------------------------
-- 0115 after-checks: begin
do $after$
declare
  bad      text[] := '{}';
  r        record;
  v_role   text;
  v_me     text := current_user;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_user   uuid;
  v_org    uuid;
  n_org    bigint;
  n_course bigint;
  v_member boolean;
  v_src    text;
  st       text;
begin
  -- A1: the four helpers (the word tests read the body with its comments
  -- dropped)
  for r in
    select h.fn, h.roles, h.never, p.prosrc, p.prosecdef, p.provolatile, p.prorettype, p.proconfig, p.proargnames
    from (values
      ('is_org_member',       array[]::text[],                          array[]::text[]),
      ('is_org_admin',        array['owner', 'super_owner', 'admin'],   array[]::text[]),
      ('is_org_super_owner',  array['owner', 'super_owner'],            array['admin']),
      ('is_org_data_analyst', array['data_analyst'],                    array['admin'])
    ) as h(fn, roles, never)
    left join pg_proc p on p.oid = to_regprocedure('public.' || h.fn || '(uuid)')
  loop
    if r.prosrc is null then
      bad := bad || format('A1 %s(uuid) is missing', r.fn);
      continue;
    end if;
    v_src := regexp_replace(regexp_replace(r.prosrc, '/\*.*?\*/', ' ', 'g'), '-{2}.*$', ' ', 'gn');
    if v_src !~* 'status\s*=\s*''active''' then
      bad := bad || format('A1 %s body lacks the test status = ''active''', r.fn);
    end if;
    if v_src !~* 'deleted_at\s+is\s+null' then
      bad := bad || format('A1 %s body lacks the test deleted_at is null', r.fn);
    end if;
    if v_src !~* 'auth\.uid\s*\(' then
      bad := bad || format('A1 %s body does not read auth.uid()', r.fn);
    end if;
    foreach v_role in array r.roles loop
      if position('''' || v_role || '''' in v_src) = 0 then
        bad := bad || format('A1 %s body lacks the role %s', r.fn, v_role);
      end if;
    end loop;
    foreach v_role in array r.never loop
      if position('''' || v_role || '''' in v_src) > 0 then
        bad := bad || format('A1 %s body names the role %s', r.fn, v_role);
      end if;
    end loop;
    if not r.prosecdef then
      bad := bad || format('A1 %s is not security definer', r.fn);
    end if;
    if r.provolatile <> 's' then
      bad := bad || format('A1 %s is not stable', r.fn);
    end if;
    if r.prorettype <> 'boolean'::regtype then
      bad := bad || format('A1 %s does not return boolean', r.fn);
    end if;
    if r.proargnames is distinct from array['org_id'] then
      bad := bad || format('A1 %s argument is not org_id', r.fn);
    end if;
    if not exists (select 1 from unnest(coalesce(r.proconfig, '{}')) c where c ~* '^search_path=') then
      bad := bad || format('A1 %s has no pinned search_path', r.fn);
    end if;
  end loop;

  -- A2: the seven policies that read organization_members themselves
  for r in
    select x.tbl, x.name, x.cmd, x.rule, p.polcmd::text as got,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') as qual,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as chk
    from (values
      ('organizations',        'members can read their orgs',         'r', 'both'),
      ('organizations',        'owners and admins can update orgs',   'w', 'both'),
      ('tenant_subscriptions', 'tenant admins read own subscription', 'r', 'helper'),
      ('profiles',             'users read profiles in shared orgs',  'r', 'helper'),
      ('course_packages',      'org members read packages',           'r', 'helper'),
      ('course_packages',      'org admins write packages',           '*', 'helper'),
      ('course_ratings',       'org admins read all ratings',         'r', 'helper')
    ) as x(tbl, name, cmd, rule)
    left join pg_policy p on p.polrelid = to_regclass('public.' || x.tbl) and p.polname = x.name
  loop
    if r.got is null then
      bad := bad || format('A2 policy "%s" on public.%s is missing', r.name, r.tbl);
      continue;
    end if;
    if r.got <> r.cmd then
      bad := bad || format('A2 policy "%s" on public.%s has command %s, not %s', r.name, r.tbl, r.got, r.cmd);
    end if;
    if r.rule = 'both' then
      if r.qual !~* 'status\s*=\s*''active''' or r.qual !~* 'deleted_at\s+is\s+null' then
        bad := bad || format('A2 policy "%s" on public.%s: using lacks a test of the rule', r.name, r.tbl);
      end if;
      if r.cmd = 'w' and (r.chk !~* 'status\s*=\s*''active''' or r.chk !~* 'deleted_at\s+is\s+null') then
        bad := bad || format('A2 policy "%s" on public.%s: with check lacks a test of the rule', r.name, r.tbl);
      end if;
    else
      if r.qual !~* 'is_org_member\s*\(' then
        bad := bad || format('A2 policy "%s" on public.%s: using does not call is_org_member', r.name, r.tbl);
      end if;
      if r.cmd = '*' and r.chk !~* 'is_org_member\s*\(' then
        bad := bad || format('A2 policy "%s" on public.%s: with check does not call is_org_member', r.name, r.tbl);
      end if;
    end if;
  end loop;

  -- A3: the three Data API roles execute the four helpers
  for r in
    select h.fn, x.rol
    from (values ('is_org_member'), ('is_org_admin'), ('is_org_super_owner'), ('is_org_data_analyst')) as h(fn)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as x(rol)
    where to_regprocedure('public.' || h.fn || '(uuid)') is not null
  loop
    if not has_function_privilege(r.rol, to_regprocedure('public.' || r.fn || '(uuid)'), 'execute') then
      bad := bad || format('A3 %s cannot execute %s(uuid)', r.rol, r.fn);
    end if;
  end loop;

  -- A4: the four lists hold nothing outside their expected sets; ADR 0026's
  -- two named policies are admitted when their command is select, their text
  -- calls is_impersonating or impersonated_org_ids and holds no auth.uid();
  -- no view or materialised view reads organization_members with auth.uid()
  for r in
    with policies as (
      select n.nspname::text as sch, c.relname::text as tbl, p.polname::text as name, p.polcmd::text as cmd,
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as txt
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
    )
    select format('A4 policy "%s" on %s.%s', p.name, p.sch, p.tbl) as what
    from policies p
    where (p.txt ~* 'organization_members' or (p.sch = 'public' and p.tbl = 'organization_members'))
      and not (p.sch = 'public' and (p.tbl, p.name) in (values
                 ('organizations', 'members can read their orgs'),
                 ('organizations', 'owners and admins can update orgs'),
                 ('tenant_subscriptions', 'tenant admins read own subscription'),
                 ('profiles', 'users read profiles in shared orgs'),
                 ('course_packages', 'org members read packages'),
                 ('course_packages', 'org admins write packages'),
                 ('course_ratings', 'org admins read all ratings'),
                 ('organization_members', 'members can read own memberships'),
                 ('organization_members', 'admins read org memberships')))
      and not (p.sch = 'public'
               and (p.tbl, p.name) in (values
                 ('profiles', 'impersonator reads profiles'),
                 ('organization_members', 'impersonator reads organization_members'))
               and p.cmd = 'r'
               and p.txt ~* '(is_impersonating|impersonated_org_ids)\s*\('
               and p.txt !~* 'auth\.uid\s*\(')
    union all
    select format('A4 function %s.%s(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prosrc ~* 'organization_members' and p.prosrc ~* 'auth\.uid\s*\('
      and n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' not in (
        'public.is_org_member(uuid)', 'public.is_org_admin(uuid)', 'public.is_org_super_owner(uuid)',
        'public.is_org_data_analyst(uuid)', 'public.get_my_gamification(uuid)',
        'public.set_gamification_opt_out(uuid, boolean)')
    union all
    select format('A4 %s %s.%s', v.kind, v.sch, v.name)
    from (select schemaname::text as sch, viewname::text as name, 'view' as kind, definition from pg_views
          union all
          select schemaname::text, matviewname::text, 'materialized view', definition from pg_matviews) v
    where v.definition ~* 'organization_members' and v.definition ~* 'auth\.uid\s*\('
    order by 1
  loop
    bad := bad || (r.what || ' is outside the expected set');
  end loop;
  for r in
    select x.name, md5(btrim(regexp_replace(lower(coalesce(pg_get_expr(p.polqual, p.polrelid), '')), '\s+', ' ', 'g'))) as got,
           x.want, p.polcmd::text as cmd
    from (values ('members can read own memberships', '(user_id = auth.uid())'),
                 ('admins read org memberships', 'is_org_admin(organization_id)')) as x(name, want)
    left join pg_policy p on p.polrelid = 'public.organization_members'::regclass and p.polname = x.name
  loop
    if r.cmd is null then
      bad := bad || format('A4 policy "%s" on public.organization_members is missing', r.name);
    elsif r.cmd <> 'r' or r.got <> md5(lower(r.want)) then
      bad := bad || format('A4 policy "%s" on public.organization_members is not %s for select', r.name, r.want);
    end if;
  end loop;

  -- A5: a member's session. The control first: an active member of a live
  -- organisation reads it. Then the holder of a row that does not count
  -- reads no row of that organisation and none of its courses.
  select m.user_id, m.organization_id into v_user, v_org
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
   where m.status = 'active' and o.deleted_at is null
     and not exists (select 1 from public.platform_owners po where po.user_id = m.user_id)
   order by m.user_id, m.organization_id
   limit 1;
  if v_user is null then
    raise notice '0115 after-check A5: no active member of a live organisation to read as; the control is skipped.';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    -- auth.uid() reads request.jwt.claim.sub first when it is set; it is
    -- touched only then, so the block leaves no such setting behind
    if nullif(v_sub, '') is not null then
      perform set_config('request.jwt.claim.sub', v_user::text, true);
    end if;
    execute 'set local role authenticated';
    st := null;
    begin
      select count(*) into n_org from public.organizations where id = v_org;
      v_member := public.is_org_member(v_org);
    exception when others then
      st := sqlstate;
    end;
    execute format('set local role %I', v_me);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    if nullif(v_sub, '') is not null then
      perform set_config('request.jwt.claim.sub', v_sub, true);
    end if;
    if st is not null then
      bad := bad || format('A5 the control (an active member of a live organisation) raised %s', st);
    elsif n_org <> 1 or not v_member then
      bad := bad || 'A5 the control (an active member of a live organisation) does not read it';
    end if;
  end if;

  v_user := null;
  select m.user_id, m.organization_id into v_user, v_org
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
   where (m.status <> 'active' or o.deleted_at is not null)
     and not exists (select 1 from public.platform_owners po where po.user_id = m.user_id)
   order by m.user_id, m.organization_id
   limit 1;
  if v_user is null then
    raise notice '0115 after-check A5: no membership row that does not count; that read is skipped.';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    if nullif(v_sub, '') is not null then
      perform set_config('request.jwt.claim.sub', v_user::text, true);
    end if;
    execute 'set local role authenticated';
    st := null;
    begin
      select count(*) into n_org from public.organizations where id = v_org;
      select count(*) into n_course from public.courses where organization_id = v_org;
      v_member := public.is_org_member(v_org);
    exception when others then
      st := sqlstate;
    end;
    execute format('set local role %I', v_me);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    if nullif(v_sub, '') is not null then
      perform set_config('request.jwt.claim.sub', v_sub, true);
    end if;
    if st is not null then
      bad := bad || format('A5 the read as a row that does not count raised %s', st);
    elsif n_org <> 0 or n_course <> 0 or v_member then
      bad := bad || format('A5 a row that does not count still reads its organisation (%s row(s)), %s course(s), member %s',
                           n_org, n_course, v_member);
    end if;
  end if;

  if cardinality(bad) > 0 then
    raise exception '0115 after-check failed: %', array_to_string(bad, '; ')
      using hint = 'ADR 0030 section C point 7. Inside 0115 the whole file rolled back; run alone, nothing changed.';
  end if;
end
$after$;
-- 0115 after-checks: end

notify pgrst, 'reload schema';

commit;
