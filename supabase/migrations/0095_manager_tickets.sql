-- 0095: support tickets raised from the Manager Report Card (Phase 4a — 2026-10-07).
--
-- Managers VIEW + ANALYSE + SUPPORT; admins act (approved addendum "Manager
-- Rights and Content Scope", decision 12). The three manager write actions
-- (grant retry, assign a course; send reminder stays) are withdrawn and
-- replaced by a ticket that carries the evidence: who, what content, which
-- exception. The admin acts from the ticket (grant / assign / extend / decline)
-- and the outcome is recorded on it.
--
-- help_tickets gains: source (learner | manager), category, context (jsonb:
-- user ids, content, exception, origin), requested_by_level, outcome fields.
-- help_ticket_messages is the two-way thread (today: one admin_note).
-- attempt_requests.source gains 'ticket' (a grant made from a ticket).
--
-- New relation → explicit grants (Supabase stops auto-granting 2026-10-30).
-- Idempotent.

alter table public.help_tickets
  add column if not exists source text not null default 'learner',
  add column if not exists category text,
  add column if not exists context jsonb,
  add column if not exists requested_by_level smallint,
  add column if not exists outcome text,
  add column if not exists outcome_at timestamptz,
  add column if not exists outcome_by uuid references auth.users(id) on delete set null;

alter table public.help_tickets drop constraint if exists help_tickets_source_check;
alter table public.help_tickets
  add constraint help_tickets_source_check check (source in ('learner', 'manager'));
alter table public.help_tickets drop constraint if exists help_tickets_category_check;
alter table public.help_tickets
  add constraint help_tickets_category_check
  check (category is null or category in ('grant_retry', 'assign_content', 'extend_due', 'content_issue', 'other'));
alter table public.help_tickets drop constraint if exists help_tickets_outcome_check;
alter table public.help_tickets
  add constraint help_tickets_outcome_check
  check (outcome is null or outcome in ('granted', 'assigned', 'extended', 'declined', 'resolved'));

create index if not exists help_tickets_org_source_status_idx
  on public.help_tickets (organization_id, source, status, created_at desc);

comment on column public.help_tickets.source is 'learner = raised from Help & Support; manager = raised from the Manager Report Card with context (0095).';
comment on column public.help_tickets.context is 'Manager ticket context: { userIds[], contentKind, contentId, contentTitle, exception, origin, dueAt } — ids were verified against the manager''s hierarchy at creation (0095).';
comment on column public.help_tickets.outcome is 'What the admin did from the ticket: granted | assigned | extended | declined | resolved (0095).';

-- A member may insert their OWN learner ticket directly (Help & Support).
-- Manager tickets carry verified context and are written by the API on the
-- service role only — nobody can forge one through the Data API.
drop policy if exists "users insert own tickets" on public.help_tickets;
create policy "users insert own tickets"
  on public.help_tickets for insert
  with check (
    user_id = auth.uid()
    and public.is_org_member(organization_id)
    and source = 'learner'
    and category is null
    and context is null
    and requested_by_level is null
    and outcome is null
  );

-- Two-way thread ------------------------------------------------------------
create table if not exists public.help_ticket_messages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ticket_id       uuid not null references public.help_tickets(id) on delete cascade,
  author_id       uuid not null references auth.users(id) on delete cascade,
  author_role     text not null check (author_role in ('requester', 'admin')),
  body            text not null,
  created_at      timestamptz not null default now()
);

create index if not exists help_ticket_messages_ticket_idx
  on public.help_ticket_messages (ticket_id, created_at);

alter table public.help_ticket_messages enable row level security;

drop policy if exists "ticket parties read messages" on public.help_ticket_messages;
create policy "ticket parties read messages"
  on public.help_ticket_messages for select
  using (
    public.is_org_admin(organization_id)
    or exists (
      select 1 from public.help_tickets t
      where t.id = help_ticket_messages.ticket_id and t.user_id = auth.uid()
    )
  );

drop policy if exists "ticket parties write messages" on public.help_ticket_messages;
create policy "ticket parties write messages"
  on public.help_ticket_messages for insert
  with check (
    author_id = auth.uid()
    -- the row's org must be the ticket's org, and the role must match the caller
    and exists (
      select 1 from public.help_tickets t
      where t.id = help_ticket_messages.ticket_id
        and t.organization_id = help_ticket_messages.organization_id
        and (
          (author_role = 'admin' and public.is_org_admin(t.organization_id))
          or (author_role = 'requester' and t.user_id = auth.uid())
        )
    )
  );

-- Replies go through /api/tickets/[id]/messages (service role); the browser only reads.
grant select on public.help_ticket_messages to authenticated;
grant select, insert, update, delete on public.help_ticket_messages to service_role;
-- help_tickets predates the explicit-grants rule; make its grants explicit too.
grant select, insert, update, delete on public.help_tickets to authenticated;
grant select, insert, update, delete on public.help_tickets to service_role;

comment on table public.help_ticket_messages is
  'Thread on a help ticket: requester (learner or manager) and admin replies (0095).';

-- A grant made by an admin from a manager ticket ---------------------------
alter table public.attempt_requests
  drop constraint if exists attempt_requests_source_check;
alter table public.attempt_requests
  add constraint attempt_requests_source_check
  check (source in ('request', 'bulk', 'manager', 'ticket'));
comment on column public.attempt_requests.source is
  'request = learner asked; bulk = admin bulk grant; manager = legacy Phase 1 manager grant (withdrawn 0095); ticket = admin granted from a manager''s support ticket (0095).';

notify pgrst, 'reload schema';
