-- scripts/migration-rehearsal/repoint.sql
-- After 0098 refuses on the shared prefix: move the duplicate version to its
-- own package-scoped folder (ADR 0007 step 3; on production the objects are
-- copied first, per ops/release-v1.3.0-repoint.md). Synthetic row only.
update public.course_versions set storage_prefix = 'courses/c2/d3/v2/'
where id = '00000000-0000-0000-0000-0000000000e4';
