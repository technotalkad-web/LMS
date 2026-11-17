-- scripts/migration-rehearsal/assert-0115.sql
-- The 0115 scenarios, after each paste of 0115 (ADR 0030 section C, build
-- prerequisites point 3): what 0115_membership_status_enforced.sql must have
-- done, on the rows of seed-0115.sql.
--   (1) the four helpers: sql, stable, security definer, search_path pinned
--       to pg_catalog, public, boolean, argument org_id, and the body 0115
--       writes (compared as md5 of the text in lower case with its white
--       space collapsed, as 0115's own before-check compares it);
--   (2) execute for anon, authenticated and service_role on each;
--   (3) the seven policies: command and roles as the repository defined
--       them, and the expressions 0115 writes; the two policies on
--       organization_members unchanged; the before-check's temporary table
--       gone with the paste's commit;
--   (4) every seeded person's session over the tables of section C: the
--       organisation, its subscription, its courses, packages and ratings,
--       its membership rows, profiles, the four helpers, and the writes the
--       two write policies govern. Each "reads nothing" sits beside the
--       control in the same block: the active administrator of the same
--       organisation reads every row, the inactive learner's included.
--       Proven by text alone, not by a session case: the conjunct that four
--       policies gain (profiles "users read profiles in shared orgs", both
--       course_packages policies, course_ratings "org admins read all
--       ratings"). The reads inside them (organization_members, and courses
--       inside the exists) already pass through row security that applies
--       the helpers, so a session reads the same rows with or without it;
--       the conjunct is defence in depth, and (3) holds its text.
-- One transaction that ends in ROLLBACK; each read and write runs as the
-- person's session inside a block that is rolled back, so nothing it does
-- stays. A failure raises "assert-0115 failed:" and names each object.
begin;

create temporary table assert_0115_case (who text, what text, target text, want text) on commit drop;
insert into assert_0115_case (who, what, target, want) values
  -- O1, the control: the active administrator reads everything, the
  -- inactive learner's rating, row and profile included
  ('A',   'org',     'O1', '1'), ('A', 'sub', 'O1', '1'), ('A', 'course', 'O1', '1'),
  ('A',   'pkg',     'C1', '1'), ('A', 'rate', 'C1', '2'), ('A', 'members', 'O1', '10'),
  ('A',   'profile', 'IL', '1'), ('A', 'profile', 'Y', '0'),
  ('A',   'member',  'O1', 'true'), ('A', 'admin', 'O1', 'true'), ('A', 'super', 'O1', 'false'), ('A', 'analyst', 'O1', 'false'),
  ('A',   'upd',     'O1', '1'), ('A', 'softdel', 'O1', 'error 42501'),
  ('A',   'pkgupd',  'C1', '1'), ('A', 'pkgins', 'C1', '1'),
  -- an active learner
  ('L',   'org',     'O1', '1'), ('L', 'sub', 'O1', '0'), ('L', 'course', 'O1', '1'), ('L', 'pkg', 'C1', '1'),
  ('L',   'rate',    'C1', '1'), ('L', 'members', 'O1', '1'), ('L', 'profile', 'L', '1'),
  ('L',   'member',  'O1', 'true'), ('L', 'admin', 'O1', 'false'),
  -- an inactive learner: rows about oneself only (decision 5)
  ('IL',  'org',     'O1', '0'), ('IL', 'sub', 'O1', '0'), ('IL', 'course', 'O1', '0'), ('IL', 'pkg', 'C1', '0'),
  ('IL',  'rate',    'C1', '1'), ('IL', 'members', 'O1', '1'), ('IL', 'profile', 'IL', '1'), ('IL', 'profile', 'A', '0'),
  ('IL',  'member',  'O1', 'false'), ('IL', 'admin', 'O1', 'false'),
  -- a suspended learner: the same as inactive
  ('SL',  'org',     'O1', '0'), ('SL', 'course', 'O1', '0'), ('SL', 'pkg', 'C1', '0'), ('SL', 'rate', 'C1', '0'),
  ('SL',  'members', 'O1', '1'), ('SL', 'member', 'O1', 'false'),
  -- an inactive administrator: no organisation row, no co-member's row or
  -- profile, no admin read of ratings, no write
  ('IA',  'org',     'O1', '0'), ('IA', 'sub', 'O1', '0'), ('IA', 'course', 'O1', '0'), ('IA', 'pkg', 'C1', '0'),
  ('IA',  'rate',    'C1', '0'), ('IA', 'members', 'O1', '1'), ('IA', 'profile', 'IL', '0'),
  ('IA',  'member',  'O1', 'false'), ('IA', 'admin', 'O1', 'false'),
  ('IA',  'upd',     'O1', '0'), ('IA', 'softdel', 'O1', '0'), ('IA', 'pkgupd', 'C1', '0'), ('IA', 'pkgins', 'C1', 'error 42501'),
  -- a suspended super owner
  ('SS',  'org',     'O1', '0'), ('SS', 'members', 'O1', '1'),
  ('SS',  'member',  'O1', 'false'), ('SS', 'admin', 'O1', 'false'), ('SS', 'super', 'O1', 'false'), ('SS', 'upd', 'O1', '0'),
  -- an active super owner: the subscription policy keeps ('owner', 'admin')
  ('SO',  'org',     'O1', '1'), ('SO', 'sub', 'O1', '0'), ('SO', 'members', 'O1', '10'),
  ('SO',  'member',  'O1', 'true'), ('SO', 'admin', 'O1', 'true'), ('SO', 'super', 'O1', 'true'), ('SO', 'upd', 'O1', '1'),
  -- an active data analyst (the ratings policy keeps data_analyst) and an
  -- inactive one
  ('AN',  'org',     'O1', '1'), ('AN', 'course', 'O1', '1'), ('AN', 'rate', 'C1', '2'), ('AN', 'members', 'O1', '1'),
  ('AN',  'member',  'O1', 'true'), ('AN', 'admin', 'O1', 'false'), ('AN', 'analyst', 'O1', 'true'),
  ('IAN', 'org',     'O1', '0'), ('IAN', 'course', 'O1', '0'), ('IAN', 'rate', 'C1', '0'),
  ('IAN', 'member',  'O1', 'false'), ('IAN', 'analyst', 'O1', 'false'),
  -- X: active administrator of O1, inactive administrator of O2. Reads O1
  -- and its co-members' profiles; nothing of O2 and nobody who is only in O2
  ('X',   'org',     'O1', '1'), ('X', 'members', 'O1', '10'), ('X', 'profile', 'IL', '1'),
  ('X',   'member',  'O1', 'true'), ('X', 'admin', 'O1', 'true'),
  ('X',   'org',     'O2', '0'), ('X', 'sub', 'O2', '0'), ('X', 'course', 'O2', '0'), ('X', 'pkg', 'C2', '0'),
  ('X',   'rate',    'C2', '0'), ('X', 'members', 'O2', '1'), ('X', 'profile', 'Y', '0'),
  ('X',   'member',  'O2', 'false'), ('X', 'admin', 'O2', 'false'), ('X', 'upd', 'O2', '0'),
  -- Y: the control of O2, who still reads X's inactive row and profile
  ('Y',   'org',     'O2', '1'), ('Y', 'sub', 'O2', '1'), ('Y', 'course', 'O2', '1'), ('Y', 'pkg', 'C2', '1'),
  ('Y',   'rate',    'C2', '1'), ('Y', 'members', 'O2', '2'), ('Y', 'profile', 'X', '1'),
  ('Y',   'member',  'O2', 'true'), ('Y', 'admin', 'O2', 'true'),
  -- D: an active administrator of a deleted organisation
  ('D',   'org',     'O3', '0'), ('D', 'sub', 'O3', '0'), ('D', 'course', 'O3', '0'), ('D', 'pkg', 'C3', '0'),
  ('D',   'members', 'O3', '1'), ('D', 'profile', 'D', '1'),
  ('D',   'member',  'O3', 'false'), ('D', 'admin', 'O3', 'false'), ('D', 'upd', 'O3', '0'),
  -- DS and DAN: an active super owner and an active data analyst of the
  -- deleted organisation; is_org_super_owner and is_org_data_analyst answer
  -- false there as the other two helpers do
  ('DS',  'org',     'O3', '0'), ('DS', 'sub', 'O3', '0'), ('DS', 'course', 'O3', '0'), ('DS', 'members', 'O3', '1'),
  ('DS',  'member',  'O3', 'false'), ('DS', 'admin', 'O3', 'false'), ('DS', 'super', 'O3', 'false'), ('DS', 'upd', 'O3', '0'),
  ('DAN', 'org',     'O3', '0'), ('DAN', 'course', 'O3', '0'), ('DAN', 'members', 'O3', '1'),
  ('DAN', 'member',  'O3', 'false'), ('DAN', 'analyst', 'O3', 'false'),
  -- S: an active administrator of an organisation scheduled for deletion,
  -- which stays open until deleted_at is set
  ('S',   'org',     'O4', '1'), ('S', 'sub', 'O4', '1'), ('S', 'course', 'O4', '1'), ('S', 'pkg', 'C4', '1'),
  ('S',   'members', 'O4', '1'), ('S', 'member', 'O4', 'true'), ('S', 'admin', 'O4', 'true'), ('S', 'upd', 'O4', '1');

do $assert$
declare
  ids jsonb := '{
    "A": "00000000-0115-4000-8000-000000000001", "L": "00000000-0115-4000-8000-000000000002",
    "IL": "00000000-0115-4000-8000-000000000003", "SL": "00000000-0115-4000-8000-000000000004",
    "IA": "00000000-0115-4000-8000-000000000005", "SS": "00000000-0115-4000-8000-000000000006",
    "SO": "00000000-0115-4000-8000-000000000007", "AN": "00000000-0115-4000-8000-000000000008",
    "IAN": "00000000-0115-4000-8000-000000000009", "X": "00000000-0115-4000-8000-000000000010",
    "Y": "00000000-0115-4000-8000-000000000011", "D": "00000000-0115-4000-8000-000000000012",
    "S": "00000000-0115-4000-8000-000000000013", "DS": "00000000-0115-4000-8000-000000000014",
    "DAN": "00000000-0115-4000-8000-000000000015",
    "O1": "00000000-0115-4000-8000-0000000000f1", "O2": "00000000-0115-4000-8000-0000000000f2",
    "O3": "00000000-0115-4000-8000-0000000000f3", "O4": "00000000-0115-4000-8000-0000000000f4",
    "C1": "00000000-0115-4000-8000-0000000000c1", "C2": "00000000-0115-4000-8000-0000000000c2",
    "C3": "00000000-0115-4000-8000-0000000000c3", "C4": "00000000-0115-4000-8000-0000000000c4"}';
  bad   text[] := '{}';
  r     record;
  v_me  text := current_user;
  v_t   text;
  v_sql text;
  got   text;
  n     integer := 0;
begin
  -- (1) the four helpers
  for r in
    select h.fn, h.md5_0115, p.prolang, p.provolatile, p.prosecdef, p.proconfig, p.proargnames, p.prorettype, p.prosrc
    from (values ('is_org_member',       'e294cd64bba69115cc0b9d6d999e0028'),
                 ('is_org_admin',        'f4804ccefbe6dc8bccf8df37bd91014e'),
                 ('is_org_super_owner',  'ab785236a3fce63866cca94fae265370'),
                 ('is_org_data_analyst', '6b954045ccb6524c279a1be15c507d1e')) as h(fn, md5_0115)
    left join pg_proc p on p.oid = to_regprocedure('public.' || h.fn || '(uuid)')
  loop
    if r.prosrc is null then
      bad := bad || format('(1) %s(uuid) is missing', r.fn);
      continue;
    end if;
    if r.prolang <> (select oid from pg_language where lanname = 'sql') or r.provolatile <> 's' or not r.prosecdef
       or r.proconfig is distinct from array['search_path=pg_catalog, public'] or r.proargnames is distinct from array['org_id']
       or r.prorettype <> 'boolean'::regtype then
      bad := bad || format('(1) %s attributes: language %s, volatility %s, security definer %s, config %s, argument %s',
                           r.fn, r.prolang, r.provolatile, r.prosecdef, r.proconfig, r.proargnames);
    end if;
    if md5(btrim(regexp_replace(lower(r.prosrc), '\s+', ' ', 'g'))) <> r.md5_0115 then
      bad := bad || format('(1) %s body is not the body 0115 writes', r.fn);
    end if;
  end loop;

  -- (2) execute on each helper for the three Data API roles
  for r in
    select h.fn, x.rol
    from (values ('is_org_member'), ('is_org_admin'), ('is_org_super_owner'), ('is_org_data_analyst')) as h(fn)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as x(rol)
    where to_regprocedure('public.' || h.fn || '(uuid)') is not null
  loop
    if not has_function_privilege(r.rol, to_regprocedure('public.' || r.fn || '(uuid)'), 'execute') then
      bad := bad || format('(2) %s cannot execute %s(uuid)', r.rol, r.fn);
    end if;
  end loop;

  -- (3) the seven policies and the two on organization_members
  for r in
    select x.tbl, x.name, x.cmd, x.roles, x.md5_want, p.polcmd::text as got_cmd,
           (select string_agg(q.rn, ',' order by q.rn)
              from (select case when y = 0 then 'public' else pg_get_userbyid(y)::text end as rn
                      from unnest(p.polroles) y) q) as got_roles,
           md5(btrim(regexp_replace(lower(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' | ' ||
                                          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')), '\s+', ' ', 'g'))) as got_md5
    from (values
      ('organizations',        'members can read their orgs',         'r', 'public',        'a1cedd889e717e9c4b8f383c054af5b0'),
      ('organizations',        'owners and admins can update orgs',   'w', 'public',        '039df1f296181e75be331dfa44e9e3e4'),
      ('tenant_subscriptions', 'tenant admins read own subscription', 'r', 'authenticated', 'fa0272ad26a535ca95226b5a1136e80e'),
      ('profiles',             'users read profiles in shared orgs',  'r', 'authenticated', 'd4fc137aa600479a12e8a1984a2f4afb'),
      ('course_packages',      'org members read packages',           'r', 'authenticated', '9c60cb44cff5a225173656226544bb6d'),
      ('course_packages',      'org admins write packages',           '*', 'authenticated', 'c812f61eb213ae814d303c26d4d32c7e'),
      ('course_ratings',       'org admins read all ratings',         'r', 'authenticated', '81a9c06023219ac7bd27428d4ab5bbe5'),
      ('organization_members', 'members can read own memberships',    'r', 'public',        '153ad695b1ce1787370c0be009eda7e4'),
      ('organization_members', 'admins read org memberships',         'r', 'public',        '873efa157f721135f8faa51a8f534343')
    ) as x(tbl, name, cmd, roles, md5_want)
    left join pg_policy p on p.polrelid = to_regclass('public.' || x.tbl) and p.polname = x.name
  loop
    if r.got_cmd is null then
      bad := bad || format('(3) policy "%s" on public.%s is missing', r.name, r.tbl);
    elsif r.got_cmd <> r.cmd or r.got_roles <> r.roles then
      bad := bad || format('(3) policy "%s" on public.%s: command %s roles %s (expected %s %s)',
                           r.name, r.tbl, r.got_cmd, r.got_roles, r.cmd, r.roles);
    elsif r.got_md5 <> r.md5_want then
      bad := bad || format('(3) policy "%s" on public.%s is not the text 0115 writes', r.name, r.tbl);
    end if;
  end loop;
  if to_regclass('pg_temp.adr0030_0115_before') is not null then
    bad := bad || '(3) the before-check''s temporary table outlived the paste'::text;
  end if;

  -- (4) each person's session; every case in a block that is rolled back
  for r in select * from assert_0115_case loop
    v_t := ids ->> r.target;
    v_sql := case r.what
      when 'org'     then format('select count(*)::text from public.organizations where id = %L', v_t)
      when 'sub'     then format('select count(*)::text from public.tenant_subscriptions where organization_id = %L', v_t)
      when 'course'  then format('select count(*)::text from public.courses where organization_id = %L', v_t)
      when 'pkg'     then format('select count(*)::text from public.course_packages where course_id = %L', v_t)
      when 'rate'    then format('select count(*)::text from public.course_ratings where course_id = %L', v_t)
      when 'members' then format('select count(*)::text from public.organization_members where organization_id = %L', v_t)
      when 'profile' then format('select count(*)::text from public.profiles where id = %L', v_t)
      when 'member'  then format('select public.is_org_member(%L)::text', v_t)
      when 'admin'   then format('select public.is_org_admin(%L)::text', v_t)
      when 'super'   then format('select public.is_org_super_owner(%L)::text', v_t)
      when 'analyst' then format('select public.is_org_data_analyst(%L)::text', v_t)
      when 'upd'     then format('with u as (update public.organizations set name = name where id = %L returning 1) '
                                 'select count(*)::text from u', v_t)
      when 'softdel' then format('with u as (update public.organizations set deleted_at = now() where id = %L returning 1) '
                                 'select count(*)::text from u', v_t)
      when 'pkgupd'  then format('with u as (update public.course_packages set display_name = display_name '
                                 'where course_id = %L returning 1) select count(*)::text from u', v_t)
      when 'pkgins'  then format('with i as (insert into public.course_packages (course_id, language, is_active) '
                                 'values (%L, ''zz'', false) returning 1) select count(*)::text from i', v_t)
    end;
    if v_sql is null then
      bad := bad || format('(4) unknown case %s', r.what);
      continue;
    end if;
    got := null;
    begin
      perform set_config('request.jwt.claims',
                         json_build_object('sub', ids ->> r.who, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin
        execute v_sql into got;
      exception when others then
        got := 'error ' || sqlstate;
      end;
      raise exception 'assert-0115 undo';
    exception when raise_exception then
      if sqlerrm <> 'assert-0115 undo' then
        got := 'error ' || sqlstate;
      end if;
    end;
    if current_user <> v_me then
      bad := bad || format('(4) the role was not restored after %s %s %s', r.who, r.what, r.target);
      execute format('set local role %I', v_me);
    end if;
    n := n + 1;
    if got is distinct from r.want then
      bad := bad || format('(4) %s %s %s answered %s, expected %s', r.who, r.what, r.target, coalesce(got, 'null'), r.want);
    end if;
  end loop;
  if n < 100 then
    bad := bad || format('(4) only %s cases ran', n);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0115 failed: %', array_to_string(bad, '; ');
  end if;
  raise notice 'assert-0115: % session cases held', n;
end
$assert$;

rollback;
