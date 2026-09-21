-- 0076: standalone xAPI / TinCan packages (tincan.xml).
--
-- course_versions.manifest_type was constrained to scorm12 | cmi5. Packages
-- that ship a tincan.xml descriptor (Articulate, Captivate, iSpring, KIVO in
-- "LMS-provided xAPI" mode) are launched with endpoint/auth/actor/activity_id/
-- registration on the URL and reuse the cmi5 statement + State API routes,
-- so the only schema change is admitting the new type.
--
-- Hand-apply in the Supabase SQL editor (staging, then prod). Idempotent.

do $$
declare
  cname text;
begin
  select conname
    into cname
    from pg_constraint
   where conrelid = 'public.course_versions'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%manifest_type%';
  if cname is not null then
    execute format('alter table public.course_versions drop constraint %I', cname);
  end if;
end $$;

alter table public.course_versions
  add constraint course_versions_manifest_type_check
  check (manifest_type in ('scorm12', 'cmi5', 'xapi'));

notify pgrst, 'reload schema';
