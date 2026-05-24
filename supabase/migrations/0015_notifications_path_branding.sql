-- Phase 9.1: learning path events, global pause switch, HTML branding.

-- 1) Replace the event_type check constraint to add path_* events ---------
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
      'custom_broadcast',
      'path_assignment',
      'path_unassignment',
      'path_completion'
    ));

-- 2) Pause flags + branding on notification_settings ---------------------
alter table public.notification_settings
  add column if not exists email_paused boolean not null default false,
  add column if not exists event_paused jsonb not null default '{}'::jsonb,
  add column if not exists logo_url     text,
  add column if not exists brand_color  text default '#1a1816',
  add column if not exists footer_text  text;

-- 3) Per-template CTA button label ---------------------------------------
alter table public.notification_templates
  add column if not exists cta_label text;

notify pgrst, 'reload schema';
