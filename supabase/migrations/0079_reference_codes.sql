-- 0079: human-readable reference codes for courses, learning paths and journeys.
--
--   Course / module   MOD0001, MOD0002, …
--   Learning path     PTH0001, …
--   Journey           JUR0001, …
--
-- Why: uuids are the internal ids everywhere (keys, URLs, attempts, LRS,
-- integrations) and stay exactly as they are. Admins, IT, reports and the
-- Yoddha/CRM integration also need an id a person can read, remember and
-- type. The code is one extra column, unique PER ORGANISATION, assigned by
-- a BEFORE INSERT trigger from a per-org counter, never changed afterwards.
-- Versions and language packages carry no column: their codes are derived
-- in the app (MOD0015-V03, MOD0015-HI-V02, MOD0015-HI).
--
-- Deploy order is free: the app reads the column fail-soft, so it works
-- before and after this migration; codes simply appear once it is applied.

alter table public.courses          add column if not exists reference_code text;
alter table public.learning_paths   add column if not exists reference_code text;
alter table public.journey_programs add column if not exists reference_code text;

-- Per-organisation counters, one row per prefix. The update is atomic, so
-- two admins creating at the same moment can never draw the same number.
create table if not exists public.org_reference_counters (
  organization_id uuid    not null references public.organizations(id) on delete cascade,
  prefix          text    not null,
  last_value      integer not null default 0,
  primary key (organization_id, prefix)
);
alter table public.org_reference_counters enable row level security;
-- No policies: the table is only ever touched by the definer function below.
-- Grants are explicit (Supabase stops auto-granting new relations from 2026-10-30).
grant select on public.org_reference_counters to authenticated, service_role;
grant insert, update, delete on public.org_reference_counters to service_role;

create or replace function public.next_reference_code(p_org uuid, p_prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v integer;
begin
  insert into public.org_reference_counters (organization_id, prefix, last_value)
  values (p_org, p_prefix, 1)
  on conflict (organization_id, prefix)
  do update set last_value = public.org_reference_counters.last_value + 1
  returning last_value into v;
  -- Four digits minimum; the number keeps growing past 9999 (MOD10000).
  return p_prefix || lpad(v::text, 4, '0');
end
$$;
grant execute on function public.next_reference_code(uuid, text) to authenticated, service_role;

-- BEFORE INSERT: fill the code. Any failure leaves it null rather than
-- blocking the create; a later run of the backfill below fills gaps.
create or replace function public.assign_reference_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reference_code is null or btrim(new.reference_code) = '' then
    begin
      new.reference_code := public.next_reference_code(new.organization_id, tg_argv[0]);
    exception when others then
      new.reference_code := null;
    end;
  end if;
  return new;
end
$$;

-- BEFORE UPDATE: once set, the code never changes (immutable by design).
create or replace function public.protect_reference_code()
returns trigger
language plpgsql
as $$
begin
  if old.reference_code is not null and new.reference_code is distinct from old.reference_code then
    new.reference_code := old.reference_code;
  end if;
  return new;
end
$$;

drop trigger if exists courses_assign_reference_code on public.courses;
create trigger courses_assign_reference_code
  before insert on public.courses
  for each row execute function public.assign_reference_code('MOD');
drop trigger if exists courses_protect_reference_code on public.courses;
create trigger courses_protect_reference_code
  before update on public.courses
  for each row execute function public.protect_reference_code();

drop trigger if exists learning_paths_assign_reference_code on public.learning_paths;
create trigger learning_paths_assign_reference_code
  before insert on public.learning_paths
  for each row execute function public.assign_reference_code('PTH');
drop trigger if exists learning_paths_protect_reference_code on public.learning_paths;
create trigger learning_paths_protect_reference_code
  before update on public.learning_paths
  for each row execute function public.protect_reference_code();

drop trigger if exists journey_programs_assign_reference_code on public.journey_programs;
create trigger journey_programs_assign_reference_code
  before insert on public.journey_programs
  for each row execute function public.assign_reference_code('JUR');
drop trigger if exists journey_programs_protect_reference_code on public.journey_programs;
create trigger journey_programs_protect_reference_code
  before update on public.journey_programs
  for each row execute function public.protect_reference_code();

-- Backfill existing rows in creation order, per organisation, through the
-- same counter so numbering stays continuous for everything created later.
do $$
declare
  r record;
begin
  for r in
    select id, organization_id from public.courses
    where reference_code is null
    order by organization_id, created_at, id
  loop
    update public.courses
       set reference_code = public.next_reference_code(r.organization_id, 'MOD')
     where id = r.id;
  end loop;

  for r in
    select id, organization_id from public.learning_paths
    where reference_code is null
    order by organization_id, created_at, id
  loop
    update public.learning_paths
       set reference_code = public.next_reference_code(r.organization_id, 'PTH')
     where id = r.id;
  end loop;

  for r in
    select id, organization_id from public.journey_programs
    where reference_code is null
    order by organization_id, created_at, id
  loop
    update public.journey_programs
       set reference_code = public.next_reference_code(r.organization_id, 'JUR')
     where id = r.id;
  end loop;
end
$$;

-- Unique per organisation (partial: a null from a failed assignment never collides).
create unique index if not exists courses_reference_code_uq
  on public.courses (organization_id, reference_code) where reference_code is not null;
create unique index if not exists learning_paths_reference_code_uq
  on public.learning_paths (organization_id, reference_code) where reference_code is not null;
create unique index if not exists journey_programs_reference_code_uq
  on public.journey_programs (organization_id, reference_code) where reference_code is not null;

notify pgrst, 'reload schema';
