-- scripts/migration-rehearsal/repair-0112.sql
-- After each refused paste of 0112 or of ops/0112-reverse.sql in the
-- scenarios "0107-then-0112" and "0107-0112-then-0107-then-0112": drops the
-- stand-in for 0109 that seed-0112-0109.sql made, if it is there. After the
-- refusals that are not about 0109 (0112 before 0107, the 0112 reverse on a
-- database without 0107) it finds nothing and changes nothing.
drop view if exists public.v_individual_enrollment_status;
