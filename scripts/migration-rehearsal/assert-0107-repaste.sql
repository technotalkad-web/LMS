-- scripts/migration-rehearsal/assert-0107-repaste.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107", after the
-- SECOND paste of 0107: the rows seed-0107-repaste.sql wrote between the two
-- pastes are exactly as written (ADR 0024 steps 4 and 63: every backfill runs
-- once, inside the DO block that adds its column, so a re-paste never
-- touches a value the new code wrote). One transaction that ends in
-- ROLLBACK; every check raises 'assert-0107: (R…) …' on failure.
begin;

do $$
declare
  bad text[] := '{}';
  a   record;
  k   smallint;
begin
  -- (R1) the failed writer call: still unstamped, so still a sweep candidate
  select * into a from public.course_attempts where id = '00000000-0000-0000-0000-000107120001';
  if not found then
    bad := bad || 'r1 is missing'::text;
  elsif a.side_effects_sig is not null or a.side_effects_at is not null
        or not (a.completion_status = 'completed' and a.side_effects_sig is distinct from a.settle_sig) then
    bad := bad || format('r1 side_effects_sig %s, side_effects_at %s (expected both null: a sweep candidate)',
                         coalesce(a.side_effects_sig, 'null'), coalesce(a.side_effects_at::text, 'null'));
  end if;

  -- (R2) the held SCORM webhook: no marker, the stamp as the writer left it
  select * into a from public.course_attempts where id = '00000000-0000-0000-0000-000107120002';
  if not found then
    bad := bad || 'r2 is missing'::text;
  elsif a.webhook_skip_reason is not null or a.completion_webhook_at is not null
        or a.side_effects_sig is distinct from a.settle_sig then
    bad := bad || format('r2 webhook_skip_reason %s, completion_webhook_at %s, side_effects_sig %s, settle_sig %s (expected no marker, no latch, stamped)',
                         coalesce(a.webhook_skip_reason, 'null'), coalesce(a.completion_webhook_at::text, 'null'),
                         coalesce(a.side_effects_sig, 'null'), a.settle_sig);
  end if;

  -- (R3) the course Preview keeps its kind and its key
  select * into a from public.course_attempts where id = '00000000-0000-0000-0000-000107120003';
  if not found then
    bad := bad || 'r3 is missing'::text;
  elsif a.preview_kind is distinct from 'course' or a.context_kind <> 'preview' or a.context_key <> 'preview' then
    bad := bad || format('r3 reads %s / %s / %s (expected preview / course / preview)',
                         a.context_kind, coalesce(a.preview_kind, 'null'), a.context_key);
  end if;

  -- (R4) the self credit keeps its kind
  if (select credit_kind from public.journey_day_progress where id = '00000000-0000-0000-0000-000107120004')
     is distinct from 'self' then
    bad := bad || format('r4 credit_kind %s (expected self)',
                         coalesce((select credit_kind from public.journey_day_progress
                                    where id = '00000000-0000-0000-0000-000107120004'), 'missing'));
  end if;

  -- (R5) the key created after the first paste reads 2; the key from before
  -- it still reads 1; the default still reads 2
  select contract_version into k from public.org_api_keys where id = '00000000-0000-0000-0000-000107120005';
  if k is distinct from 2 then
    bad := bad || format('r5 contract_version %s (expected 2)', coalesce(k::text, 'missing'));
  end if;
  select contract_version into k from public.org_api_keys where id = '00000000-0000-0000-0000-000107100001';
  if k is distinct from 1 then
    bad := bad || format('the seeded key reads contract_version %s after the second paste (expected 1)', coalesce(k::text, 'missing'));
  end if;
  if (select pg_get_expr(d.adbin, d.adrelid)
        from pg_attrdef d
        join pg_attribute t on t.attrelid = d.adrelid and t.attnum = d.adnum
       where d.adrelid = 'public.org_api_keys'::regclass and t.attname = 'contract_version')
     is distinct from '2' then
    bad := bad || 'the default of org_api_keys.contract_version is not 2 after the second paste'::text;
  end if;

  -- (R6) the untagged insert between the pastes: labelled by the derive
  -- trigger, and its one firing still counted after the second paste (the
  -- log row is created once; a re-paste does not reset it)
  select * into a from public.course_attempts where id = '00000000-0000-0000-0000-000107120006';
  if not found then
    bad := bad || 'r6 is missing'::text;
  elsif a.context_kind <> 'individual' or a.context_key <> 'individual' or a.preview_kind is not null
        or a.journey_day_id is not null then
    bad := bad || format('r6 reads %s / %s / %s (expected individual / individual / null)',
                         a.context_kind, a.context_key, coalesce(a.preview_kind, 'null'));
  end if;
  if (select fired_count from public.context_derive_log) is distinct from 1
     or (select last_fired_at from public.context_derive_log) is null
     or (select count(*) from public.context_derive_log) <> 1 then
    bad := bad || format('context_derive_log reads %s row(s), fired_count %s, last_fired_at %s '
                         || '(expected one row, 1, set: r6 fired the derive trigger once)',
                         (select count(*) from public.context_derive_log),
                         coalesce((select fired_count::text from public.context_derive_log), 'none'),
                         coalesce((select last_fired_at::text from public.context_derive_log), 'null'));
  end if;

  -- (R7) the second paste re-created each trigger once, and left each
  -- attempt key on delete no action, once
  if (select count(*) from pg_trigger
       where not tgisinternal
         and tgname in ('course_attempts_context_immutable', 'course_attempts_context_derive',
                        'journey_versions_derive_day_ids')) <> 3 then
    bad := bad || 'the three triggers of 0107 are not present exactly once each'::text;
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'public.course_attempts'::regclass and contype = 'f'
         and confrelid in ('public.learning_paths'::regclass, 'public.journey_enrollments'::regclass)) <> 2
     or exists (select 1 from pg_constraint
                where conrelid = 'public.course_attempts'::regclass and contype = 'f'
                  and confrelid in ('public.learning_paths'::regclass, 'public.journey_enrollments'::regclass)
                  and confdeltype <> 'a') then
    bad := bad || 'the two attempt keys to learning_paths and journey_enrollments are not one each, on delete no action'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (R) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
