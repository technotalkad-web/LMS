-- scripts/migration-rehearsal/assert-0107.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107" (after the
-- first paste and again after the second), "0107-refused-q8" and
-- "0107-refused-q2" (after the two pastes that follow the repair): what
-- 0107_learning_contexts.sql must have done, on the rows of seed-0107.sql.
-- This build covers sections 1 and 2 of the file (ADR 0024 section B,
-- creation order item 2 whole: the columns, their run-once backfills, the
-- generated columns, the CHECKs, preview_runs, context_derive_log, the
-- immutability and derive triggers, the two attempt foreign keys, the key
-- swaps and the indexes) and section 6's paste-window day_ids trigger on
-- journey_versions: checks (0) to (6) for section 1, (7) to (10) for the
-- rest; the rows (7) to (10) write have ids whose last group starts
-- 00010713. The checks of the later sections come with them. The whole file
-- is one transaction that ends in ROLLBACK, so nothing it writes reaches the
-- next step. Every check raises 'assert-0107: (n) …' on failure; the runner
-- then reports the file as failed and stops the scenario.
--
-- The checks of (3) and (4) are first-paste facts (ADR 0024 step 19: "the
-- after-checks that count backfilled rows apply to the first paste only").
-- They hold after the second paste too, because a later paste writes no row;
-- the rows seed-0107-repaste.sql writes between the pastes (ids whose last
-- group starts 000107120) are left out of them and are read by
-- assert-0107-repaste.sql.
--
-- PGlite runs as postgres, the owner of every table. grants-0107.sql gave
-- anon and authenticated usage on public and select on every table before
-- the paste (the project defaults), and authenticated insert, update and
-- delete on org_api_keys; the shim sets no default privileges, so preview_runs
-- holds exactly what 0107 grants.
begin;

-- ---------------------------------------------------------------------------
-- (0) the new columns: type, not null (pg_attribute.attnotnull, note N3),
--     generated (s = stored) and default
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  g   record;
begin
  for r in
    select * from (values
      ('course_attempts',           'context_kind',            'text',                     true,  '',  null),
      ('course_attempts',           'journey_day_id',          'uuid',                     false, '',  null),
      ('course_attempts',           'journey_version_id',      'uuid',                     false, '',  null),
      ('course_attempts',           'preview_kind',            'text',                     false, '',  null),
      ('course_attempts',           'preview_run_id',          'uuid',                     false, '',  null),
      ('course_attempts',           'context_key',             'text',                     false, 's', null),
      ('course_attempts',           'settle_sig',              'text',                     false, 's', null),
      ('course_attempts',           'side_effects_sig',        'text',                     false, '',  null),
      ('course_attempts',           'side_effects_at',         'timestamp with time zone', false, '',  null),
      ('course_attempts',           'webhook_skip_reason',     'text',                     false, '',  null),
      ('attempt_requests',          'context_kind',            'text',                     true,  '',  '''individual''::text'),
      ('attempt_requests',          'learning_path_id',        'uuid',                     false, '',  null),
      ('attempt_requests',          'journey_enrollment_id',   'uuid',                     false, '',  null),
      ('attempt_requests',          'journey_day',             'integer',                  false, '',  null),
      ('attempt_requests',          'journey_day_id',          'uuid',                     false, '',  null),
      ('attempt_requests',          'context_key',             'text',                     false, 's', null),
      ('revision_visits',           'context_key',             'text',                     true,  '',  '''individual''::text'),
      ('xp_events',                 'context_kind',            'text',                     false, '',  null),
      ('xp_events',                 'context_key',             'text',                     false, '',  null),
      ('xp_events',                 'event_only',              'boolean',                  true,  '',  'false'),
      ('learning_path_courses',     'pass_required',           'boolean',                  false, '',  null),
      ('journey_days',              'pass_required',           'boolean',                  false, '',  null),
      ('journey_days',              'removed_at',              'timestamp with time zone', false, '',  null),
      ('journey_days',              'day_number',              'integer',                  false, '',  null),
      ('journey_versions',          'day_ids',                 'jsonb',                    false, '',  null),
      ('journey_versions',          'day_ids_source',          'text',                     false, '',  null),
      ('journey_day_progress',      'day_id',                  'uuid',                     true,  '',  null),
      ('journey_day_progress',      'credit_kind',             'text',                     true,  '',  '''attempt''::text'),
      ('journey_day_progress',      'recorded_by',             'uuid',                     false, '',  null),
      ('journey_day_progress',      'late',                    'boolean',                  true,  '',  'false'),
      ('journey_enrollments',       'source',                  'text',                     true,  '',  '''admin''::text'),
      ('journey_programs',          'visibility',              'text',                     true,  '',  '''private''::text'),
      ('course_assignments',        'source',                  'text',                     true,  '',  '''admin''::text'),
      ('learning_path_assignments', 'source',                  'text',                     true,  '',  '''admin''::text'),
      ('org_api_keys',              'contract_version',        'smallint',                 true,  '',  '2'),
      ('org_api_keys',              'allow_contract_override', 'boolean',                  true,  '',  'false'),
      ('org_integration_settings',  'webhook_contexts',        'text',                     true,  '',  '''individual''::text'),
      ('preview_runs',              'id',                      'uuid',                     true,  '',  'gen_random_uuid()'),
      ('preview_runs',              'organization_id',         'uuid',                     true,  '',  null),
      ('preview_runs',              'user_id',                 'uuid',                     true,  '',  null),
      ('preview_runs',              'kind',                    'text',                     true,  '',  null),
      ('preview_runs',              'learning_path_id',        'uuid',                     false, '',  null),
      ('preview_runs',              'journey_program_id',      'uuid',                     false, '',  null),
      ('preview_runs',              'journey_version_id',      'uuid',                     false, '',  null),
      ('preview_runs',              'simulated_date',          'date',                     false, '',  null),
      ('preview_runs',              'created_at',              'timestamp with time zone', true,  '',  'now()'),
      ('preview_runs',              'done_activity_day_ids',   'uuid[]',                   true,  '',  '''{}''::uuid[]')
    ) as t(tbl, col, typ, not_null, gen, def)
  loop
    select format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as not_null, a.attgenerated::text as gen,
           case when a.attgenerated::text = '' then pg_get_expr(d.adbin, d.adrelid) end as def
      into g
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = ('public.' || r.tbl)::regclass and a.attname = r.col and not a.attisdropped;
    if not found then
      bad := bad || format('%s.%s is missing', r.tbl, r.col);
    elsif g.typ <> r.typ or g.not_null <> r.not_null or g.gen <> r.gen or g.def is distinct from r.def then
      bad := bad || format('%s.%s is %s%s%s default %s (expected %s%s%s default %s)', r.tbl, r.col,
                           g.typ, case when g.not_null then ' not null' else '' end,
                           case when g.gen = 's' then ' stored' else '' end, coalesce(g.def, 'none'),
                           r.typ, case when r.not_null then ' not null' else '' end,
                           case when r.gen = 's' then ' stored' else '' end, coalesce(r.def, 'none'));
    end if;
  end loop;
  if (select count(*) from pg_attribute
       where attrelid = 'public.preview_runs'::regclass and attnum > 0 and not attisdropped) <> 10 then
    bad := bad || 'preview_runs does not have exactly its ten columns'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (0) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (1) the new foreign keys (on delete, deferrable) and checks
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  fk  record;
begin
  for r in
    select * from (values
      ('course_attempts',      'journey_day_id',        'journey_days',        'a', false),
      ('course_attempts',      'journey_version_id',    'journey_versions',    'a', false),
      ('course_attempts',      'preview_run_id',        'preview_runs',        'a', false),
      -- re-created on delete no action (2d; set null before 0107)
      ('course_attempts',      'learning_path_id',      'learning_paths',      'a', false),
      ('course_attempts',      'journey_enrollment_id', 'journey_enrollments', 'a', false),
      ('attempt_requests',     'learning_path_id',      'learning_paths',      'a', false),
      ('attempt_requests',     'journey_enrollment_id', 'journey_enrollments', 'a', false),
      ('attempt_requests',     'journey_day_id',        'journey_days',        'a', false),
      ('journey_day_progress', 'day_id',                'journey_days',        'a', true),
      ('preview_runs',         'organization_id',       'organizations',       'c', false),
      ('preview_runs',         'learning_path_id',      'learning_paths',      'a', false),
      ('preview_runs',         'journey_program_id',    'journey_programs',    'a', false),
      ('preview_runs',         'journey_version_id',    'journey_versions',    'a', false)
    ) as t(tbl, col, parent, deltype, deferred)
  loop
    select k.confdeltype::text as deltype, k.condeferrable, k.condeferred, k.conname, count(*) over () as n
      into fk
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
     where k.contype = 'f'
       and k.conrelid = ('public.' || r.tbl)::regclass
       and k.confrelid = ('public.' || r.parent)::regclass
       and a.attname = r.col;
    if not found then
      bad := bad || format('no foreign key %s.%s to %s', r.tbl, r.col, r.parent);
    elsif fk.n <> 1 or fk.deltype <> r.deltype or fk.condeferrable <> r.deferred or fk.condeferred <> r.deferred then
      bad := bad || format('%s.%s to %s: %s key(s), on delete %s, deferrable %s, initially deferred %s',
                           r.tbl, r.col, r.parent, fk.n, fk.deltype, fk.condeferrable, fk.condeferred);
    end if;
  end loop;
  if (select conname from pg_constraint
       where conrelid = 'public.journey_day_progress'::regclass and contype = 'f'
         and confrelid = 'public.journey_days'::regclass) is distinct from 'journey_day_progress_day_id_fkey' then
    bad := bad || 'the journey_day_progress.day_id key is not named journey_day_progress_day_id_fkey'::text;
  end if;
  if not exists (
    select 1 from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
    where k.contype = 'f' and k.conrelid = 'public.preview_runs'::regclass
      and a.attname = 'user_id' and k.confdeltype = 'c'
  ) then
    bad := bad || 'preview_runs.user_id does not cascade'::text;
  end if;

  for r in
    select * from (values
      ('course_attempts',           'course_attempts_context_kind_check'),
      ('course_attempts',           'course_attempts_preview_kind_check'),
      ('course_attempts',           'course_attempts_context_shape_chk'),
      ('course_attempts',           'course_attempts_webhook_skip_reason_check'),
      ('attempt_requests',          'attempt_requests_context_kind_check'),
      ('attempt_requests',          'attempt_requests_context_shape_chk'),
      ('journey_days',              'journey_days_removed_no_number_check'),
      ('journey_versions',          'journey_versions_day_ids_source_check'),
      ('preview_runs',              'preview_runs_shape_chk'),
      ('journey_day_progress',      'journey_day_progress_credit_kind_check'),
      ('journey_enrollments',       'journey_enrollments_source_check'),
      ('journey_programs',          'journey_programs_visibility_check'),
      ('course_assignments',        'course_assignments_source_check'),
      ('learning_path_assignments', 'learning_path_assignments_source_check'),
      ('org_api_keys',              'org_api_keys_contract_version_check'),
      ('org_integration_settings',  'org_integration_settings_webhook_contexts_check')
    ) as t(tbl, name)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = ('public.' || r.tbl)::regclass and conname = r.name and contype = 'c' and convalidated
    ) then
      bad := bad || format('check %s on %s is missing or not validated', r.name, r.tbl);
    end if;
  end loop;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.notification_templates'::regclass
      and c.conname = 'notification_templates_event_type_check'
      and pg_get_constraintdef(c.oid) like '%''journey_completion''%'
      and pg_get_constraintdef(c.oid) like '%''journey_escalation''%'
      and pg_get_constraintdef(c.oid) like '%''account_creation''%'
  ) then
    bad := bad || 'notification_templates_event_type_check does not admit journey_completion beside the 0065 list'::text;
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'public.notification_templates'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%event_type%') <> 1 then
    bad := bad || 'notification_templates does not have exactly one event-type check'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (1) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) preview_runs: RLS with a no-access policy, the privilege matrix
--     (has_table_privilege per privilege, note N3) and its foreign-key indexes
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.preview_runs'::regclass) then
    bad := bad || 'preview_runs has row-level security off'::text;
  end if;
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.preview_runs'::regclass
      and polname = 'no direct access to preview_runs'
      and pg_get_expr(polqual, polrelid) = 'false'
      and pg_get_expr(polwithcheck, polrelid) = 'false'
  ) then
    bad := bad || 'preview_runs lacks its no-access policy'::text;
  end if;
  for r in
    select * from (values
      ('anon', 'select', false), ('anon', 'insert', false), ('anon', 'update', false), ('anon', 'delete', false),
      ('authenticated', 'select', false), ('authenticated', 'insert', false),
      ('authenticated', 'update', false), ('authenticated', 'delete', false),
      ('service_role', 'select', true), ('service_role', 'insert', true),
      ('service_role', 'update', true), ('service_role', 'delete', false),
      ('service_role', 'truncate', false)
    ) as t(role_name, priv, expected)
  loop
    if has_table_privilege(r.role_name, 'public.preview_runs', r.priv) <> r.expected then
      bad := bad || format('%s %s on preview_runs: %s (expected %s)', r.role_name, r.priv,
                           not r.expected, r.expected);
    end if;
  end loop;
  for r in
    select * from (values
      ('preview_runs_organization_idx',    'organization_id'),
      ('preview_runs_user_idx',            'user_id'),
      ('preview_runs_learning_path_idx',   'learning_path_id'),
      ('preview_runs_journey_program_idx', 'journey_program_id'),
      ('preview_runs_journey_version_idx', 'journey_version_id')
    ) as t(idx, col)
  loop
    if not exists (
      select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = 'public.preview_runs'::regclass and c.relname = r.idx and a.attname = r.col
    ) then
      bad := bad || format('index %s leading with %s is missing', r.idx, r.col);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (3) the backfills on the rows of seed-0107.sql, row by row
-- ---------------------------------------------------------------------------
do $$
declare
  bad   text[] := '{}';
  r     record;
  a     record;
  p1    constant text := 'path:00000000-0000-0000-0000-000107050001';
  p2    constant text := 'path:00000000-0000-0000-0000-000107050002';
  ej    constant text := 'journey:00000000-0000-0000-0000-000107063001:';
  d1    constant uuid := '00000000-0000-0000-0000-000107061001';
  d2    constant uuid := '00000000-0000-0000-0000-000107061002';
  d3    constant uuid := '00000000-0000-0000-0000-000107061003';
  d4    constant uuid := '00000000-0000-0000-0000-000107061004';
  d5    constant uuid := '00000000-0000-0000-0000-000107061005';
begin
  -- attempts: kind, key, preview kind, day id, the pre_0107 marker
  for r in
    select * from (values
      ('070001', 'individual', 'individual',   null::text,    null::uuid, 'pre_0107'),
      ('070002', 'individual', 'individual',   null,          null,       null),
      ('070003', 'individual', 'individual',   null,          null,       'pre_0107'),
      ('070004', 'path',       p1,             null,          null,       'pre_0107'),
      ('070005', 'path',       p1,             null,          null,       null),
      ('070006', 'individual', 'individual',   null,          null,       'pre_0107'),
      ('070007', 'individual', 'individual',   null,          null,       'pre_0107'),
      ('070008', 'path',       p1,             null,          null,       'pre_0107'),
      ('070009', 'path',       p1,             null,          null,       null),
      ('070010', 'individual', 'individual',   null,          null,       null),
      ('070011', 'journey',    ej || d1::text, null,          d1,         'pre_0107'),
      ('070012', 'journey',    ej || d2::text, null,          d2,         null),
      ('070013', 'path',       p2,             null,          null,       null),
      ('070014', 'preview',    'preview',      'legacy_role', null,       null),
      ('070015', 'preview',    'preview',      'legacy_role', null,       null),
      ('070016', 'preview',    'preview',      'legacy_role', null,       null),
      ('070017', 'preview',    'preview',      'legacy_role', null,       'pre_0107'),
      ('070018', 'individual', 'individual',   null,          null,       'pre_0107')
    ) as t(id, kind, ckey, pkind, day_id, marker)
  loop
    select * into a from public.course_attempts where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid;
    if not found then
      bad := bad || format('attempt %s is missing', r.id);
    elsif a.context_kind <> r.kind or a.context_key is distinct from r.ckey
          or a.preview_kind is distinct from r.pkind or a.journey_day_id is distinct from r.day_id
          or a.webhook_skip_reason is distinct from r.marker
          or a.journey_version_id is not null or a.preview_run_id is not null then
      bad := bad || format('attempt %s reads %s / %s / %s / %s / %s (expected %s / %s / %s / %s / %s)', r.id,
                           a.context_kind, coalesce(a.context_key, 'null'), coalesce(a.preview_kind, 'null'),
                           coalesce(a.journey_day_id::text, 'null'), coalesce(a.webhook_skip_reason, 'null'),
                           r.kind, r.ckey, coalesce(r.pkind, 'null'), coalesce(r.day_id::text, 'null'),
                           coalesce(r.marker, 'null'));
    end if;
  end loop;

  -- settle_sig, spot checks: a score, no score, a numeric score as written
  for r in
    select * from (values
      ('070001', 'completed|passed|0.9'),
      ('070002', 'in_progress|unknown|'),
      ('070008', 'completed|passed|1.0'),
      ('070015', 'completed|failed|0.2')
    ) as t(id, sig)
  loop
    if (select settle_sig from public.course_attempts where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid)
       is distinct from r.sig then
      bad := bad || format('attempt %s settle_sig %s (expected %s)', r.id,
                           (select settle_sig from public.course_attempts
                             where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid), r.sig);
    end if;
  end loop;

  -- day_ids of the two versions, exact; source slot_backfill
  if (select day_ids from public.journey_versions where id = '00000000-0000-0000-0000-000107062001')
     is distinct from jsonb_build_object('1', d1::text, '2', d2::text, '3', d3::text, '4', d4::text)
     or (select day_ids from public.journey_versions where id = '00000000-0000-0000-0000-000107062002')
     is distinct from jsonb_build_object('1', d1::text, '2', d2::text, '3', d3::text, '4', d4::text, '5', d5::text) then
    bad := bad || format('day_ids read V1 %s, V2 %s',
                         (select day_ids from public.journey_versions where id = '00000000-0000-0000-0000-000107062001'),
                         (select day_ids from public.journey_versions where id = '00000000-0000-0000-0000-000107062002'));
  end if;
  if (select day_ids from public.journey_versions where id = '00000000-0000-0000-0000-000107062003')
     is distinct from '{}'::jsonb
     or exists (select 1 from public.journey_versions
                where id::text like '00000000-0000-0000-0000-00010706200%' and day_ids_source is distinct from 'slot_backfill') then
    bad := bad || format('the version with no days reads day_ids %s (expected {}), or a seeded version is not slot_backfill',
                         coalesce((select day_ids::text from public.journey_versions
                                    where id = '00000000-0000-0000-0000-000107062003'), 'null'));
  end if;

  -- credits: day id by (program, number); credit_kind by Q7's classes
  for r in
    select * from (values
      ('090001', d1, 'attempt'),              -- J's day 1, backed by J's journey row of EJ
      ('090002', d1, 'legacy_cross_context'), -- S's day 1, backed by a preview row
      ('090003', d1, 'legacy_cross_context'), -- B's day 1, no attempt
      ('090004', d2, 'legacy_cross_context'), -- B's day 2, no attempt
      ('090005', d3, 'legacy_cross_context'), -- B's day 3, backed by an Individual row
      ('090006', d5, 'legacy_cross_context')  -- B's day 5, beyond its version, no attempt
    ) as t(id, day_id, kind)
  loop
    select * into a from public.journey_day_progress where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid;
    if not found then
      bad := bad || format('credit %s is missing', r.id);
    elsif a.day_id is distinct from r.day_id or a.credit_kind <> r.kind
          or a.recorded_by is not null or a.late then
      bad := bad || format('credit %s reads day %s, %s, recorded_by %s, late %s (expected day %s, %s)', r.id,
                           a.day_id, a.credit_kind, coalesce(a.recorded_by::text, 'null'), a.late, r.day_id, r.kind);
    end if;
  end loop;

  -- revision visits: the attempt's key, individual when the attempt is gone
  for r in
    select * from (values
      ('110001', 'individual'),
      ('110002', p1),
      ('110003', ej || d1::text),
      ('110004', 'individual')
    ) as t(id, ckey)
  loop
    if (select context_key from public.revision_visits where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid)
       is distinct from r.ckey then
      bad := bad || format('revision visit %s reads %s (expected %s)', r.id,
                           coalesce((select context_key from public.revision_visits
                                      where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid), 'missing'), r.ckey);
    end if;
  end loop;

  -- grants: every existing request is Individual, with no tag
  if exists (
    select 1 from public.attempt_requests
    where id::text like '00000000-0000-0000-0000-00010708%'
      and (context_kind <> 'individual' or context_key <> 'individual' or learning_path_id is not null
           or journey_enrollment_id is not null or journey_day is not null or journey_day_id is not null)
  ) or (select count(*) from public.attempt_requests where id::text like '00000000-0000-0000-0000-00010708%') <> 3 then
    bad := bad || 'the three seeded requests do not all read individual with no tag'::text;
  end if;

  -- the API key from before the paste reads 1; the column default reads 2
  if (select contract_version from public.org_api_keys where id = '00000000-0000-0000-0000-000107100001') is distinct from 1
     or (select allow_contract_override from public.org_api_keys where id = '00000000-0000-0000-0000-000107100001') is distinct from false then
    bad := bad || 'the seeded API key does not read contract_version 1 and no override'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (3) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (4) the backfill rules on every row (the rows written between the pastes,
--     ids 000107120…, left out)
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  n   bigint;
begin
  -- context_kind is the tag rule of step 5 (Q1.kind.*)
  select count(*) into n from public.course_attempts a
   where a.id::text not like '00000000-0000-0000-0000-000107120%'
     and a.context_kind is distinct from (case when a.is_preview then 'preview'
                                               when a.journey_enrollment_id is not null then 'journey'
                                               when a.learning_path_id is not null then 'path'
                                               else 'individual' end);
  if n > 0 then bad := bad || format('%s attempts whose context_kind is not the tag rule', n); end if;

  -- preview_kind is legacy_role exactly on is_preview rows (step 19, A21)
  select count(*) into n from public.course_attempts a
   where a.id::text not like '00000000-0000-0000-0000-000107120%'
     and a.preview_kind is distinct from (case when a.is_preview then 'legacy_role' end);
  if n > 0 then bad := bad || format('%s attempts whose preview_kind is not legacy_role exactly on is_preview', n); end if;

  -- no key is null; a journey row's day id is the journey_days id of (the
  -- enrolment's program, journey_day); no other row has one
  select count(*) into n from public.course_attempts where context_key is null;
  if n > 0 then bad := bad || format('%s attempts with a null context_key', n); end if;
  select count(*) into n from public.course_attempts a
   where a.id::text not like '00000000-0000-0000-0000-000107120%'
     and a.journey_day_id is distinct from (
           select jd.id from public.journey_enrollments e
           join public.journey_days jd on jd.program_id = e.program_id and jd.day_number = a.journey_day
           where e.id = a.journey_enrollment_id and a.context_kind = 'journey');
  if n > 0 then bad := bad || format('%s attempts whose journey_day_id is not their (program, day) id', n); end if;

  -- side effects stamped exactly on completed or passed rows (step 7)
  select count(*) into n from public.course_attempts a
   where a.id::text not like '00000000-0000-0000-0000-000107120%'
     and case when a.completion_status = 'completed' or a.success_status = 'passed'
              then a.side_effects_sig is distinct from a.settle_sig
                   or a.side_effects_at is distinct from coalesce(a.completed_at, a.started_at)
              else a.side_effects_sig is not null or a.side_effects_at is not null end;
  if n > 0 then bad := bad || format('%s attempts whose side_effects_sig or side_effects_at break the backfill rule', n); end if;
  select count(*) into n from public.course_attempts a
   where a.id::text not like '00000000-0000-0000-0000-000107120%'
     and (a.completion_status = 'completed' or a.success_status = 'passed')
     and a.side_effects_sig is distinct from a.settle_sig;
  if n > 0 then bad := bad || format('%s completed rows are sweep candidates after the first paste (A-check: expected 0)', n); end if;

  -- pre_0107 exactly on stamped SCORM 1.2 rows with no webhook latch (step 7)
  select count(*) into n from public.course_attempts a
   join public.course_versions v on v.id = a.course_version_id
   where a.id::text not like '00000000-0000-0000-0000-000107120%'
     and a.webhook_skip_reason is distinct from (
           case when v.manifest_type = 'scorm12'
                     and (a.completion_status = 'completed' or a.success_status = 'passed')
                     and a.completion_webhook_at is null then 'pre_0107' end);
  if n > 0 then bad := bad || format('%s attempts whose webhook_skip_reason breaks the pre_0107 rule', n); end if;

  -- every version maps each of its days, source slot_backfill (step 19, A19)
  select count(*) into n from public.journey_versions jv
   where jv.day_ids is null or jv.day_ids_source is distinct from 'slot_backfill'
      or jv.day_ids is distinct from coalesce((
           select jsonb_object_agg(jd.day_number::text, jd.id::text)
           from jsonb_array_elements(jv.days) e
           join public.journey_days jd on jd.program_id = jv.program_id and jd.day_number = (e ->> 'day')::int), '{}'::jsonb)
      or (select count(*) from jsonb_object_keys(jv.day_ids))
         <> (select count(distinct (e ->> 'day')) from jsonb_array_elements(jv.days) e);
  if n > 0 then bad := bad || format('%s journey versions whose day_ids do not map each of their days', n); end if;

  -- every credit has its day id, and credit_kind follows Q7's classes
  select count(*) into n from public.journey_day_progress pr
   join public.journey_enrollments e on e.id = pr.enrollment_id
   where pr.id::text not like '00000000-0000-0000-0000-000107120%'
     and (pr.day_id is distinct from (select jd.id from public.journey_days jd
                                       where jd.program_id = e.program_id and jd.day_number = pr.day_number)
          or pr.credit_kind <> (case when exists (select 1 from public.course_attempts a
                                                   where a.id = pr.attempt_id and a.context_kind = 'journey'
                                                     and a.journey_enrollment_id = pr.enrollment_id)
                                     then 'attempt' else 'legacy_cross_context' end));
  if n > 0 then bad := bad || format('%s credits whose day_id or credit_kind break the backfill rule', n); end if;

  -- every other new column holds its default
  if exists (select 1 from public.xp_events where context_kind is not null or context_key is not null or event_only)
     or exists (select 1 from public.journey_enrollments where source <> 'admin')
     or exists (select 1 from public.journey_programs where visibility <> 'private')
     or exists (select 1 from public.course_assignments where source <> 'admin')
     or exists (select 1 from public.learning_path_assignments where source <> 'admin')
     or exists (select 1 from public.learning_path_courses where pass_required is not null)
     or exists (select 1 from public.journey_days where pass_required is not null or removed_at is not null
                                                     or day_number is null)
     or exists (select 1 from public.org_integration_settings where webhook_contexts <> 'individual')
     or exists (select 1 from public.attempt_requests where context_kind <> 'individual')
     or exists (select 1 from public.course_attempts where journey_version_id is not null or preview_run_id is not null)
     or exists (select 1 from public.preview_runs) then
    bad := bad || 'a new column that has no backfill does not hold its default, or preview_runs has a row'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (4) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (5) the checks refuse what the record forbids (each with its SQLSTATE) and
--     admit the legal rows; the deferred day_id key still refuses a lone
--     delete of a credited day (note N1); a generated column cannot be written
-- ---------------------------------------------------------------------------
create function pg_temp.expect_state(p_stmt text, p_state text, p_what text) returns text
language plpgsql as $$
declare
  got text := 'no error';
begin
  begin
    execute p_stmt;
    if p_state = 'deferred' then
      set constraints all immediate;
    end if;
  exception when others then
    got := sqlstate;
  end;
  if p_state = 'deferred' then
    return case when got = '23503' then null else format('%s: %s (expected 23503 at the deferred check)', p_what, got) end;
  end if;
  return case when got = p_state then null else format('%s: %s (expected %s)', p_what, got, p_state) end;
end
$$;

do $$
declare
  bad text[] := '{}';
  m   text;
  ins constant text :=
    'insert into public.course_attempts (course_version_id, user_id, organization_id, status, completion_status, '
    || 'success_status, context_kind, is_preview, preview_kind, learning_path_id, journey_enrollment_id, journey_day, '
    || 'journey_day_id, journey_version_id, preview_run_id) values ('
    || '''00000000-0000-0000-0000-0000000000e3'', ''00000000-0000-0000-0000-000107010002'', '
    || '''00000000-0000-0000-0000-00000000000a'', ''completed'', ''completed'', ''unknown'', ';
  p1  constant text := '''00000000-0000-0000-0000-000107050001''';
  ej  constant text := '''00000000-0000-0000-0000-000107063001''';
  es  constant text := '''00000000-0000-0000-0000-000107063002''';
  d1  constant text := '''00000000-0000-0000-0000-000107061001''';
  v1  constant text := '''00000000-0000-0000-0000-000107062001''';
begin
  for m in
    select pg_temp.expect_state(s, st, w) from (values
      -- refused (23514): every arm of the shape check (steps 5 and 79)
      (ins || '''journey'', false, null, ' || p1 || ', ' || ej || ', 1, ' || d1 || ', null, null)', '23514',
       'a journey row that also carries a path tag'),
      (ins || '''journey'', false, null, null, ' || ej || ', 1, null, null, null)', '23514',
       'a journey row without a day id'),
      (ins || '''path'', false, null, null, null, null, null, null, null)', '23514',
       'a path row without a path'),
      (ins || '''individual'', false, null, ' || p1 || ', null, null, null, null, null)', '23514',
       'an individual row with a path tag'),
      (ins || '''individual'', false, null, null, null, null, null, ' || v1 || ', null)', '23514',
       'a journey_version_id outside the journey kind'),
      (ins || '''preview'', false, ''course'', null, null, null, null, null, null)', '23514',
       'a preview without is_preview'),
      (ins || '''preview'', true, null, null, null, null, null, null, null)', '23514',
       'a preview with a null preview_kind'),
      (ins || '''individual'', false, ''course'', null, null, null, null, null, null)', '23514',
       'a preview_kind outside the preview kind'),
      (ins || '''individual'', true, null, null, null, null, null, null, null)', '23514',
       'is_preview on an individual row'),
      (ins || '''preview'', true, ''course'', ' || p1 || ', null, null, null, null, null)', '23514',
       'a course preview with an official tag'),
      (ins || '''preview'', true, ''legacy_role'', null, null, null, ' || d1 || ', null, null)', '23514',
       'a legacy_role row with a day id'),
      (ins || '''preview'', true, ''journey_run'', null, null, null, null, null, null)', '23514',
       'a journey_run preview without a run or a day'),
      (ins || '''other'', false, null, null, null, null, null, null, null)', '23514',
       'an unknown context_kind'),
      -- a null context_kind is labelled by the paste-window derive trigger
      -- (section 2c; checks (8)); 0108 drops it and restores the not-null
      -- refusal
      (ins || 'null, false, null, null, null, null, null, null, null)', 'no error',
       'a null context_kind (labelled by the derive trigger)'),
      -- admitted: an old tagged preview (legacy_role keeps its tags) and a course preview;
      -- the tag names ES, not J's EJ, so the user cascade of J in (9) meets no
      -- other row that names J's enrolment (such a row blocks it, step 6)
      (ins || '''preview'', true, ''legacy_role'', ' || p1 || ', ' || es || ', 2, null, null, null)', 'no error',
       'a legacy_role row keeping both old tags'),
      (ins || '''preview'', true, ''course'', null, null, null, null, null, null)', 'no error',
       'a course preview'),
      (ins || '''path'', false, null, ' || p1 || ', null, null, null, null, null)', 'no error',
       'a path row'),
      -- a generated column is never written
      ('update public.course_attempts set context_key = ''individual'' where id = ''00000000-0000-0000-0000-000107070001''',
       '428C9', 'a write to context_key'),
      ('update public.course_attempts set settle_sig = ''x'' where id = ''00000000-0000-0000-0000-000107070001''',
       '428C9', 'a write to settle_sig'),
      -- attempt_requests: the shape check without the preview arm
      ('insert into public.attempt_requests (organization_id, course_id, user_id, status, context_kind, journey_enrollment_id, journey_day) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-0000000000c1'', '
       || '''00000000-0000-0000-0000-000107010004'', ''rejected'', ''journey'', ' || ej || ', 1)', '23514',
       'a journey grant without a day id'),
      ('insert into public.attempt_requests (organization_id, course_id, user_id, status, context_kind, learning_path_id, journey_day) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-0000000000c1'', '
       || '''00000000-0000-0000-0000-000107010002'', ''rejected'', ''path'', ' || p1 || ', 1)', '23514',
       'a path grant with a journey day'),
      ('insert into public.attempt_requests (organization_id, course_id, user_id, status, context_kind) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-0000000000c1'', '
       || '''00000000-0000-0000-0000-000107010002'', ''rejected'', ''preview'')', '23514',
       'a preview grant'),
      ('insert into public.attempt_requests (organization_id, course_id, user_id, status, context_kind, learning_path_id) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-0000000000c1'', '
       || '''00000000-0000-0000-0000-000107010002'', ''rejected'', ''path'', ' || p1 || ')', 'no error',
       'a path grant'),
      -- journey_days: a removed day has no number
      ('update public.journey_days set removed_at = now() where id = ' || d1, '23514',
       'a removed day that keeps its number'),
      ('update public.journey_days set removed_at = now(), day_number = null '
       || 'where id = ''00000000-0000-0000-0000-000107061005''', 'no error',
       'a removed day without a number'),
      -- journey_versions.day_ids_source and journey_day_progress.credit_kind
      ('update public.journey_versions set day_ids_source = ''other'' where id = ' || v1, '23514',
       'an unknown day_ids_source'),
      ('update public.journey_day_progress set credit_kind = ''other'' '
       || 'where id = ''00000000-0000-0000-0000-000107090001''', '23514',
       'an unknown credit_kind'),
      -- preview_runs: a path run names only the path and has no done days
      ('insert into public.preview_runs (organization_id, user_id, kind, learning_path_id, done_activity_day_ids) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-000107010006'', ''path'', '
       || p1 || ', array[' || d1 || '::uuid])', '23514',
       'a path run with a done activity day'),
      ('insert into public.preview_runs (organization_id, user_id, kind, learning_path_id, journey_program_id) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-000107010006'', ''path'', '
       || p1 || ', ''00000000-0000-0000-0000-000107060001'')', '23514',
       'a path run that names a program'),
      ('insert into public.preview_runs (organization_id, user_id, kind, journey_program_id) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-000107010006'', ''journey'', '
       || '''00000000-0000-0000-0000-000107060001'')', '23514',
       'a journey run without a version'),
      ('insert into public.preview_runs (organization_id, user_id, kind, journey_program_id, journey_version_id, done_activity_day_ids) '
       || 'values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-000107010006'', ''journey'', '
       || '''00000000-0000-0000-0000-000107060001'', ' || v1 || ', array[' || d1 || '::uuid])', 'no error',
       'a journey run with a done activity day'),
      -- the deferred day_id key: a lone delete of a credited day is refused at the check (N1);
      -- day 5 is credited (B's history credit) and holds no attempt
      ('delete from public.journey_days where id = ''00000000-0000-0000-0000-000107061005''', 'deferred',
       'a lone delete of a credited day'),
      -- the new foreign keys refuse a dangling id
      (ins || '''preview'', true, ''path_run'', null, null, null, null, null, ''00000000-0000-0000-0000-000107999999'')', '23503',
       'a preview_run_id that names no run')
    ) as t(s, st, w)
  loop
    if m is not null then bad := bad || m; end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (5) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (6) org_api_keys (step 8, decision A28): authenticated keeps select and
--     delete, and holds insert and update only on the columns the settings
--     route writes. Real refusals as a super owner's session, with controls:
--     the policy admits that session, so a 42501 can only come from the
--     privilege; the key inserted through the granted columns reads 2.
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
begin
  for r in
    select * from (values
      ('organization_id', 'insert', true), ('name', 'insert', true), ('key_prefix', 'insert', true),
      ('key_hash', 'insert', true), ('is_active', 'insert', true), ('created_by', 'insert', true),
      ('contract_version', 'insert', false), ('allow_contract_override', 'insert', false),
      ('last_used_at', 'insert', false), ('id', 'insert', false),
      ('is_active', 'update', true), ('name', 'update', false), ('contract_version', 'update', false),
      ('allow_contract_override', 'update', false), ('last_used_at', 'update', false),
      ('contract_version', 'select', true)
    ) as t(col, priv, expected)
  loop
    if has_column_privilege('authenticated', 'public.org_api_keys', r.col, r.priv) <> r.expected then
      bad := bad || format('authenticated %s on org_api_keys.%s: %s (expected %s)', r.priv, r.col, not r.expected, r.expected);
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.org_api_keys', 'insert')
     or has_table_privilege('authenticated', 'public.org_api_keys', 'update')
     or not has_table_privilege('authenticated', 'public.org_api_keys', 'delete')
     or not has_table_privilege('authenticated', 'public.org_api_keys', 'select') then
    bad := bad || 'authenticated table-level privileges on org_api_keys are not select and delete only'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (6) %', array_to_string(bad, '; ');
  end if;
end
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000107019901', 'owner-0107@example.test');
insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107019901', 'super_owner');

create function pg_temp.as_owner_state(p_stmt text) returns text
language plpgsql as $$
declare
  got text := 'no error';
  n   bigint;
begin
  begin
    execute p_stmt;
    get diagnostics n = row_count;
    got := 'no error, ' || n || ' row(s)';
  exception when others then
    got := sqlstate;
  end;
  return got;
end
$$;
grant execute on function pg_temp.as_owner_state(text) to authenticated;

select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-000107019901", "role": "authenticated"}', true);
set local role authenticated;
create temporary table r0107_owner as
select s.what, pg_temp.as_owner_state(s.stmt) as got, s.expected
from (values
  ('update of contract_version',
   'update public.org_api_keys set contract_version = 2 where id = ''00000000-0000-0000-0000-000107100001''', '42501'),
  ('update of allow_contract_override',
   'update public.org_api_keys set allow_contract_override = true where id = ''00000000-0000-0000-0000-000107100001''', '42501'),
  ('update of name',
   'update public.org_api_keys set name = ''Renamed'' where id = ''00000000-0000-0000-0000-000107100001''', '42501'),
  ('insert naming contract_version',
   'insert into public.org_api_keys (organization_id, name, key_prefix, key_hash, created_by, contract_version) '
   || 'values (''00000000-0000-0000-0000-00000000000a'', ''Forged (0107)'', ''ambk_0107ef'', ''seed-0107-key-hash-3'', '
   || '''00000000-0000-0000-0000-000107019901'', 1)', '42501'),
  ('update of is_active (the route''s deactivate)',
   'update public.org_api_keys set is_active = false where id = ''00000000-0000-0000-0000-000107100001''', 'no error, 1 row(s)'),
  ('insert through the granted columns (the route''s insert)',
   'insert into public.org_api_keys (organization_id, name, key_prefix, key_hash, created_by) '
   || 'values (''00000000-0000-0000-0000-00000000000a'', ''Route key (0107)'', ''ambk_0107ab2'', ''seed-0107-key-hash-4'', '
   || '''00000000-0000-0000-0000-000107019901'')', 'no error, 1 row(s)')
) as s(what, stmt, expected);
reset role;

do $$
declare
  bad text[] := '{}';
  r   record;
begin
  for r in select * from pg_temp.r0107_owner loop
    if r.got <> r.expected then
      bad := bad || format('as a super owner, %s: %s (expected %s)', r.what, r.got, r.expected);
    end if;
  end loop;
  if (select contract_version from public.org_api_keys where key_hash = 'seed-0107-key-hash-4') is distinct from 2 then
    bad := bad || 'the key inserted through the granted columns does not read contract_version 2'::text;
  end if;
  if (select contract_version from public.org_api_keys where id = '00000000-0000-0000-0000-000107100001') is distinct from 1 then
    bad := bad || 'the seeded key does not read contract_version 1 after the session''s updates'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (6) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (7) section 2 and 6a, the objects: context_derive_log (its one row, RLS
--     with a no-access policy, service_role select, insert and update only);
--     the three triggers (timing, when clause, function) and their
--     functions (security definer only for the derive trigger, the pinned
--     search_path, execute for service_role only); the indexes exactly as
--     defined, with the three replaced keys gone. With the five of (2), these
--     are twelve of step 7's seventeen foreign-key indexes; the other five
--     come with the tables of creation order item 3.
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  g   record;
  got text;
begin
  select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                    || case when a.attnotnull then ' not null' else '' end
                    || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''), ', ' order by a.attnum)
    into got
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.context_derive_log'::regclass and a.attnum > 0 and not a.attisdropped;
  if got is distinct from
     'id boolean not null default true, last_fired_at timestamp with time zone, fired_count bigint not null default 0' then
    bad := bad || format('context_derive_log has columns (%s)', coalesce(got, 'none'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.context_derive_log'::regclass and contype = 'p')
     or not exists (select 1 from pg_constraint
                    where conrelid = 'public.context_derive_log'::regclass and contype = 'c'
                      and pg_get_constraintdef(oid) = 'CHECK (id)') then
    bad := bad || 'context_derive_log lacks its primary key or its check (id)'::text;
  end if;
  if (select count(*) from public.context_derive_log) <> 1
     or not exists (select 1 from public.context_derive_log where id and fired_count >= 0) then
    bad := bad || 'context_derive_log does not hold exactly its one row'::text;
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.context_derive_log'::regclass)
     or not exists (
       select 1 from pg_policy
       where polrelid = 'public.context_derive_log'::regclass
         and polname = 'no direct access to context_derive_log'
         and pg_get_expr(polqual, polrelid) = 'false'
         and pg_get_expr(polwithcheck, polrelid) = 'false') then
    bad := bad || 'context_derive_log lacks row-level security or its no-access policy'::text;
  end if;
  for r in
    select * from (values
      ('anon', 'select', false), ('anon', 'insert', false), ('anon', 'update', false), ('anon', 'delete', false),
      ('authenticated', 'select', false), ('authenticated', 'insert', false),
      ('authenticated', 'update', false), ('authenticated', 'delete', false),
      ('service_role', 'select', true), ('service_role', 'insert', true),
      ('service_role', 'update', true), ('service_role', 'delete', false),
      ('service_role', 'truncate', false)
    ) as t(role_name, priv, expected)
  loop
    if has_table_privilege(r.role_name, 'public.context_derive_log', r.priv) <> r.expected then
      bad := bad || format('%s %s on context_derive_log: %s (expected %s)', r.role_name, r.priv,
                           not r.expected, r.expected);
    end if;
  end loop;

  -- the triggers: tgtype 19 = row, before, update; 7 = row, before, insert
  for r in
    select * from (values
      ('course_attempts',  'course_attempts_context_immutable', 19, null::text),
      ('course_attempts',  'course_attempts_context_derive',     7, '%WHEN ((new.context_kind IS NULL))%'),
      ('journey_versions', 'journey_versions_derive_day_ids',    7, '%WHEN ((new.day_ids IS NULL))%')
    ) as t(tbl, tg, tgtype, when_like)
  loop
    select t.tgtype::int as tgtype, t.tgenabled::text as enabled, p.proname::text as fn,
           pg_get_triggerdef(t.oid) as def, count(*) over () as n
      into g
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = ('public.' || r.tbl)::regclass and t.tgname = r.tg and not t.tgisinternal;
    if not found then
      bad := bad || format('trigger %s on %s is missing', r.tg, r.tbl);
    elsif g.n <> 1 or g.tgtype <> r.tgtype or g.enabled <> 'O' or g.fn <> r.tg
          or (r.when_like is null and g.def like '%WHEN%')
          or (r.when_like is not null and g.def not like r.when_like) then
      bad := bad || format('trigger %s reads: %s (type %s, enabled %s)', r.tg, g.def, g.tgtype, g.enabled);
    end if;
  end loop;
  if (select count(*) from pg_trigger
       where tgrelid = 'public.course_attempts'::regclass and not tgisinternal) <> 2 then
    bad := bad || 'course_attempts does not have exactly its two triggers'::text;
  end if;

  -- the three functions
  for r in
    select * from (values
      ('public.course_attempts_context_immutable()', false),
      ('public.course_attempts_context_derive()',    true),
      ('public.journey_versions_derive_day_ids()',   false)
    ) as t(fn, secdef)
  loop
    select p.prosecdef, p.proconfig, l.lanname::text as lang, p.prorettype::regtype::text as rettype
      into g
      from pg_proc p
      join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure(r.fn);
    if not found then
      bad := bad || format('%s is missing', r.fn);
    elsif g.prosecdef <> r.secdef or g.proconfig is distinct from array['search_path=pg_catalog, public']
          or g.lang <> 'plpgsql' or g.rettype <> 'trigger' then
      bad := bad || format('%s: security definer %s, proconfig %s, %s, returns %s', r.fn, g.prosecdef,
                           coalesce(g.proconfig::text, 'null'), g.lang, g.rettype);
    elsif has_function_privilege('anon', r.fn, 'execute')
          or has_function_privilege('authenticated', r.fn, 'execute')
          or not has_function_privilege('service_role', r.fn, 'execute') then
      bad := bad || format('%s: execute is not service_role only', r.fn);
    end if;
  end loop;

  -- the indexes, exactly as defined
  for r in
    select * from (values
      ('course_attempts_one_in_progress_ctx_idx',
       'CREATE UNIQUE INDEX course_attempts_one_in_progress_ctx_idx ON public.course_attempts USING btree (user_id, course_version_id, context_key) WHERE (status = ''in_progress''::text)'),
      ('course_attempts_user_version_ctx_idx',
       'CREATE INDEX course_attempts_user_version_ctx_idx ON public.course_attempts USING btree (user_id, course_version_id, context_key)'),
      ('course_attempts_org_kind_completed_idx',
       'CREATE INDEX course_attempts_org_kind_completed_idx ON public.course_attempts USING btree (organization_id, context_kind, completed_at)'),
      ('course_attempts_ctx_user_idx',
       'CREATE INDEX course_attempts_ctx_user_idx ON public.course_attempts USING btree (context_key, user_id) WHERE (context_kind <> ''individual''::text)'),
      ('attempt_requests_one_open_ctx_idx',
       'CREATE UNIQUE INDEX attempt_requests_one_open_ctx_idx ON public.attempt_requests USING btree (user_id, course_id, context_key) WHERE ((status = ''pending''::text) OR ((status = ''approved''::text) AND (used_at IS NULL)))'),
      ('journey_day_progress_enrollment_id_day_id_key',
       'CREATE UNIQUE INDEX journey_day_progress_enrollment_id_day_id_key ON public.journey_day_progress USING btree (enrollment_id, day_id)'),
      ('course_attempts_journey_version_idx',
       'CREATE INDEX course_attempts_journey_version_idx ON public.course_attempts USING btree (journey_version_id) WHERE (journey_version_id IS NOT NULL)'),
      ('course_attempts_preview_run_idx',
       'CREATE INDEX course_attempts_preview_run_idx ON public.course_attempts USING btree (preview_run_id) WHERE (preview_run_id IS NOT NULL)'),
      ('course_attempts_journey_day_idx',
       'CREATE INDEX course_attempts_journey_day_idx ON public.course_attempts USING btree (journey_day_id) WHERE (journey_day_id IS NOT NULL)'),
      ('attempt_requests_journey_day_idx',
       'CREATE INDEX attempt_requests_journey_day_idx ON public.attempt_requests USING btree (journey_day_id) WHERE (journey_day_id IS NOT NULL)'),
      ('attempt_requests_learning_path_idx',
       'CREATE INDEX attempt_requests_learning_path_idx ON public.attempt_requests USING btree (learning_path_id) WHERE (learning_path_id IS NOT NULL)'),
      ('attempt_requests_journey_enrollment_idx',
       'CREATE INDEX attempt_requests_journey_enrollment_idx ON public.attempt_requests USING btree (journey_enrollment_id) WHERE (journey_enrollment_id IS NOT NULL)'),
      ('journey_day_progress_day_idx',
       'CREATE INDEX journey_day_progress_day_idx ON public.journey_day_progress USING btree (day_id)'),
      ('xp_events_org_ctx_created_idx',
       'CREATE INDEX xp_events_org_ctx_created_idx ON public.xp_events USING btree (organization_id, context_key, created_at DESC)')
    ) as t(idx, def)
  loop
    got := (select pg_get_indexdef(c.oid)
              from pg_class c
              join pg_namespace s on s.oid = c.relnamespace
             where s.nspname = 'public' and c.relname = r.idx and c.relkind = 'i');
    if got is distinct from r.def then
      bad := bad || format('index %s reads %s', r.idx, coalesce(got, 'missing'));
    end if;
  end loop;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.journey_day_progress'::regclass
                   and conname = 'journey_day_progress_enrollment_id_day_id_key' and contype = 'u') then
    bad := bad || 'unique (enrollment_id, day_id) on journey_day_progress is not a constraint'::text;
  end if;

  -- the three replaced keys are gone
  if to_regclass('public.course_attempts_one_in_progress_idx') is not null then
    bad := bad || 'the 0062 index course_attempts_one_in_progress_idx is still present'::text;
  end if;
  if to_regclass('public.attempt_requests_one_open_idx') is not null then
    bad := bad || 'the 0083 index attempt_requests_one_open_idx is still present'::text;
  end if;
  if exists (
    select 1 from pg_index i
    where i.indrelid = 'public.journey_day_progress'::regclass and i.indisunique
      and (select array_agg(a.attname::text order by a.attname::text)
             from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
          = array['day_number', 'enrollment_id']
  ) then
    bad := bad || 'unique (enrollment_id, day_number) of 0058 is still present on journey_day_progress'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (7) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (8) the two attempt triggers at work. The derive trigger: every branch
--     (individual, path, journey with its day id read from the pinned
--     version and the path tag nulled, a given day id kept, preview as
--     legacy_role with its old tags), its two refusals, no firing for an
--     insert that names context_kind, and the count in context_derive_log (a
--     delta: the log may already hold firings, seed-0107-repaste.sql). The
--     immutability trigger: each of its nine columns refused for the service
--     role and for postgres, the resume re-tag and the analyst's
--     grant-retake update refused, and the controls (another column, the
--     same values). Every refusal is P0001 with a message neither schema
--     probe of the launch matches (note N7).
-- ---------------------------------------------------------------------------
create function pg_temp.try_0107(p_stmt text, out state text, out con text, out msg text, out n bigint)
language plpgsql as $$
begin
  state := 'ok';
  begin
    execute p_stmt;
    get diagnostics n = row_count;
  exception when others then
    get stacked diagnostics state = returned_sqlstate, con = constraint_name, msg = message_text;
  end;
end
$$;
grant execute on function pg_temp.try_0107(text) to service_role, authenticated;

do $$
declare
  bad   text[] := '{}';
  r     record;
  t     record;
  a     record;
  n0    bigint;
  n1    bigint;
  fired timestamptz;
  probe constant text := 'schema cache|does not exist|could not find the';
  org   constant uuid := '00000000-0000-0000-0000-00000000000a';
  e1    constant uuid := '00000000-0000-0000-0000-0000000000e1';
  e3    constant uuid := '00000000-0000-0000-0000-0000000000e3';
  u_p   constant uuid := '00000000-0000-0000-0000-000107010002';
  u_j   constant uuid := '00000000-0000-0000-0000-000107010004';
  u_o   constant uuid := '00000000-0000-0000-0000-000107010005';
  u_s   constant uuid := '00000000-0000-0000-0000-000107010006';
  p1    constant uuid := '00000000-0000-0000-0000-000107050001';
  ej    constant uuid := '00000000-0000-0000-0000-000107063001';
  es    constant uuid := '00000000-0000-0000-0000-000107063002';
  d3    constant uuid := '00000000-0000-0000-0000-000107061003';
  d4    constant uuid := '00000000-0000-0000-0000-000107061004';
begin
  select fired_count into n0 from public.context_derive_log;

  for r in
    select * from (values
      -- id, what, version, learner, context_kind named, is_preview, path, enrolment, day, day id given;
      -- then the expected state and, for a row written, context_kind, key, preview_kind, path, enrolment, day, day id
      ('130001', 'a tagless insert', e3, u_o, null::text, false, null::uuid, null::uuid, null::int, null::uuid,
       'ok', 'individual', 'individual', null::text, null::uuid, null::uuid, null::int, null::uuid),
      ('130002', 'a path insert', e1, u_p, null, false, p1, null, null, null,
       'ok', 'path', 'path:' || p1, null, p1, null, null, null),
      ('130003', 'a journey insert that also carries a path tag', e1, u_j, null, false, p1, ej, 3, null,
       'ok', 'journey', 'journey:' || ej || ':' || d3, null, null, ej, 3, d3),
      -- S's own enrolment ES: a by-role row with an old enrolment tag blocks
      -- that enrolment's delete (step 6), so it never names another learner's
      ('130004', 'a preview by role with both old tags', e1, u_s, null, true, p1, es, 2, null,
       'ok', 'preview', 'preview', 'legacy_role', p1, es, 2, null),
      ('130005', 'a journey day the pinned version does not hold', e1, u_j, null, false, null, ej, 5, null,
       'P0001', null, null, null, null, null, null, null),
      ('130006', 'a journey tag with no day', e1, u_j, null, false, null, ej, null, null,
       'P0001', null, null, null, null, null, null, null),
      ('130007', 'a journey insert that gives its day id', e3, u_j, null, false, null, ej, 2, d4,
       'ok', 'journey', 'journey:' || ej || ':' || d4, null, null, ej, 2, d4),
      ('130008', 'an insert that names context_kind (no firing)', e1, u_o, 'individual', false, null, null, null, null,
       'ok', 'individual', 'individual', null, null, null, null, null)
    ) as v(id, what, version_id, learner, kind_in, preview, path, enr, day, day_id_in,
           expected, kind, ckey, pkind, path_out, enr_out, day_out, day_id)
  loop
    select * into t from pg_temp.try_0107(format(
      'insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, '
      || 'completion_status, success_status, context_kind, is_preview, learning_path_id, journey_enrollment_id, '
      || 'journey_day, journey_day_id) values (%L, %L, %L, %L, ''completed'', ''completed'', ''unknown'', '
      || '%L, %L, %L, %L, %L, %L)',
      '00000000-0000-0000-0000-000107' || r.id, r.version_id, r.learner, org,
      r.kind_in, r.preview, r.path, r.enr, r.day, r.day_id_in));
    if t.state <> r.expected then
      bad := bad || format('derive, %s: %s %s (expected %s)', r.what, t.state, coalesce(t.msg, ''), r.expected);
    elsif t.state = 'P0001' and t.msg ~* probe then
      bad := bad || format('derive, %s: the message "%s" matches a schema probe (note N7)', r.what, t.msg);
    elsif t.state = 'ok' then
      select * into a from public.course_attempts where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid;
      if a.context_kind <> r.kind or a.context_key is distinct from r.ckey or a.preview_kind is distinct from r.pkind
         or a.learning_path_id is distinct from r.path_out or a.journey_enrollment_id is distinct from r.enr_out
         or a.journey_day is distinct from r.day_out or a.journey_day_id is distinct from r.day_id
         or a.journey_version_id is not null or a.preview_run_id is not null then
        bad := bad || format('derive, %s: reads %s / %s / %s / path %s / enrolment %s / day %s / day id %s',
                             r.what, a.context_kind, a.context_key, coalesce(a.preview_kind, 'null'),
                             coalesce(a.learning_path_id::text, 'null'), coalesce(a.journey_enrollment_id::text, 'null'),
                             coalesce(a.journey_day::text, 'null'), coalesce(a.journey_day_id::text, 'null'));
      end if;
    end if;
  end loop;

  select fired_count, last_fired_at into n1, fired from public.context_derive_log;
  if n1 <> n0 + 5 or fired is distinct from now() then
    bad := bad || format('context_derive_log reads %s firings since the start of (8) and last fired at %s '
                         || '(expected 5, now)', n1 - n0, coalesce(fired::text, 'null'));
  end if;

  -- immutability, as postgres (the table owner is not exempt)
  for r in
    select * from (values
      ('context_kind on an individual row', 'update public.course_attempts set context_kind = ''path'', '
         || 'learning_path_id = ''00000000-0000-0000-0000-000107050001'' where id = ''00000000-0000-0000-0000-000107070001'''),
      ('journey_day_id nulled on a journey row', 'update public.course_attempts set journey_day_id = null '
         || 'where id = ''00000000-0000-0000-0000-000107070011''')
    ) as v(what, stmt)
  loop
    select * into t from pg_temp.try_0107(r.stmt);
    if t.state <> 'P0001' or t.msg ~* probe then
      bad := bad || format('immutability as postgres, %s: %s %s (expected P0001)', r.what, t.state, coalesce(t.msg, ''));
    end if;
  end loop;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (8) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- immutability for the service role (decision D6): the shim grants it
-- nothing, so this transaction grants what the service client holds on
-- Supabase; the controls show the refusals come from the trigger
grant usage on schema public to service_role;
grant select, update on public.course_attempts to service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
set local role service_role;
create temporary table r0107_svc as
select s.what, s.expected, t.state, t.msg, t.n
from (values
  ('context_kind',          'set context_kind = ''individual''',                                         'P0001'),
  ('learning_path_id',      'set learning_path_id = ''00000000-0000-0000-0000-000107050002''',           'P0001'),
  ('journey_enrollment_id', 'set journey_enrollment_id = ''00000000-0000-0000-0000-000107063001''',      'P0001'),
  ('journey_day',           'set journey_day = 1',                                                       'P0001'),
  ('journey_day_id',        'set journey_day_id = ''00000000-0000-0000-0000-000107061001''',             'P0001'),
  ('journey_version_id',    'set journey_version_id = ''00000000-0000-0000-0000-000107062001''',         'P0001'),
  ('is_preview',            'set is_preview = true',                                                     'P0001'),
  ('preview_kind',          'set preview_kind = ''course''',                                             'P0001'),
  ('preview_run_id',        'set preview_run_id = ''00000000-0000-0000-0000-000107999998''',             'P0001'),
  ('another column (control)', 'set last_activity_at = now()',                                           'ok 1'),
  ('the same values (control)',
   'set context_kind = context_kind, learning_path_id = learning_path_id, '
   || 'journey_enrollment_id = journey_enrollment_id, journey_day = journey_day, journey_day_id = journey_day_id, '
   || 'journey_version_id = journey_version_id, is_preview = is_preview, preview_kind = preview_kind, '
   || 'preview_run_id = preview_run_id',                                                                 'ok 1')
) as s(what, stmt, expected)
cross join lateral pg_temp.try_0107(
  'update public.course_attempts ' || s.stmt || ' where id = ''00000000-0000-0000-0000-000107070005''') as t
union all
select s.what, s.expected, t.state, t.msg, t.n
from (values
  -- the launch page's resume re-tag on I's untagged open row
  ('the resume re-tag',
   'update public.course_attempts set journey_enrollment_id = ''00000000-0000-0000-0000-000107063001'', journey_day = 2 '
   || 'where id = ''00000000-0000-0000-0000-000107070002''', 'P0001'),
  -- the grant-retake update on B's live retake: an analyst writes is_preview, a learner false over false
  ('the grant-retake update writing is_preview',
   'update public.course_attempts set served_language = ''en'', launch_mode = ''Normal'', is_preview = true '
   || 'where id = ''00000000-0000-0000-0000-000107070010''', 'P0001'),
  ('the grant-retake update writing false over false (control)',
   'update public.course_attempts set served_language = ''en'', launch_mode = ''Normal'', is_preview = false '
   || 'where id = ''00000000-0000-0000-0000-000107070010''', 'ok 1')
) as s(what, stmt, expected)
cross join lateral pg_temp.try_0107(s.stmt) as t;
reset role;

do $$
declare
  bad text[] := '{}';
  r   record;
begin
  if (select count(*) from pg_temp.r0107_svc) <> 14 then
    bad := bad || 'the service-role cases did not all run'::text;
  end if;
  for r in select * from pg_temp.r0107_svc loop
    if (case when r.state = 'ok' then 'ok ' || r.n else r.state end) <> r.expected then
      bad := bad || format('as service_role, %s: %s %s (expected %s)', r.what, r.state,
                           coalesce(r.msg, coalesce(r.n::text, '')), r.expected);
    elsif r.state = 'P0001' and r.msg ~* 'schema cache|does not exist|could not find the' then
      bad := bad || format('as service_role, %s: the message "%s" matches a schema probe (note N7)', r.what, r.msg);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (8) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (9) the keys at work. The two attempt keys refuse a lone delete of a path
--     or an enrolment that an attempt names (23503 on the attempt's key),
--     while the organisation and user cascades delete paths, enrolments,
--     attempts of both kinds, credits and grants (paste-window note 5); a
--     program with a credit and no learner attempt deletes (note N1), and a
--     lone delete of its credited day is refused at the deferred check.
--     Each delete runs in a subtransaction that checks every deferred key
--     at once and is then undone. The new unique keys: three open rows of
--     one version in three contexts, a preview beside a real attempt, two
--     open requests in two contexts, two credits of one number on two days;
--     a second row in one context, and a course preview beside an open
--     legacy_role row (note N4), raise 23505 on the new key.
-- ---------------------------------------------------------------------------
create function pg_temp.at_commit_0107(p_stmt text, p_claims text, out state text, out con text)
language plpgsql as $$
begin
  begin
    if p_claims is not null then
      perform set_config('request.jwt.claims', p_claims, true);
    end if;
    execute p_stmt;
    set constraints all immediate;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    get stacked diagnostics state = returned_sqlstate, con = constraint_name;
  end;
  if state = 'R0107' then
    state := 'ok';
    con := null;
  end if;
end
$$;

do $$
declare
  bad  text[] := '{}';
  r    record;
  t    record;
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  jx   constant uuid := '00000000-0000-0000-0000-000107131001';
  dx   constant uuid := '00000000-0000-0000-0000-000107131101';
  ins  constant text :=
    'insert into public.course_attempts (course_version_id, user_id, organization_id, status, completion_status, '
    || 'success_status, context_kind, is_preview, preview_kind, learning_path_id, journey_enrollment_id, journey_day, '
    || 'journey_day_id) values (''00000000-0000-0000-0000-0000000000e1'', ';
  req  constant text :=
    'insert into public.attempt_requests (organization_id, course_id, user_id, status, used_at, context_kind, '
    || 'learning_path_id) values (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-0000000000c2'', '
    || '''00000000-0000-0000-0000-000107010002'', ';
  cred constant text :=
    'insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id) '
    || 'values (''00000000-0000-0000-0000-000107063001'', ''00000000-0000-0000-0000-00000000000a'', '
    || '''00000000-0000-0000-0000-000107010004'', ';
begin
  -- N1's program: a day, a version (its day_ids from the trigger of 6a), an
  -- enrolment of I and one credit that no attempt backs
  insert into public.journey_programs (id, organization_id, name, days_total) values
    (jx, org, 'Credit only (0107 assert)', 1);
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
    (dx, jx, org, 1, '00000000-0000-0000-0000-0000000000c1');
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days) values
    ('00000000-0000-0000-0000-000107131201', jx, org, 1, 'Credit only (0107 assert)', 1, false, 'Yoddha',
     '[{"day": 1, "course_id": "00000000-0000-0000-0000-0000000000c1", "mission_title": null}]');
  insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status) values
    ('00000000-0000-0000-0000-000107131301', jx, '00000000-0000-0000-0000-000107131201', org,
     '00000000-0000-0000-0000-000107010001', current_date - 1, 'active');
  insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id,
                                           attempt_id, credit_kind) values
    ('00000000-0000-0000-0000-000107131301', org, '00000000-0000-0000-0000-000107010001', 1, dx,
     '00000000-0000-0000-0000-0000000000c1', null, 'legacy_cross_context');

  for r in
    select * from (values
      ('a lone delete of P2, which O''s open path row names',
       'delete from public.learning_paths where id = ''00000000-0000-0000-0000-000107050002''', null::text,
       '23503 course_attempts_learning_path_id_fkey'),
      ('a lone delete of J''s enrolment EJ, which J''s journey rows name',
       'delete from public.journey_enrollments where id = ''00000000-0000-0000-0000-000107063001''', null,
       '23503 course_attempts_journey_enrollment_id_fkey'),
      ('a delete of a program with a credit and no learner attempt (N1)',
       'delete from public.journey_programs where id = ''00000000-0000-0000-0000-000107131001''', null,
       'ok'),
      ('a lone delete of that program''s credited day (N1 control)',
       'delete from public.journey_days where id = ''00000000-0000-0000-0000-000107131101''', null,
       '23503 journey_day_progress_day_id_fkey'),
      ('the organisation cascade over path and journey attempts, credits and grants',
       'delete from public.organizations where id = ''00000000-0000-0000-0000-00000000000a''',
       '{"role": "service_role"}', 'ok'),
      ('the user cascade of J (journey attempts, enrolment, credits)',
       'delete from auth.users where id = ''00000000-0000-0000-0000-000107010004''', '{"role": "service_role"}', 'ok'),
      ('the user cascade of P (path attempts, assignments, a grant)',
       'delete from auth.users where id = ''00000000-0000-0000-0000-000107010002''', '{"role": "service_role"}', 'ok')
    ) as v(what, stmt, claims, expected)
  loop
    select * into t from pg_temp.at_commit_0107(r.stmt, r.claims);
    if t.state || coalesce(' ' || nullif(t.con, ''), '') <> r.expected then
      bad := bad || format('%s: %s %s (expected %s)', r.what, t.state, coalesce(t.con, ''), r.expected);
    end if;
  end loop;
  if not exists (select 1 from public.journey_programs where id = jx)
     or not exists (select 1 from public.organizations where id = org) then
    bad := bad || 'a delete of (9) was not undone'::text;
  end if;

  for r in
    select * from (values
      -- B on e1 holds an open Individual row (070010)
      ('B: an open path row beside the open Individual row',
       ins || '''00000000-0000-0000-0000-000107010003'', ''00000000-0000-0000-0000-00000000000a'', ''in_progress'', '
           || '''in_progress'', ''unknown'', ''path'', false, null, ''00000000-0000-0000-0000-000107050001'', null, null, null)',
       'ok'),
      ('B: an open journey row, a third context on the same version',
       ins || '''00000000-0000-0000-0000-000107010003'', ''00000000-0000-0000-0000-00000000000a'', ''in_progress'', '
           || '''in_progress'', ''unknown'', ''journey'', false, null, null, ''00000000-0000-0000-0000-000107063003'', 1, '
           || '''00000000-0000-0000-0000-000107061001'')',
       'ok'),
      ('B: a second open Individual row',
       ins || '''00000000-0000-0000-0000-000107010003'', ''00000000-0000-0000-0000-00000000000a'', ''in_progress'', '
           || '''in_progress'', ''unknown'', ''individual'', false, null, null, null, null, null)',
       '23505 course_attempts_one_in_progress_ctx_idx'),
      ('B: a second open path row in P1',
       ins || '''00000000-0000-0000-0000-000107010003'', ''00000000-0000-0000-0000-00000000000a'', ''in_progress'', '
           || '''in_progress'', ''unknown'', ''path'', false, null, ''00000000-0000-0000-0000-000107050001'', null, null, null)',
       '23505 course_attempts_one_in_progress_ctx_idx'),
      -- S on e1 holds an open legacy_role row (070014)
      ('S: an open Individual row beside the open preview',
       ins || '''00000000-0000-0000-0000-000107010006'', ''00000000-0000-0000-0000-00000000000a'', ''in_progress'', '
           || '''in_progress'', ''unknown'', ''individual'', false, null, null, null, null, null)',
       'ok'),
      ('S: an open course preview beside the open legacy_role row (N4)',
       ins || '''00000000-0000-0000-0000-000107010006'', ''00000000-0000-0000-0000-00000000000a'', ''in_progress'', '
           || '''in_progress'', ''unknown'', ''preview'', true, ''course'', null, null, null, null)',
       '23505 course_attempts_one_in_progress_ctx_idx'),
      -- P holds a pending Individual request on C2 (080003)
      ('P: a pending path request beside the pending Individual one',
       req || '''pending'', null, ''path'', ''00000000-0000-0000-0000-000107050001'')', 'ok'),
      ('P: a second pending Individual request',
       req || '''pending'', null, ''individual'', null)', '23505 attempt_requests_one_open_ctx_idx'),
      ('P: an approved, used Individual request (not open)',
       req || '''approved'', now(), ''individual'', null)', 'ok'),
      -- EJ holds a credit on day 1 (d1)
      ('EJ: a credit numbered 1 on another day (d3)',
       cred || '1, ''00000000-0000-0000-0000-000107061003'', ''00000000-0000-0000-0000-0000000000c1'')', 'ok'),
      ('EJ: a second credit on d1 under another number',
       cred || '3, ''00000000-0000-0000-0000-000107061001'', ''00000000-0000-0000-0000-0000000000c1'')',
       '23505 journey_day_progress_enrollment_id_day_id_key')
    ) as v(what, stmt, expected)
  loop
    select * into t from pg_temp.try_0107(r.stmt);
    if t.state || coalesce(' ' || nullif(t.con, ''), '') <> r.expected then
      bad := bad || format('%s: %s %s %s (expected %s)', r.what, t.state, coalesce(t.con, ''),
                           coalesce(t.msg, ''), r.expected);
    end if;
  end loop;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (9) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (10) the day_ids trigger at work (6a, note N6): it fills day_ids from
--      journey_days by (program, day number) when the insert gives none,
--      marked slot_backfill, for the service role and for an org admin's
--      session (security invoker under the journey_days policy); it keeps a
--      given map; a version with no days gets {}; a day without a
--      journey_days row (a missing number, a removed day, a day that is not
--      a number) refuses the insert with P0001 and a message neither schema
--      probe matches (note N7)
-- ---------------------------------------------------------------------------
do $$
declare
  bad   text[] := '{}';
  r     record;
  t     record;
  got   record;
  jp    constant uuid := '00000000-0000-0000-0000-000107060001';
  d1    constant text := '00000000-0000-0000-0000-000107061001';
  d2    constant text := '00000000-0000-0000-0000-000107061002';
  d3    constant text := '00000000-0000-0000-0000-000107061003';
  d4    constant text := '00000000-0000-0000-0000-000107061004';
  ins   constant text :=
    'insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, '
    || 'count_sundays, completion_title, days, day_ids, day_ids_source) values (';
begin
  -- day 5 of the program is removed (it keeps its row, without a number)
  update public.journey_days set removed_at = coalesce(removed_at, now()), day_number = null
   where id = '00000000-0000-0000-0000-000107061005';

  for r in
    select * from (values
      ('132003', 'a version of days 1, 2 and 4', jp, 3, '[{"day": 1}, {"day": 2}, {"day": 4}]', null::text, null::text,
       'ok', jsonb_build_object('1', d1, '2', d2, '4', d4), 'slot_backfill'),
      ('132004', 'a version that gives its day_ids', jp, 4, '[{"day": 1}]', '{"1": "' || d3 || '"}', 'editor',
       'ok', jsonb_build_object('1', d3), 'editor'),
      ('132005', 'a version with a day that has no journey_days row', jp, 5, '[{"day": 1}, {"day": 6}]', null, null,
       'P0001', null::jsonb, null),
      ('132006', 'a version with a removed day', jp, 6, '[{"day": 5}]', null, null,
       'P0001', null, null),
      ('132007', 'a version with a day that is not a number', jp, 7, '[{"day": "x"}]', null, null,
       'P0001', null, null),
      ('132008', 'a version with no days', '00000000-0000-0000-0000-000107060002'::uuid, 2, '[]', null, null,
       'ok', '{}'::jsonb, 'slot_backfill')
    ) as v(id, what, program_id, version_number, days, day_ids, source, expected, want, want_source)
  loop
    select * into t from pg_temp.try_0107(ins || format(
      '%L, %L, ''00000000-0000-0000-0000-00000000000a'', %s, ''Journey (0107 assert)'', 5, false, ''Yoddha'', '
      || '%L::jsonb, %L::jsonb, %L)',
      '00000000-0000-0000-0000-000107' || r.id, r.program_id, r.version_number, r.days, r.day_ids, r.source));
    if t.state <> r.expected then
      bad := bad || format('%s: %s %s (expected %s)', r.what, t.state, coalesce(t.msg, ''), r.expected);
    elsif t.state = 'P0001' and t.msg ~* 'schema cache|does not exist|could not find the' then
      bad := bad || format('%s: the message "%s" matches a schema probe (note N7)', r.what, t.msg);
    elsif t.state = 'ok' then
      select day_ids, day_ids_source into got from public.journey_versions
       where id = ('00000000-0000-0000-0000-000107' || r.id)::uuid;
      if got.day_ids is distinct from r.want or got.day_ids_source is distinct from r.want_source then
        bad := bad || format('%s: day_ids %s, source %s (expected %s, %s)', r.what, got.day_ids,
                             coalesce(got.day_ids_source, 'null'), r.want, r.want_source);
      end if;
    end if;
  end loop;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (10) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- the old publish: an org admin's session (S, admin of Org A) inserts a
-- version through the 0058 insert policy; the shim grants authenticated no
-- insert, so this transaction grants it, as the project defaults do
grant insert on public.journey_versions to authenticated;
select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-000107010006", "role": "authenticated"}', true);
set local role authenticated;
create temporary table r0107_admin_publish as
select t.state, t.msg, t.n
from pg_temp.try_0107(
  'insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, '
  || 'count_sundays, completion_title, days) values (''00000000-0000-0000-0000-000107132009'', '
  || '''00000000-0000-0000-0000-000107060001'', ''00000000-0000-0000-0000-00000000000a'', 9, ''Journey (0107 assert)'', '
  || '2, false, ''Yoddha'', ''[{"day": 1}, {"day": 2}]'')') as t;
reset role;

do $$
declare
  r record;
begin
  select * into r from pg_temp.r0107_admin_publish;
  if r.state <> 'ok' or r.n <> 1 then
    raise exception 'assert-0107: (10) an org admin''s publish: % % (expected ok, 1 row)', r.state, coalesce(r.msg, '');
  end if;
  if (select day_ids from public.journey_versions where id = '00000000-0000-0000-0000-000107132009')
     is distinct from jsonb_build_object('1', '00000000-0000-0000-0000-000107061001',
                                         '2', '00000000-0000-0000-0000-000107061002')
     or (select day_ids_source from public.journey_versions where id = '00000000-0000-0000-0000-000107132009')
     is distinct from 'slot_backfill' then
    raise exception 'assert-0107: (10) an org admin''s publish reads day_ids % (expected days 1 and 2 mapped, slot_backfill)',
      (select day_ids from public.journey_versions where id = '00000000-0000-0000-0000-000107132009');
  end if;
end
$$;

rollback;
