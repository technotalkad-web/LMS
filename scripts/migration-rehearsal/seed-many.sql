-- scripts/migration-rehearsal/seed-many.sql
-- Synthetic. Scenario "many": 1,001 more courses in org A, so D04 lists more
-- than 999 rows (its row numbers have five digits: D04.01003 must appear and
-- no two rows may share a check id). The plan quota trigger (25 courses) is
-- skipped for this seed only.
set session_replication_role = replica;
insert into public.courses (id, organization_id, title, slug)
select gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', 'Bulk ' || g, 'bulk-' || g
from generate_series(1, 1001) g;
set session_replication_role = origin;
