-- scripts/migration-rehearsal/plant-0115-enrollments-rls-off.sql
-- Scenario 0115-hand-made-off-list, last stage (ADR 0030, note "Hand-made
-- databases, 2026-11-18"): row security turned off on the stand-in
-- public.enrollments. The legacy policy is then not in force and the table
-- answers by its grants whatever 0115 does; the before-check's DROPS row
-- says so (a finding of its own for the owner), and the paste goes through.
-- On Supabase a table made by hand usually holds write grants too (default
-- privileges), so authenticated gets update and delete here; anon does not,
-- so B12 must read each role apart. B12 then reads "granted" for a write:
-- update through has_any_column_privilege, delete through has_table_privilege.
alter table public.enrollments disable row level security;
grant update, delete on public.enrollments to authenticated;
