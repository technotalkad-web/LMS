-- scripts/migration-rehearsal/assert-0115-reverse.sql
-- The 0115 scenarios, after ops/0115-reverse.sql (ADR 0030 section C point
-- 9), on the rows of seed-0115.sql: the old rule is back.
--   (1) the four helpers hold the bodies of 0002, 0056, 0055 and 0010
--       (md5 of the text in lower case with its white space collapsed, as
--       0115's before-check compares them), with search_path public, and
--       the three Data API roles still execute them;
--   (2) the seven policies hold the expressions of 0001, 0019, 0026, 0027,
--       0030 and 0031, with their commands and roles;
--   (3) sessions: a row of any status counts again (the inactive learner
--       and the inactive administrator read O1, the administrator of the
--       deleted organisation reads it), beside the control (the active
--       administrator reads O1).
-- The scenarios also compare schema public with its fingerprint from before
-- 0115. One transaction that ends in ROLLBACK.
begin;

do $assert$
declare
  bad  text[] := '{}';
  r    record;
  v_me text := current_user;
  got  text;
begin
  for r in
    select h.fn, h.md5_repo, p.prosrc, p.proconfig
    from (values ('is_org_member',       'b1bfa9ecf05c64f07c58dfcd68949d4c'),
                 ('is_org_admin',        '2fe3b5a93df173449052a6063e5773bb'),
                 ('is_org_super_owner',  'd1468d0fba3b44da11dad2ccf9fbdc8a'),
                 ('is_org_data_analyst', '2fb9d680feceb714468cdcb79b75238e')) as h(fn, md5_repo)
    left join pg_proc p on p.oid = to_regprocedure('public.' || h.fn || '(uuid)')
  loop
    if r.prosrc is null then
      bad := bad || format('(1) %s(uuid) is missing', r.fn);
    elsif md5(btrim(regexp_replace(lower(r.prosrc), '\s+', ' ', 'g'))) <> r.md5_repo
          or r.proconfig is distinct from array['search_path=public'] then
      bad := bad || format('(1) %s is not the repository''s body before 0115', r.fn);
    elsif exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) as x(rol)
                   where not has_function_privilege(x.rol, to_regprocedure('public.' || r.fn || '(uuid)'), 'execute')) then
      bad := bad || format('(1) %s lost execute for a Data API role', r.fn);
    end if;
  end loop;

  for r in
    select x.tbl, x.name, x.md5_repo,
           md5(btrim(regexp_replace(lower(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' | ' ||
                                          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')), '\s+', ' ', 'g'))) as got_md5
    from (values
      ('organizations',        'members can read their orgs',         '091a0d9cc756b601fa447c813a420e35'),
      ('organizations',        'owners and admins can update orgs',   '86c25ccc1b8aa17428f20b4bdf825c41'),
      ('tenant_subscriptions', 'tenant admins read own subscription', 'b5a52832dbf5f3f8c1010922cc0016f9'),
      ('profiles',             'users read profiles in shared orgs',  '348201839f56254c9807114cb2b1eb70'),
      ('course_packages',      'org members read packages',           '0c3b966735367f545bdbe7191ab6c96d'),
      ('course_packages',      'org admins write packages',           'c9aab67fc3302cefbd6800d995c79a77'),
      ('course_ratings',       'org admins read all ratings',         '82b28c6d7dee9e0458d8de52312beba4')
    ) as x(tbl, name, md5_repo)
    left join pg_policy p on p.polrelid = to_regclass('public.' || x.tbl) and p.polname = x.name
  loop
    if r.got_md5 is distinct from r.md5_repo then
      bad := bad || format('(2) policy "%s" on public.%s is not the repository''s text before 0115', r.name, r.tbl);
    end if;
  end loop;

  for r in
    select * from (values
      ('00000000-0115-4000-8000-000000000001', '00000000-0115-4000-8000-0000000000f1', 'the control'),
      ('00000000-0115-4000-8000-000000000003', '00000000-0115-4000-8000-0000000000f1', 'the inactive learner'),
      ('00000000-0115-4000-8000-000000000005', '00000000-0115-4000-8000-0000000000f1', 'the inactive administrator'),
      ('00000000-0115-4000-8000-000000000012', '00000000-0115-4000-8000-0000000000f3', 'the deleted organisation''s administrator')
    ) as t(who, org, label)
  loop
    got := null;
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin
        execute format('select count(*)::text || '' '' || public.is_org_member(%L)::text from public.organizations where id = %L',
                       r.org, r.org) into got;
      exception when others then
        got := 'error ' || sqlstate;
      end;
      raise exception 'assert-0115-reverse undo';
    exception when raise_exception then
      if sqlerrm <> 'assert-0115-reverse undo' then
        got := 'error ' || sqlstate;
      end if;
    end;
    if current_user <> v_me then
      execute format('set local role %I', v_me);
      bad := bad || '(3) the role was not restored'::text;
    end if;
    if got is distinct from '1 true' then
      bad := bad || format('(3) %s answered %s, expected 1 true (the old rule)', r.label, coalesce(got, 'null'));
    end if;
  end loop;

  if cardinality(bad) > 0 then
    raise exception 'assert-0115-reverse failed: %', array_to_string(bad, '; ');
  end if;
end
$assert$;

rollback;
