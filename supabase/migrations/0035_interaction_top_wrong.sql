-- §4.3 — Per-question breakdown: most common wrong answers.
--
-- Migration 0031 (#175) shipped mv_course_interaction_breakdown which
-- gives us correct vs incorrect counts per (course_id, interaction_id),
-- closing half of §4.3. The other half — "what wrong answer do learners
-- pick most often" — needs a separate aggregation because the existing
-- matview groups by interaction only, not by response value.
--
-- This migration adds a companion matview that ranks wrong responses
-- by frequency within each (course_id, interaction_id) tuple and keeps
-- the top 3. The reports UI joins it with the existing breakdown to
-- render a per-question table.
--
-- Why top 3 and not just top 1: free-text and "select-all-that-apply"
-- questions often distribute wrong answers across several near-equal
-- distractors; surfacing the second and third most common helps admins
-- spot ambiguous wording. Top 3 is also small enough to cache cheaply.

begin;

create materialized view if not exists public.mv_course_interaction_top_wrong as
with wrong_responses as (
  select
    cv.course_id,
    s.raw->'object'->>'id'       as interaction_id,
    s.raw->'result'->>'response' as response
  from public.xapi_statements s
  join public.course_attempts ca on ca.id = s.attempt_id
  join public.course_versions cv on cv.id = ca.course_version_id
  where s.verb in (
    'http://adlnet.gov/expapi/verbs/answered',
    'answered'
  )
    and s.raw->'object'->>'id' is not null
    -- success must be explicitly false. NULL / missing means the AU
    -- didn't report pass/fail (e.g. open-ended), so we can't classify.
    and (s.raw->'result'->>'success')::boolean is false
    and s.raw->'result'->>'response' is not null
    and length(s.raw->'result'->>'response') > 0
),
counted as (
  select
    course_id,
    interaction_id,
    response,
    count(*) as freq
  from wrong_responses
  group by course_id, interaction_id, response
),
ranked as (
  select
    course_id,
    interaction_id,
    response,
    freq,
    row_number() over (
      partition by course_id, interaction_id
      order by freq desc, response asc
    ) as rank
  from counted
)
select
  course_id,
  interaction_id,
  rank,
  response,
  freq,
  now() as refreshed_at
from ranked
where rank <= 3;

-- Unique index for REFRESH CONCURRENTLY support.
create unique index if not exists mv_course_interaction_top_wrong_idx
  on public.mv_course_interaction_top_wrong (course_id, interaction_id, rank);

-- ============================================================================
-- Register the new matview in the nightly refresh function.
-- ============================================================================
-- We replace the function definition with the updated array. The function
-- body is otherwise identical to migration 0031 — same loop, same return
-- shape — so no callers need to change.
create or replace function public.refresh_report_views()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb := '[]'::jsonb;
  view_name text;
  t0 timestamptz;
  rowcount bigint;
  ms numeric;
  err text;
begin
  foreach view_name in array array[
    'mv_course_enrollment_status',
    'mv_path_enrollment_status',
    'mv_course_performance',
    'mv_path_performance',
    'mv_course_interaction_breakdown',
    'mv_course_interaction_top_wrong'
  ]
  loop
    t0 := clock_timestamp();
    err := null;
    rowcount := null;
    begin
      execute format('refresh materialized view concurrently public.%I', view_name);
      execute format('select count(*) from public.%I', view_name) into rowcount;
    exception when others then
      err := sqlerrm;
    end;
    ms := extract(milliseconds from (clock_timestamp() - t0));
    result := result || jsonb_build_object(
      'view', view_name,
      'ms', ms,
      'rows', rowcount,
      'error', err
    );
  end loop;
  return result;
end;
$$;

notify pgrst, 'reload schema';

commit;
