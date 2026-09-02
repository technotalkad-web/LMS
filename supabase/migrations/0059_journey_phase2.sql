-- =============================================================================
-- Yoddha Journey Phase 2 — cohort reports, certificates, behind-schedule nudges
-- =============================================================================
--
--   - Nudges: a daily cron emails learners who fall behind (org-branded
--     pipeline, event 'journey_nudge', template admin-editable like every
--     other notification). Per-program admin knobs: on/off, how many days
--     behind triggers it, cooldown between nudges. last_nudged_at tracks
--     delivery per enrollment.
--   - Reports: journey_day_funnel() aggregates day-by-day completion counts
--     in the database (PostgREST can't GROUP BY) for the admin Reports tab;
--     invoker must be an org admin.
--   - Certificates need no schema: the completion page reads the pinned
--     version + enrollment (all Phase 1 tables).
--
-- DEPENDS ON: 0058 (journey tables) and 0014/0016 (notification templates).

-- ── 1) Nudge configuration + tracking ───────────────────────────────────────

alter table public.journey_programs
  add column if not exists nudge_enabled boolean not null default true,
  add column if not exists nudge_behind_days integer not null default 2
    check (nudge_behind_days between 1 and 30),
  add column if not exists nudge_cooldown_days integer not null default 3
    check (nudge_cooldown_days between 1 and 30);

alter table public.journey_enrollments
  add column if not exists last_nudged_at timestamptz;

-- ── 2) 'journey_nudge' joins the notification event catalog ─────────────────
-- House pattern (0015/0016/0025): re-assert the full event list + the new one
-- so admins can customize the nudge email like any other template.

alter table public.notification_templates
  drop constraint if exists notification_templates_event_type_check;
alter table public.notification_templates
  add constraint notification_templates_event_type_check
    check (event_type in (
      'account_creation',
      'asset_assignment',
      'asset_unassignment',
      'asset_completion',
      'asset_reminder',
      'asset_update',
      'custom_broadcast',
      'path_assignment',
      'path_unassignment',
      'path_completion',
      'password_reset',
      'magic_link',
      'account_invite',
      'journey_nudge'
    ));

-- ── 3) Day-by-day completion funnel for the admin Reports tab ───────────────
-- SECURITY DEFINER but self-guarded: the CALLER must be an admin of the
-- program's org (auth.uid() flows through). Returns one row per day number
-- with how many learners have completed that day — across all versions, so
-- the funnel survives republishing.

create or replace function public.journey_day_funnel(p_program_id uuid)
returns table (day_number integer, learners integer)
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  select organization_id into v_org
    from public.journey_programs where id = p_program_id;
  if v_org is null or not public.is_org_admin(v_org) then
    raise exception 'forbidden';
  end if;
  return query
    select p.day_number, count(distinct p.user_id)::int as learners
      from public.journey_day_progress p
      join public.journey_enrollments e on e.id = p.enrollment_id
     where e.program_id = p_program_id
     group by p.day_number
     order by p.day_number;
end;
$$;
revoke all on function public.journey_day_funnel(uuid) from public, anon;
grant execute on function public.journey_day_funnel(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
