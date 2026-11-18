-- scripts/migration-rehearsal/assert-0115-hand-made.sql
-- Scenarios 0115-hand-made and 0115-hand-made-at-0104 (ADR 0030, note
-- "Hand-made databases, 2026-11-18"), after each paste of 0115 on the
-- hand-made baseline of plant-0115-hand-made.sql. assert-0115.sql, unchanged,
-- reads the same database as a repository database; this file reads what
-- section 0d did:
--   (1) no policy carries either alias name, in any schema;
--   (2) the repository names carry the command, the permissive mode and the
--       roles the aliases had (select, permissive, public), and the own-row
--       expression is the repository's spelling, (user_id = auth.uid());
--   (3) public.enrollments: "admins_view_org_enrollments" is gone, on every
--       table; the table's rows (its six ids), its grants (select for anon,
--       authenticated and service_role, and no write for the first two), its
--       row security (on, not forced) and its other policy (the own-row one,
--       as planted) are as before;
--   (4) sessions, beside the control: the active administrator reads their
--       organisation and their own member row; the inactive learner and the
--       inactive administrator read no organisation and still their own
--       member row (decision 5); every administrator reads public.enrollments
--       only through the own-row policy; anon reads none of it; the service
--       role reads all of it.
-- One transaction that ends in ROLLBACK; each session case runs in a block
-- that is rolled back. A failure raises "assert-0115-hand-made failed:".
begin;

create temporary table assert_0115_hm_case (who text, what text, target text, want text) on commit drop;
insert into assert_0115_hm_case (who, what, target, want) values
  -- the control: the active administrator of O1
  ('A',  'org', 'O1', '1'), ('A',  'ownrow', 'O1', '1'), ('A',  'enr', 'O1', '1'), ('A', 'enr', 'O2', '0'),
  -- an active learner of O1
  ('L',  'org', 'O1', '1'), ('L',  'ownrow', 'O1', '1'), ('L',  'enr', 'O1', '1'),
  -- the inactive learner: their own member row and their own enrollment only
  ('IL', 'org', 'O1', '0'), ('IL', 'ownrow', 'O1', '1'), ('IL', 'enr', 'O1', '1'),
  -- the inactive administrator: the same
  ('IA', 'org', 'O1', '0'), ('IA', 'ownrow', 'O1', '1'), ('IA', 'enr', 'O1', '1'),
  -- Y, the active administrator of O2
  ('Y',  'org', 'O2', '1'), ('Y',  'ownrow', 'O2', '1'), ('Y',  'enr', 'O2', '1'), ('Y', 'enr', 'O1', '0'),
  -- the active administrator of the deleted organisation
  ('D',  'org', 'O3', '0'), ('D',  'ownrow', 'O3', '1'), ('D',  'enr', 'O3', '1'),
  -- anon and the service role
  ('anon',    'enrall', '-', '0'),
  ('service', 'enrall', '-', '6');

do $assert$
declare
  ids jsonb := '{
    "A": "00000000-0115-4000-8000-000000000001", "L": "00000000-0115-4000-8000-000000000002",
    "IL": "00000000-0115-4000-8000-000000000003", "IA": "00000000-0115-4000-8000-000000000005",
    "Y": "00000000-0115-4000-8000-000000000011", "D": "00000000-0115-4000-8000-000000000012",
    "O1": "00000000-0115-4000-8000-0000000000f1", "O2": "00000000-0115-4000-8000-0000000000f2",
    "O3": "00000000-0115-4000-8000-0000000000f3"}';
  bad    text[] := '{}';
  r      record;
  v_me   text := current_user;
  v_role text;
  v_sql  text;
  got    text;
  n      integer := 0;
begin
  -- (1) no alias name is left
  for r in
    select n.nspname, c.relname, p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where p.polname in ('members_view_their_orgs', 'View own membership')
  loop
    bad := bad || format('(1) policy "%s" on %s.%s still carries an alias name', r.polname, r.nspname, r.relname);
  end loop;

  -- (2) the repository names, with the aliases' command, mode and roles
  for r in
    select x.tbl, x.name, x.qual_want, p.polcmd::text as cmd, p.polpermissive as perm,
           (select string_agg(case when y = 0 then 'public' else pg_get_userbyid(y)::text end, ',' order by 1)
              from unnest(p.polroles) y) as roles,
           pg_get_expr(p.polqual, p.polrelid) as qual, p.polwithcheck
    from (values ('organizations',        'members can read their orgs',      null),
                 ('organization_members', 'members can read own memberships', '(user_id = auth.uid())')) as x(tbl, name, qual_want)
    left join pg_policy p on p.polrelid = to_regclass('public.' || x.tbl) and p.polname = x.name
  loop
    if r.cmd is null then
      bad := bad || format('(2) policy "%s" on public.%s is missing', r.name, r.tbl);
    elsif r.cmd <> 'r' or not r.perm or r.roles <> 'public' or r.polwithcheck is not null then
      bad := bad || format('(2) policy "%s" on public.%s: command %s, permissive %s, roles %s (expected r, true, public)',
                           r.name, r.tbl, r.cmd, r.perm, r.roles);
    elsif r.qual_want is not null and r.qual is distinct from r.qual_want then
      bad := bad || format('(2) policy "%s" on public.%s reads %s, not %s', r.name, r.tbl, r.qual, r.qual_want);
    end if;
  end loop;

  -- (3) public.enrollments
  if exists (select 1 from pg_policy where polname = 'admins_view_org_enrollments') then
    bad := bad || '(3) a policy "admins_view_org_enrollments" is still there'::text;
  end if;
  if (select array_agg(p.polname::text || ' ' || p.polcmd::text || ' ' || p.polpermissive::text || ' ' ||
                       coalesce(pg_get_expr(p.polqual, p.polrelid), '') order by p.polname)
        from pg_policy p where p.polrelid = 'public.enrollments'::regclass)
     is distinct from array['users view own enrollments r true (user_id = auth.uid())'] then
    bad := bad || '(3) the policies of public.enrollments are not its own-row policy alone'::text;
  end if;
  if (select array_agg(id::text order by id) from public.enrollments) is distinct from array[
        '00000000-0115-4000-8000-0000000000a1', '00000000-0115-4000-8000-0000000000a2', '00000000-0115-4000-8000-0000000000a3',
        '00000000-0115-4000-8000-0000000000a4', '00000000-0115-4000-8000-0000000000a5', '00000000-0115-4000-8000-0000000000a6'] then
    bad := bad || '(3) the rows of public.enrollments changed'::text;
  end if;
  if not (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.enrollments'::regclass) then
    bad := bad || '(3) row security of public.enrollments is not as planted (on, not forced)'::text;
  end if;
  for r in
    select x.rol, x.priv, x.want
    from (values ('anon', 'select', true), ('authenticated', 'select', true), ('service_role', 'select', true),
                 ('anon', 'insert', false), ('anon', 'update', false), ('anon', 'delete', false),
                 ('authenticated', 'insert', false), ('authenticated', 'update', false), ('authenticated', 'delete', false)) as x(rol, priv, want)
  loop
    if has_table_privilege(r.rol, 'public.enrollments', r.priv) <> r.want then
      bad := bad || format('(3) %s %s on public.enrollments is %s, not as planted', r.rol, r.priv, not r.want);
    end if;
  end loop;

  -- (4) each person's session; every case in a block that is rolled back
  for r in select * from assert_0115_hm_case loop
    v_sql := case r.what
      when 'org'    then format('select count(*)::text from public.organizations where id = %L', ids ->> r.target)
      when 'ownrow' then format('select count(*)::text from public.organization_members where organization_id = %L and user_id = %L',
                                ids ->> r.target, ids ->> r.who)
      when 'enr'    then format('select count(*)::text from public.enrollments where organization_id = %L', ids ->> r.target)
      when 'enrall' then 'select count(*)::text from public.enrollments'
    end;
    v_role := case r.who when 'anon' then 'anon' when 'service' then 'service_role' else 'authenticated' end;
    got := null;
    begin
      perform set_config('request.jwt.claims',
                         case when ids ? r.who then json_build_object('sub', ids ->> r.who, 'role', v_role)
                              else json_build_object('role', v_role) end::text, true);
      execute format('set local role %I', v_role);
      begin
        execute v_sql into got;
      exception when others then
        got := 'error ' || sqlstate;
      end;
      raise exception 'assert-0115-hand-made undo';
    exception when raise_exception then
      if sqlerrm <> 'assert-0115-hand-made undo' then
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

  if cardinality(bad) > 0 then
    raise exception 'assert-0115-hand-made failed: %', array_to_string(bad, '; ');
  end if;
  raise notice 'assert-0115: hand-made, % session cases held', n;
end
$assert$;

rollback;
