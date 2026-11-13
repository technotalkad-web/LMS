-- scripts/migration-rehearsal/repair-0107-q2.sql
-- Scenario "0107-refused-q2", after the refusal: the owner resets the
-- orphaned journey row before the paste (ADR 0024 step 73; staging is test
-- data). Here the row is deleted. Q2 then reads 0 and 0107 applies.
delete from public.course_attempts where id = '00000000-0000-0000-0000-000107078001';
