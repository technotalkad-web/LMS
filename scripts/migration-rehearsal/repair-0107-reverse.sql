-- scripts/migration-rehearsal/repair-0107-reverse.sql
-- Scenario "0107-0108-reverse-then-0107", after the refused first paste of
-- ops/0107-reverse.sql: the owner's reset of the staging rows part 1
-- counted (ADR 0024 step 61: "the owner purges or resets them first"; test
-- data), here the eight rows b1 to b8 of seed-0107-reverse.sql. The rows
-- k1 to k8 stay, for the reverse to keep or drop.
drop table public.report_refresh_log;
delete from public.course_attempts
 where id in ('00000000-0000-0000-0000-000107120001', '00000000-0000-0000-0000-000107120002');
delete from public.preview_runs where id = '00000000-0000-0000-0000-000107120003';
delete from public.journey_days where id = '00000000-0000-0000-0000-000107120004';
delete from public.journey_day_progress
 where id in ('00000000-0000-0000-0000-000107120005', '00000000-0000-0000-0000-000107120006');
delete from public.attempt_requests where id = '00000000-0000-0000-0000-000107120007';
delete from public.notification_templates where id = '00000000-0000-0000-0000-000107120008';
