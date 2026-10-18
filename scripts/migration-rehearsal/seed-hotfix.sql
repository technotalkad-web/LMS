-- scripts/migration-rehearsal/seed-hotfix.sql
-- Synthetic. Scenario "hotfix" (0032 already applied out of band): per-package
-- version numbers make a course-level duplicate pair possible once the legacy
-- per-course constraint is gone (C03 reads 1, C04 stays 0).
insert into public.course_packages (id, course_id, language, is_active) values
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000c2', 'mr', true);
insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data) values
  ('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d5', 1, 'scorm12', 'index.html', 'courses/c2/d5/v1/', '{"title":"Beta mr"}');
