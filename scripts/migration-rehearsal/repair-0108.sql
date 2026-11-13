-- scripts/migration-rehearsal/repair-0108.sql
-- Scenario "0107-then-0108", after 0108's refused first paste: what 24
-- quiet hours and the phase 2 publish do on staging (ADR 0024 step 20). The
-- last firing of the derive trigger is moved 25 hours back (its count is
-- kept), and the version seed-0108.sql left without day_ids gets its map
-- again (the empty program's version has no days: {}).
update public.context_derive_log set last_fired_at = last_fired_at - interval '25 hours' where id;
update public.journey_versions set day_ids = '{}'::jsonb where id = '00000000-0000-0000-0000-000107062003';
