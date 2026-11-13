-- scripts/migration-rehearsal/fingerprint.sql
-- The catalog fingerprint of schema public that the runner's `fingerprint`
-- step takes and compares (added for ADR 0024 step 61, the 0107 reverse
-- script, and step 63's rehearsal of it). One read-only select: one row per
-- object, (k, v), k the object's kind and name, v everything about it that a
-- migration can set. Kept in the runner's memory for the scenario, never in
-- the database. Not covered: rows, matview contents, sequence values, OIDs.
--   rel   every relation: kind, row-level security on and forced, options,
--         persistence, comment
--   col   every live column (dropped ones skipped): its rank among the live
--         columns, type, not null, default or generated expression,
--         identity, comment
--   con   every constraint of a public table: its definition, deferrable,
--         deferred, validated
--   idx   every index: its definition
--   trg   every user trigger on a public table: its definition and enabled
--   pol   every policy: command, permissive, roles, using, with check
--   view  every view and materialized view: its definition
--   fn    every function and procedure: its whole definition and comment,
--         carriage returns dropped (a Windows checkout gives the older
--         migration files CRLF line endings, which a function body keeps;
--         the repository stores LF)
--   acl, acl-col, acl-fn  every relation, column and function privilege,
--         read from the catalog ACL (a null ACL read as its default; a column
--         listed only when it holds a privilege of its own), grantor left out
--   type  every enum of public: its labels in order
with rels as (
  select c.oid, c.relname, c.relkind, c.relowner, c.relacl
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
)
select k, v from (
  select 'rel:' || r.relname as k,
         concat_ws(' | ', r.relkind::text, c.relrowsecurity::text, c.relforcerowsecurity::text,
                   coalesce(array_to_string(c.reloptions, ','), ''), c.relpersistence::text,
                   coalesce(obj_description(r.oid, 'pg_class'), '')) as v
  from rels r join pg_class c on c.oid = r.oid
  union all
  select 'col:' || r.relname || '.' || a.attname,
         concat_ws(' | ',
                   (row_number() over (partition by r.oid order by a.attnum))::text,
                   format_type(a.atttypid, a.atttypmod), a.attnotnull::text,
                   coalesce(pg_get_expr(d.adbin, d.adrelid), ''), a.attgenerated::text, a.attidentity::text,
                   coalesce(col_description(r.oid, a.attnum), ''))
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where r.relkind in ('r', 'p', 'v', 'm', 'f')
  union all
  select 'con:' || r.relname || '.' || co.conname,
         concat_ws(' | ', pg_get_constraintdef(co.oid, true), co.condeferrable::text,
                   co.condeferred::text, co.convalidated::text)
  from rels r join pg_constraint co on co.conrelid = r.oid
  union all
  select 'idx:' || r.relname, pg_get_indexdef(r.oid)
  from rels r where r.relkind in ('i', 'I')
  union all
  select 'trg:' || r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid, true) || ' | ' || t.tgenabled::text
  from rels r join pg_trigger t on t.tgrelid = r.oid and not t.tgisinternal
  union all
  select 'pol:' || r.relname || '.' || p.polname,
         concat_ws(' | ', p.polcmd::text, p.polpermissive::text,
                   (select string_agg(case when x = 0 then 'public' else pg_get_userbyid(x) end, ',' order by 1)
                      from unnest(p.polroles) x),
                   coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                   coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
  from rels r join pg_policy p on p.polrelid = r.oid
  union all
  select 'view:' || r.relname, pg_get_viewdef(r.oid, true)
  from rels r where r.relkind in ('v', 'm')
  union all
  select 'fn:' || p.oid::regprocedure::text,
         replace(pg_get_functiondef(p.oid) || ' | ' || coalesce(obj_description(p.oid, 'pg_proc'), ''), chr(13), '')
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
  union all
  select 'acl:' || r.relname,
         coalesce((select string_agg(case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee) end
                                     || '=' || e.privilege_type || case when e.is_grantable then '*' else '' end,
                                     ',' order by 1)
                     from aclexplode(coalesce(r.relacl,
                            acldefault(case when r.relkind = 'S' then 's'::"char" else 'r'::"char" end,
                                       r.relowner))) e), '')
  from rels r where r.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  union all
  select 'acl-col:' || r.relname || '.' || a.attname,
         (select string_agg(case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee) end
                            || '=' || e.privilege_type || case when e.is_grantable then '*' else '' end,
                            ',' order by 1)
            from aclexplode(a.attacl) e)
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
  union all
  select 'acl-fn:' || p.oid::regprocedure::text,
         coalesce((select string_agg(case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee) end
                                     || '=' || e.privilege_type || case when e.is_grantable then '*' else '' end,
                                     ',' order by 1)
                     from aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) e), '')
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
  union all
  select 'type:' || t.typname,
         (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
  from pg_type t
  where t.typnamespace = 'public'::regnamespace and t.typtype = 'e'
) f
order by k;
