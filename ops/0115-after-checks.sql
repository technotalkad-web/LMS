-- ops/0115-after-checks.sql — the after-checks A1 to A5 of
-- 0115_membership_status_enforced.sql (ADR 0030 section C point 7), to run
-- alone at any time. READ-ONLY: catalog reads and one member's session; one
-- transaction that ends in rollback. Paste it whole in the SQL editor with
-- the role selector on postgres. Never the Supabase CLI (the CLI is linked
-- to production).
--
-- WHEN (the never-paste rule of docs/MIGRATIONS.md): after the paste of
-- 0115, after every sitting that pastes a migration, whatever its number, after
-- the paste of 0110 (ADR 0026) whichever of the two came second, and
-- whenever the owner wants to know that the rule still holds.
--
-- ANSWER: success ("Success. No rows returned" in the SQL editor; "DO" and
-- "ROLLBACK" in psql) means every check held. A failure
-- raises "0115 after-check failed:" and names each object that breaks the
-- rule; nothing was changed either way. A helper or one of the seven
-- policies without the rule means an older file was pasted again: paste
-- 0115 again, then this file. A policy, function or view reported as
-- outside the expected sets goes to the owner (0115's header, B4a to B4d).
--
-- A1 and A2 test that the rule's words are there, not that the text is
-- 0115's (a later file may restate a helper with the rule). To compare the
-- exact text, run 0115's before-check select (its section 0b) as well: B2
-- and B3 print "as 0115" for each helper and policy that holds 0115's text,
-- and print the stored text where it differs.
--
-- The block between the two marker lines is, character for character, the
-- block of section 4 of 0115 (tests/unit/membership-rule-migrations.test.ts
-- holds the two equal).

begin;

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

rollback;
