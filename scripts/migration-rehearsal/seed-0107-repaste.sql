-- scripts/migration-rehearsal/seed-0107-repaste.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107": rows the
-- new code could write between the first and the second paste of 0107 (ADR
-- 0024 step 63: "the second paste changes nothing, proved on rows the new
-- code could have written"). COMMITTED, because the second paste must meet
-- them; assert-0107-repaste.sql reads them after it. Every id's last group
-- starts 000107120. Each row holds a value that a backfill of 0107 would
-- overwrite if it ran again:
--   r1  a completed row whose writer call failed: side_effects_sig null (the
--       side_effects backfill, 1j, would stamp it; it must stay a sweep
--       candidate)
--   r2  a completed SCORM 1.2 row whose webhook is held: handled by the
--       writer, completion_webhook_at null and webhook_skip_reason null (the
--       pre_0107 backfill, 1k, would mark it never sending)
--   r3  a Preview of one course, preview_kind 'course' (the preview_kind
--       backfill, 1f, would relabel it legacy_role; step 63's purge case (9))
--   r4  a self credit of phase G, with no attempt (the credit_kind backfill,
--       1s, would relabel it legacy_cross_context)
--   r5  an API key created after the first paste, which takes the column
--       default 2 (the run-once block, 1t, would leave it alone; only the
--       keys from before the first paste read 1)
--   r6  an attempt inserted by the code before phase 2, which names no
--       context_kind: the paste-window derive trigger (2c) labels it
--       individual and counts one firing in context_derive_log (2a), which
--       the second paste must keep (its row is created once). It is
--       abandoned, so it holds no open-row slot and no completion.
-- r1 to r3 name context_kind, as the new code does, so they fire nothing.

insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score,
   started_at, completed_at, context_kind, is_preview, preview_kind, launch_mode)
values
  -- r1: P, Individual, cmi5 (C2)
  ('00000000-0000-0000-0000-000107120001', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010002',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
   now() - interval '1 hour', now() - interval '30 minutes', 'individual', false, null, 'Normal'),
  -- r2: I, Individual, SCORM 1.2 (K)
  ('00000000-0000-0000-0000-000107120002', '00000000-0000-0000-0000-000107040201', '00000000-0000-0000-0000-000107010001',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 1.0,
   now() - interval '1 hour', now() - interval '20 minutes', 'individual', false, null, 'Normal'),
  -- r3: S, a Preview of C2
  ('00000000-0000-0000-0000-000107120003', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010006',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
   now() - interval '1 hour', now() - interval '10 minutes', 'preview', true, 'course', 'Normal');

-- r2 was handled by the writer: its settled state is stamped, its webhook
-- is not sent yet
update public.course_attempts
   set side_effects_sig = settle_sig, side_effects_at = now() - interval '20 minutes'
 where id = '00000000-0000-0000-0000-000107120002';

-- r4: B's completed enrolment EB, day 4 (no credit there yet)
insert into public.journey_day_progress
  (id, enrollment_id, organization_id, user_id, day_number, day_id, course_id, attempt_id, completed_at, credit_kind)
values
  ('00000000-0000-0000-0000-000107120004', '00000000-0000-0000-0000-000107063003', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010003', 4, '00000000-0000-0000-0000-000107061004', '00000000-0000-0000-0000-000107040001',
   null, now() - interval '5 minutes', 'self');

-- r6: O, an untagged insert of the code before phase 2 (no context_kind)
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status, started_at)
values
  ('00000000-0000-0000-0000-000107120006', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010005',
   '00000000-0000-0000-0000-00000000000a', 'abandoned', 'in_progress', 'unknown', now() - interval '2 hours');

-- r5: a key of Org A created after the first paste, naming no contract_version
insert into public.org_api_keys (id, organization_id, name, key_prefix, key_hash, created_by) values
  ('00000000-0000-0000-0000-000107120005', '00000000-0000-0000-0000-00000000000a', 'CRM key after the paste (0107)', 'ambk_0107cd',
   'seed-0107-key-hash-2', '00000000-0000-0000-0000-0000000000a2');
