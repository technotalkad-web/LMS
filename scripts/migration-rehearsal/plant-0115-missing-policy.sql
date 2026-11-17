-- scripts/migration-rehearsal/plant-0115-missing-policy.sql
-- Scenario 0115-missing-policy (ADR 0030 build prerequisites point 3): a
-- base with one of the seven policies 0115 alters absent. 0115 alters
-- policies and never creates one, so its section 0c must refuse the paste
-- and change nothing (the scenario compares schema public with its
-- fingerprint from before the paste).
drop policy "org members read packages" on public.course_packages;
