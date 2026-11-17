-- scripts/migration-rehearsal/seed-0115.sql
-- The 0115 scenarios (ADR 0030, build prerequisites point 3): synthetic rows
-- only (example.test, fixed ids under 00000000-0115-4000-8000-), COMMITTED,
-- so that 0115's own after-check A5 has an active member and a row that
-- does not count to read as, and assert-0115.sql reads each person's session
-- over the tables of ADR 0030 section C.
--   O1 live: an active administrator (the control), an active learner, an
--      inactive and a suspended learner, an inactive administrator, a
--      suspended and an active super owner, an active and an inactive data
--      analyst, and person X (an active administrator here)
--   O2 live: an active administrator Y, and X's row, inactive
--   O3 deleted (deleted_at set): an active administrator, an active super
--      owner and an active data analyst
--   O4 scheduled for deletion and not deleted (stays open): an active
--      administrator
-- One course with one package and one subscription row in each; ratings by
-- the active and the inactive learner on O1's course, and by Y on O2's.
-- Every membership row is written with its status; nothing here relies on
-- a default.
insert into auth.users (id, email) values
  ('00000000-0115-4000-8000-000000000001', 'm01-admin@example.test'),
  ('00000000-0115-4000-8000-000000000002', 'm02-learner@example.test'),
  ('00000000-0115-4000-8000-000000000003', 'm03-inactive-learner@example.test'),
  ('00000000-0115-4000-8000-000000000004', 'm04-suspended-learner@example.test'),
  ('00000000-0115-4000-8000-000000000005', 'm05-inactive-admin@example.test'),
  ('00000000-0115-4000-8000-000000000006', 'm06-suspended-super-owner@example.test'),
  ('00000000-0115-4000-8000-000000000007', 'm07-super-owner@example.test'),
  ('00000000-0115-4000-8000-000000000008', 'm08-analyst@example.test'),
  ('00000000-0115-4000-8000-000000000009', 'm09-inactive-analyst@example.test'),
  ('00000000-0115-4000-8000-000000000010', 'm10-x@example.test'),
  ('00000000-0115-4000-8000-000000000011', 'm11-y@example.test'),
  ('00000000-0115-4000-8000-000000000012', 'm12-deleted-org-admin@example.test'),
  ('00000000-0115-4000-8000-000000000013', 'm13-scheduled-org-admin@example.test'),
  ('00000000-0115-4000-8000-000000000014', 'm14-deleted-org-super-owner@example.test'),
  ('00000000-0115-4000-8000-000000000015', 'm15-deleted-org-analyst@example.test');

insert into public.organizations (id, name, slug, scheduled_deletion_at, deleted_at) values
  ('00000000-0115-4000-8000-0000000000f1', 'Membership Live',      'm-live',      null,                      null),
  ('00000000-0115-4000-8000-0000000000f2', 'Membership Other',     'm-other',     null,                      null),
  ('00000000-0115-4000-8000-0000000000f3', 'Membership Deleted',   'm-deleted',   now() - interval '31 days', now() - interval '1 day'),
  ('00000000-0115-4000-8000-0000000000f4', 'Membership Scheduled', 'm-scheduled', now() + interval '20 days', null);

insert into public.organization_members (organization_id, user_id, role, status) values
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000001', 'admin',        'active'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000002', 'user',         'active'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000003', 'user',         'inactive'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000004', 'user',         'suspended'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000005', 'admin',        'inactive'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000006', 'super_owner',  'suspended'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000007', 'super_owner',  'active'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000008', 'data_analyst', 'active'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000009', 'data_analyst', 'inactive'),
  ('00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000010', 'admin',        'active'),
  ('00000000-0115-4000-8000-0000000000f2', '00000000-0115-4000-8000-000000000010', 'admin',        'inactive'),
  ('00000000-0115-4000-8000-0000000000f2', '00000000-0115-4000-8000-000000000011', 'admin',        'active'),
  ('00000000-0115-4000-8000-0000000000f3', '00000000-0115-4000-8000-000000000012', 'admin',        'active'),
  ('00000000-0115-4000-8000-0000000000f3', '00000000-0115-4000-8000-000000000014', 'super_owner',  'active'),
  ('00000000-0115-4000-8000-0000000000f3', '00000000-0115-4000-8000-000000000015', 'data_analyst', 'active'),
  ('00000000-0115-4000-8000-0000000000f4', '00000000-0115-4000-8000-000000000013', 'admin',        'active');

insert into public.tenant_subscriptions (organization_id) values
  ('00000000-0115-4000-8000-0000000000f1'), ('00000000-0115-4000-8000-0000000000f2'),
  ('00000000-0115-4000-8000-0000000000f3'), ('00000000-0115-4000-8000-0000000000f4');

insert into public.courses (id, organization_id, title, slug) values
  ('00000000-0115-4000-8000-0000000000c1', '00000000-0115-4000-8000-0000000000f1', 'Live course',      'm-live-course'),
  ('00000000-0115-4000-8000-0000000000c2', '00000000-0115-4000-8000-0000000000f2', 'Other course',     'm-other-course'),
  ('00000000-0115-4000-8000-0000000000c3', '00000000-0115-4000-8000-0000000000f3', 'Deleted course',   'm-deleted-course'),
  ('00000000-0115-4000-8000-0000000000c4', '00000000-0115-4000-8000-0000000000f4', 'Scheduled course', 'm-scheduled-course');

insert into public.course_packages (id, course_id, language, is_active) values
  ('00000000-0115-4000-8000-0000000000d1', '00000000-0115-4000-8000-0000000000c1', null, true),
  ('00000000-0115-4000-8000-0000000000d2', '00000000-0115-4000-8000-0000000000c2', null, true),
  ('00000000-0115-4000-8000-0000000000d3', '00000000-0115-4000-8000-0000000000c3', null, true),
  ('00000000-0115-4000-8000-0000000000d4', '00000000-0115-4000-8000-0000000000c4', null, true);

insert into public.course_ratings (id, user_id, course_id, rating) values
  ('00000000-0115-4000-8000-0000000000e1', '00000000-0115-4000-8000-000000000002', '00000000-0115-4000-8000-0000000000c1', 5),
  ('00000000-0115-4000-8000-0000000000e2', '00000000-0115-4000-8000-000000000003', '00000000-0115-4000-8000-0000000000c1', 2),
  ('00000000-0115-4000-8000-0000000000e3', '00000000-0115-4000-8000-000000000011', '00000000-0115-4000-8000-0000000000c2', 4);
