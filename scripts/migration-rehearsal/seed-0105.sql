-- scripts/migration-rehearsal/seed-0105.sql
-- Scenarios "0100-0103-0104-then-0105" and "0105-at-0104-no-0100": the
-- fixture of ADR 0020 step 4. Synthetic rows inside Org A of seed.sql, fixed
-- ids whose last group starts 000105, emails at example.test.
--
-- This file only DEFINES pg_temp.seed_0105(): assert-0105.sql calls it inside
-- its own transaction, which ends in ROLLBACK, so the rows never reach the
-- audit that follows (six more courses would add D04 rows to it) and the
-- audit stays identical to the scenario's end before 0105. A pg_temp function
-- lives in the session only; it creates nothing in public, auth or storage.
--
-- Learners L1 to L14 (…000105010001 to …000105010014): active Org A members,
-- except L13 (status inactive). L12 and L13 have business_vertical 'Retail'.
-- L6 joined 10 days ago and L11 60 days ago (the joined_within_days rule on
-- both sides of its 30-day cutoff); the others have no date_of_joining.
-- Teams: T1 (…000105020001) = {L7, L8}; T2 (…000105020002) = {L6, L11}.
-- Groups (…00010503000n):
--   G1 static, active: {L9, L10}
--   G2 dynamic, active, {"verticals": ["Retail"]}: {L12} (L13 is inactive)
--   G3 dynamic, active, {"team_ids": [T2], "joined_within_days": 30}: {L6}
--   G4 dynamic, active, system_key 'scope:Retail|', {"verticals": ["Retail"]}:
--      {L12} (the system group behind a vertical assignment, 0096)
--   G5 static, INACTIVE: {L14}
-- Courses C1 to C6 (…00010504000n).
-- Paths (…00010505000n):
--   P1 active, private: C1 step 1 (released), C3 step 2 (release_at tomorrow)
--   P2 active, private: C1, C2, C3 (released)
--   P3 INACTIVE: C4
--   P4 active, org_public, no assignment: C6 (release_at tomorrow)
-- Path assignments: L3, L4 and L5 on P1; L5 and L6 on P2; T1 on P2; G1 on P1;
--   L11 on P3.
-- Course assignments: L1 on C5 and on C6 (released); L2 on C5 (release_at
--   tomorrow); L4 on C1 and on C3 (released); G4 on C5 (released); G3 on C5
--   (release_at tomorrow); G5 on C5 (released).
create function pg_temp.seed_0105() returns void language sql as $$
  insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-0001050100' || lpad(n::text, 2, '0'))::uuid,
         'learner-0105-' || n || '@example.test'
  from generate_series(1, 14) n;

  insert into public.organization_members
    (organization_id, user_id, role, status, business_vertical, date_of_joining)
  select '00000000-0000-0000-0000-00000000000a',
         ('00000000-0000-0000-0000-0001050100' || lpad(n::text, 2, '0'))::uuid,
         'user',
         case when n = 13 then 'inactive' else 'active' end,
         case when n in (12, 13) then 'Retail' end,
         case n when 6 then (timezone('utc', now()) - interval '10 days')::date
                when 11 then (timezone('utc', now()) - interval '60 days')::date end
  from generate_series(1, 14) n;

  insert into public.teams (id, organization_id, name, slug) values
    ('00000000-0000-0000-0000-000105020001', '00000000-0000-0000-0000-00000000000a', 'Team 1 (0105)', 'team-1-0105'),
    ('00000000-0000-0000-0000-000105020002', '00000000-0000-0000-0000-00000000000a', 'Team 2 (0105)', 'team-2-0105');
  insert into public.team_members (team_id, user_id) values
    ('00000000-0000-0000-0000-000105020001', '00000000-0000-0000-0000-000105010007'),
    ('00000000-0000-0000-0000-000105020001', '00000000-0000-0000-0000-000105010008'),
    ('00000000-0000-0000-0000-000105020002', '00000000-0000-0000-0000-000105010006'),
    ('00000000-0000-0000-0000-000105020002', '00000000-0000-0000-0000-000105010011');

  insert into public.org_groups (id, organization_id, name, group_type, rules, is_active, system_key) values
    ('00000000-0000-0000-0000-000105030001', '00000000-0000-0000-0000-00000000000a', 'G1 static (0105)', 'static', null, true, null),
    ('00000000-0000-0000-0000-000105030002', '00000000-0000-0000-0000-00000000000a', 'G2 Retail (0105)', 'dynamic',
     '{"verticals": ["Retail"]}', true, null),
    ('00000000-0000-0000-0000-000105030003', '00000000-0000-0000-0000-00000000000a', 'G3 team 2 joined within 30 days (0105)', 'dynamic',
     '{"team_ids": ["00000000-0000-0000-0000-000105020002"], "joined_within_days": 30}', true, null),
    ('00000000-0000-0000-0000-000105030004', '00000000-0000-0000-0000-00000000000a', 'G4 vertical Retail (0105)', 'dynamic',
     '{"verticals": ["Retail"]}', true, 'scope:Retail|'),
    ('00000000-0000-0000-0000-000105030005', '00000000-0000-0000-0000-00000000000a', 'G5 inactive (0105)', 'static', null, false, null);
  insert into public.org_group_members (group_id, organization_id, user_id) values
    ('00000000-0000-0000-0000-000105030001', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000105010009'),
    ('00000000-0000-0000-0000-000105030001', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000105010010'),
    ('00000000-0000-0000-0000-000105030005', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000105010014');

  insert into public.courses (id, organization_id, title, slug)
  select ('00000000-0000-0000-0000-0001050400' || lpad(n::text, 2, '0'))::uuid,
         '00000000-0000-0000-0000-00000000000a', 'C' || n || ' (0105)', 'c' || n || '-0105'
  from generate_series(1, 6) n;

  insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility) values
    ('00000000-0000-0000-0000-000105050001', '00000000-0000-0000-0000-00000000000a', 'P1 (0105)', 'p1-0105', true, 'private'),
    ('00000000-0000-0000-0000-000105050002', '00000000-0000-0000-0000-00000000000a', 'P2 (0105)', 'p2-0105', true, 'private'),
    ('00000000-0000-0000-0000-000105050003', '00000000-0000-0000-0000-00000000000a', 'P3 inactive (0105)', 'p3-0105', false, 'private'),
    ('00000000-0000-0000-0000-000105050004', '00000000-0000-0000-0000-00000000000a', 'P4 org_public (0105)', 'p4-0105', true, 'org_public');
  insert into public.learning_path_courses (path_id, course_id, step_number, release_at) values
    ('00000000-0000-0000-0000-000105050001', '00000000-0000-0000-0000-000105040001', 1, null),
    ('00000000-0000-0000-0000-000105050001', '00000000-0000-0000-0000-000105040003', 2, now() + interval '1 day'),
    ('00000000-0000-0000-0000-000105050002', '00000000-0000-0000-0000-000105040001', 1, null),
    ('00000000-0000-0000-0000-000105050002', '00000000-0000-0000-0000-000105040002', 2, null),
    ('00000000-0000-0000-0000-000105050002', '00000000-0000-0000-0000-000105040003', 3, null),
    ('00000000-0000-0000-0000-000105050003', '00000000-0000-0000-0000-000105040004', 1, null),
    ('00000000-0000-0000-0000-000105050004', '00000000-0000-0000-0000-000105040006', 1, now() + interval '1 day');

  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id, team_id, group_id) values
    ('00000000-0000-0000-0000-000105070001', '00000000-0000-0000-0000-000105050001', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010003', null, null),
    ('00000000-0000-0000-0000-000105070002', '00000000-0000-0000-0000-000105050001', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010004', null, null),
    ('00000000-0000-0000-0000-000105070003', '00000000-0000-0000-0000-000105050001', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010005', null, null),
    ('00000000-0000-0000-0000-000105070004', '00000000-0000-0000-0000-000105050002', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010005', null, null),
    ('00000000-0000-0000-0000-000105070005', '00000000-0000-0000-0000-000105050002', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010006', null, null),
    ('00000000-0000-0000-0000-000105070006', '00000000-0000-0000-0000-000105050002', '00000000-0000-0000-0000-00000000000a', 'team', null, '00000000-0000-0000-0000-000105020001', null),
    ('00000000-0000-0000-0000-000105070007', '00000000-0000-0000-0000-000105050001', '00000000-0000-0000-0000-00000000000a', 'group', null, null, '00000000-0000-0000-0000-000105030001'),
    ('00000000-0000-0000-0000-000105070008', '00000000-0000-0000-0000-000105050003', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010011', null, null);

  insert into public.course_assignments (id, course_id, organization_id, assignee_type, user_id, team_id, group_id, release_at) values
    ('00000000-0000-0000-0000-000105060001', '00000000-0000-0000-0000-000105040005', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010001', null, null, null),
    ('00000000-0000-0000-0000-000105060002', '00000000-0000-0000-0000-000105040006', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010001', null, null, null),
    ('00000000-0000-0000-0000-000105060003', '00000000-0000-0000-0000-000105040005', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010002', null, null, now() + interval '1 day'),
    ('00000000-0000-0000-0000-000105060004', '00000000-0000-0000-0000-000105040001', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010004', null, null, null),
    ('00000000-0000-0000-0000-000105060005', '00000000-0000-0000-0000-000105040003', '00000000-0000-0000-0000-00000000000a', 'user', '00000000-0000-0000-0000-000105010004', null, null, null),
    ('00000000-0000-0000-0000-000105060006', '00000000-0000-0000-0000-000105040005', '00000000-0000-0000-0000-00000000000a', 'group', null, null, '00000000-0000-0000-0000-000105030004', null),
    ('00000000-0000-0000-0000-000105060007', '00000000-0000-0000-0000-000105040005', '00000000-0000-0000-0000-00000000000a', 'group', null, null, '00000000-0000-0000-0000-000105030003', now() + interval '1 day'),
    ('00000000-0000-0000-0000-000105060008', '00000000-0000-0000-0000-000105040005', '00000000-0000-0000-0000-00000000000a', 'group', null, null, '00000000-0000-0000-0000-000105030005', null);
$$;
