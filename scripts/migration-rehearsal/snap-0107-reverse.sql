-- scripts/migration-rehearsal/snap-0107-reverse.sql
-- Scenario "0107-0108-reverse-then-0107", before each paste of
-- ops/0107-reverse.sql (ADR 0024 steps 61 and 63): the rows of every base
-- table of public that the reverse keeps, counted and hashed with the
-- columns 0107 added left out, so assert-0107-reverse.sql can show that the
-- reverse wrote no row (its header: "Row writes: none") and changed no value
-- it keeps. The six tables 0107 creates are left out: the reverse drops
-- them. Kept in the session's temporary schema, never in public (the
-- fingerprint step reads public only); run again, it replaces both.
create or replace function pg_temp.rehearsal_0107_reverse_rows()
returns table (t text, n bigint, h text)
language plpgsql
as $f$
declare
  r      record;
  v_drop text[];
begin
  for r in
    select c.relname::text as relname
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'r'
       and c.relname not in ('preview_runs', 'context_derive_log', 'learning_path_completions',
                             'learning_path_step_completions', 'completion_notices', 'preview_purge_log')
     order by c.relname
  loop
    v_drop := case r.relname
      when 'course_attempts' then array['context_kind', 'context_key', 'journey_day_id', 'journey_version_id',
                                        'preview_kind', 'preview_run_id', 'settle_sig', 'side_effects_sig',
                                        'side_effects_at', 'webhook_skip_reason']
      when 'attempt_requests' then array['context_kind', 'context_key', 'learning_path_id', 'journey_enrollment_id',
                                         'journey_day', 'journey_day_id']
      when 'revision_visits' then array['context_key']
      when 'xp_events' then array['context_kind', 'context_key', 'event_only']
      when 'learning_path_courses' then array['pass_required']
      when 'journey_days' then array['pass_required', 'removed_at']
      when 'journey_versions' then array['day_ids', 'day_ids_source']
      when 'journey_day_progress' then array['day_id', 'credit_kind', 'recorded_by', 'late']
      when 'journey_enrollments' then array['source']
      when 'journey_programs' then array['visibility']
      when 'course_assignments' then array['source']
      when 'learning_path_assignments' then array['source']
      when 'org_api_keys' then array['contract_version', 'allow_contract_override']
      when 'org_integration_settings' then array['webhook_contexts']
      else '{}'::text[]
    end;
    t := r.relname;
    execute format(
      'select count(*), coalesce(md5(string_agg(j, ''|'' order by j)), '''') '
      || 'from (select (to_jsonb(x) - %L::text[])::text as j from public.%I x) s',
      v_drop, r.relname)
      into n, h;
    return next;
  end loop;
end
$f$;

drop table if exists pg_temp.rehearsal_0107_reverse_before;
create temporary table rehearsal_0107_reverse_before as
  select * from pg_temp.rehearsal_0107_reverse_rows();
