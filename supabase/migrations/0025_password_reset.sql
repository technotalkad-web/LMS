-- Password-reset OTP flow.
--
-- Custom 6-digit code flow (instead of Supabase magic links) because
-- enterprise email scanners often consume the magic link before the
-- human can click it, invalidating the token. A 6-digit code is
-- copy-pasted by the user, surviving any URL pre-fetch.
--
-- Lifecycle:
--   1. /api/auth/forgot-password/request inserts a row (or replaces
--      the active one for the same email) with hashed code + 10-min
--      expiry.
--   2. /api/auth/forgot-password/verify looks up the row and runs a
--      constant-time hash compare. Attempts are tracked; after 5
--      wrong guesses the row is locked.
--   3. /api/auth/forgot-password/reset re-verifies the code, sets a
--      new password via service-role admin API, marks the row used.
--
-- We hash the code (sha-256) before storing — server reads back
-- the hash for comparison, never the plain code, so a DB dump
-- doesn't leak any usable codes.

create table if not exists public.password_reset_otps (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null,
  code_hash           text not null,
  expires_at          timestamptz not null,
  attempts            integer not null default 0,
  used_at             timestamptz,
  -- After a successful /verify the row gets stamped with a single-use
  -- reset-token hash. /reset checks this instead of the OTP again so
  -- the user can't be forced to re-enter the code on the password page.
  reset_token_hash    text,
  reset_token_expires timestamptz,
  ip                  text,
  user_agent          text,
  created_at          timestamptz not null default now()
);

-- One active code per email at a time; new request invalidates the old.
create index if not exists password_reset_otps_email_active_idx
  on public.password_reset_otps(email, expires_at)
  where used_at is null;

-- Rate-limit lookup: how many requests for this email in the last hour.
create index if not exists password_reset_otps_email_created_idx
  on public.password_reset_otps(email, created_at desc);

alter table public.password_reset_otps enable row level security;

-- No one reads/writes this table directly via RLS — only the
-- service-role API touches it. Lock everything down.
drop policy if exists "no direct access to otps" on public.password_reset_otps;
create policy "no direct access to otps"
  on public.password_reset_otps for all
  using (false)
  with check (false);

-- Extend the notification_templates event_type CHECK to include the
-- new 'password_reset' event so admins can override the default copy.
alter table public.notification_templates
  drop constraint if exists notification_templates_event_type_check;
alter table public.notification_templates
  add constraint notification_templates_event_type_check
    check (event_type in (
      'account_creation',
      'asset_assignment',
      'asset_unassignment',
      'asset_completion',
      'asset_reminder',
      'asset_update',
      'custom_broadcast',
      'path_assignment',
      'path_unassignment',
      'path_completion',
      'password_reset'
    ));

notify pgrst, 'reload schema';
