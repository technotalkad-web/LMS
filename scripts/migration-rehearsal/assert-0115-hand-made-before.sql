-- scripts/migration-rehearsal/assert-0115-hand-made-before.sql
-- Scenarios 0115-hand-made and 0115-hand-made-at-0104 (ADR 0030, note
-- "Hand-made databases, 2026-11-18"), on the hand-made baseline of
-- plant-0115-hand-made.sql, before 0115: the stand-in is what it claims to
-- be, so that assert-0115-hand-made.sql reads a change and not a planting
-- mistake.
--   (1) the two aliases are there, each a permissive policy for select to
--       public, and the repository names are absent on their tables;
--   (2) public.enrollments has row security on and its two policies;
--   (3) sessions under the old rule: a membership row of any status counts
--       (the inactive learner and the inactive administrator read their
--       organisation, the deleted organisation's administrator reads it);
--       every administrator, active or not, reads all of their
--       organisation's enrollments through "admins_view_org_enrollments",
--       a learner only their own; anon reads none; the service role reads
--       all six.
-- One transaction that ends in ROLLBACK; each session case runs in a block
-- that is rolled back. A failure raises "assert-0115-hand-made-before failed:".
begin;

create temporary table assert_0115_hmb_case (who text, what text, target text, want text) on commit drop;
insert into assert_0115_hmb_case (who, what, target, want) values
  ('A',  'org', 'O1', '1'), ('A',  'ownrow', 'O1', '1'), ('A',  'enr', 'O1', '4'), ('A', 'enr', 'O2', '0'),
  ('L',  'org', 'O1', '1'), ('L',  'ownrow', 'O1', '1'), ('L',  'enr', 'O1', '1'),
  ('IL', 'org', 'O1', '1'), ('IL', 'ownrow', 'O1', '1'), ('IL', 'enr', 'O1', '1'),
  ('IA', 'org', 'O1', '1'), ('IA', 'ownrow', 'O1', '1'), ('IA', 'enr', 'O1', '4'),
  ('Y',  'org', 'O2', '1'), ('Y',  'ownrow', 'O2', '1'), ('Y',  'enr', 'O2', '1'), ('Y', 'enr', 'O1', '0'),
  ('D',  'org', 'O3', '1'), ('D',  'ownrow', 'O3', '1'), ('D',  'enr', 'O3', '1'),
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
  -- (1) the aliases, and no repository name beside them
  for r in
    select x.tbl, x.alias, x.name, p.polcmd::text as cmd, p.polpermissive as perm,
           (select string_agg(case when y = 0 then 'public' else pg_get_userbyid(y)::text end, ',' order by 1)
              from unnest(p.polroles) y) as roles,
           exists (select 1 from pg_policy q where q.polrelid = to_regclass('public.' || x.tbl) and q.polname = x.name) as repo_there
    from (values ('organizations',        'members_view_their_orgs', 'members can read their orgs'),
                 ('organization_members', 'View own membership',     'members can read own memberships')) as x(tbl, alias, name)
    left join pg_policy p on p.polrelid = to_regclass('public.' || x.tbl) and p.polname = x.alias
  loop
    if r.cmd is null or r.cmd <> 'r' or not r.perm or r.roles <> 'public' then
      bad := bad || format('(1) the alias "%s" on public.%s is not a permissive policy for select to public', r.alias, r.tbl);
    end if;
    if r.repo_there then
      bad := bad || format('(1) "%s" is there beside its alias on public.%s', r.name, r.tbl);
    end if;
  end loop;

  -- (2) public.enrollments as planted
  if not coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.enrollments')), false) then
    bad := bad || '(2) public.enrollments is missing or its row security is off'::text;
  elsif (select array_agg(polname::text order by polname) from pg_policy where polrelid = 'public.enrollments'::regclass)
        is distinct from array['admins_view_org_enrollments', 'users view own enrollments'] then
    bad := bad || '(2) public.enrollments does not hold its two policies'::text;
  end if;

  -- (3) each person's session; every case in a block that is rolled back
  for r in select * from assert_0115_hmb_case loop
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
      raise exception 'assert-0115-hand-made-before undo';
    exception when raise_exception then
      if sqlerrm <> 'assert-0115-hand-made-before undo' then
        got := 'error ' || sqlstate;
      end if;
    end;
    if current_user <> v_me then
      bad := bad || format('(3) the role was not restored after %s %s %s', r.who, r.what, r.target);
      execute format('set local role %I', v_me);
    end if;
    n := n + 1;
    if got is distinct from r.want then
      bad := bad || format('(3) %s %s %s answered %s, expected %s', r.who, r.what, r.target, coalesce(got, 'null'), r.want);
    end if;
  end loop;

  if cardinality(bad) > 0 then
    raise exception 'assert-0115-hand-made-before failed: %', array_to_string(bad, '; ');
  end if;
  raise notice 'assert-0115: hand-made baseline, % session cases held', n;
end
$assert$;

rollback;
