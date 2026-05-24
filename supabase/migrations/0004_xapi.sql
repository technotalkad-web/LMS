-- Phase 4: xAPI / cmi5 launcher infrastructure.
-- Adds the LRS tables (statements, state) and the cmi5 token table for
-- the launch -> fetch -> auth exchange that cmi5 AUs use to authenticate
-- with our xAPI endpoints.

-- STATEMENTS ---------------------------------------------------------------
-- Append-only log of every xAPI statement. We keep the raw JSON so we can
-- replay it; the indexed columns are just for fast querying.
create table if not exists public.xapi_statements (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references public.course_attempts(id) on delete cascade,
  statement_id  uuid not null,
  verb          text not null,
  stored        timestamptz not null default now(),
  raw           jsonb not null,
  unique (attempt_id, statement_id)
);

create index if not exists xapi_statements_attempt_idx
  on public.xapi_statements(attempt_id);
create index if not exists xapi_statements_verb_idx
  on public.xapi_statements(verb);
create index if not exists xapi_statements_stored_idx
  on public.xapi_statements(stored desc);

-- ACTIVITY STATE -----------------------------------------------------------
-- Key-value documents the AU uses for its own private persistence
-- (analogous to SCORM 1.2's cmi.suspend_data, but richer).
create table if not exists public.xapi_state (
  attempt_id    uuid not null references public.course_attempts(id) on delete cascade,
  state_id      text not null,
  content       jsonb,
  content_type  text,
  updated_at    timestamptz not null default now(),
  primary key (attempt_id, state_id)
);

-- CMI5 LAUNCH TOKENS -------------------------------------------------------
-- One-time fetch token + the auth token the AU receives in exchange.
-- The fetch token is included in the launch URL; the AU calls /xapi/fetch
-- once with it to redeem the auth token, then includes Bearer <auth_token>
-- on every subsequent xAPI request.
create table if not exists public.cmi5_launch_tokens (
  fetch_token  uuid primary key default gen_random_uuid(),
  auth_token   text not null unique,
  attempt_id   uuid not null references public.course_attempts(id) on delete cascade,
  used_at      timestamptz,
  expires_at   timestamptz not null default (now() + interval '24 hours'),
  created_at   timestamptz not null default now()
);

create index if not exists cmi5_tokens_auth_idx
  on public.cmi5_launch_tokens(auth_token);
create index if not exists cmi5_tokens_attempt_idx
  on public.cmi5_launch_tokens(attempt_id);

-- RLS ----------------------------------------------------------------------
-- xAPI routes authenticate via Bearer token and use the service-role key,
-- so they bypass RLS by design. We still enable RLS so anon/auth users
-- can't poke at the tables through PostgREST without going through the
-- xAPI auth flow.
alter table public.xapi_statements enable row level security;
alter table public.xapi_state enable row level security;
alter table public.cmi5_launch_tokens enable row level security;

-- Members of an org can read their own attempts' statements via the UI.
drop policy if exists "members read own xapi statements" on public.xapi_statements;
create policy "members read own xapi statements"
  on public.xapi_statements for select
  using (
    exists (
      select 1 from public.course_attempts ca
      where ca.id = xapi_statements.attempt_id
        and ca.user_id = auth.uid()
    )
  );
