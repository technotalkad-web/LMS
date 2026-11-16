-- scripts/migration-rehearsal/seed-0112-0109.sql
-- Scenario "0107-0112-then-0107-then-0112", before 0112's last paste: a
-- stand-in for 0109 (ADR 0024 step 21), which no file of the repository
-- creates yet. 0112 refuses while public.v_individual_enrollment_status
-- exists (0109's refresh functions carry its views, which 0112's bodies
-- would strip; the note of 2026-11-16, S1), so a view of that name is enough
-- to prove the refusal. COMMITTED; repair-0112.sql drops it.
create view public.v_individual_enrollment_status as select 1 as stand_in_for_0109;
