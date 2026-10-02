-- 0087: set-based overdue-learner count for the Attention Center.
--
-- The app previously computed "N learners overdue" by pulling course_assignments
-- (capped at 5000), expanding org/team rows to users in memory, then fetching
-- completions in a nested, capped (limit 10000) loop — which both UNDER-counted
-- (assignment truncation) and OVER-counted (completion truncation → learners who
-- passed reported as overdue), and issued many serial round-trips on the admin
-- landing page. This function does it correctly in one indexed, set-based query.
--
-- Overdue = a (learner, course) where the learner is an active member with a
-- past-due assignment (direct, org-wide, or via a team) and has NO completed or
-- passed attempt on any version of that course. Group assignments (0069) are
-- intentionally out of scope for this aggregate (matches the prior behaviour).
-- security definer so the service-role caller runs it; returns the count and the
-- latest breached due date (for the alert timestamp).

create or replace function public.attention_overdue_count(p_org uuid)
returns table (overdue_count integer, latest_due timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with expanded as (
    select ca.course_id, m.user_id, min(ca.due_at) as due_at
      from public.course_assignments ca
      join public.organization_members m
        on m.organization_id = ca.organization_id
       and m.status = 'active'
       and (
            ca.assignee_type = 'org'
         or (ca.assignee_type = 'user' and ca.user_id = m.user_id)
         or (ca.assignee_type = 'team' and exists (
               select 1 from public.team_members tm
                where tm.team_id = ca.team_id and tm.user_id = m.user_id))
       )
     where ca.organization_id = p_org
       and ca.due_at is not null
       and ca.due_at < now()
     group by ca.course_id, m.user_id
  ),
  outstanding as (
    select e.due_at
      from expanded e
     where not exists (
            select 1
              from public.course_attempts a
              join public.course_versions v on v.id = a.course_version_id
             where v.course_id = e.course_id
               and a.user_id = e.user_id
               and (a.completion_status = 'completed' or a.success_status = 'passed')
           )
  )
  select coalesce(count(*), 0)::int as overdue_count, max(due_at) as latest_due
    from outstanding;
$$;

revoke all on function public.attention_overdue_count(uuid) from public, anon, authenticated;
grant execute on function public.attention_overdue_count(uuid) to service_role;

notify pgrst, 'reload schema';
