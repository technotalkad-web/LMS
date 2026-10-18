-- scripts/migration-rehearsal/shim-dashboard.sql
-- public.set_updated_at() was created in the Supabase dashboard before the
-- repository's migrations existed. No migration creates it, and
-- 0049_security_advisor_hardening.sql alters it, so a replay from the
-- repository alone stops at 0049 (scenario "no-dashboard-fn" proves it).
-- Production and staging have it; this file stands in for it.
create function public.set_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
