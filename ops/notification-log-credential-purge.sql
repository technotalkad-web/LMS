-- ops/notification-log-credential-purge.sql: removes from the rows already in
-- public.notification_log every context key the application no longer
-- stores. Sign-in links, reset codes and passwords are never stored in the
-- notification log; from this change on the application keeps only the keys
-- in STORED_CONTEXT_KEYS (lib/notifications/send.ts), and this script brings
-- the older rows to the same shape.
--
-- WHO AND WHERE: owner-run. Staging first, then production with the owner's
-- approval, after the release that carries the application change is live
-- (rows written before it still hold the old context). Hand-apply in the
-- Supabase dashboard SQL editor with the role selector on postgres; never
-- `supabase db push` and never the Supabase CLI (the CLI is linked to
-- production).
--
-- HOW: three parts, each ONE statement. The editor shows the grid of the
-- last statement it ran, so select the text of one part, press Run, read its
-- grid, then go on to the next part.
--   Part 1 (read only): one grid of labelled counts. Keep a copy before
--     Part 2: the account counts cannot be taken again once Part 2 has run.
--   Part 2 (the change): rewrites the context of the counted rows to the
--     stored keys only (an object with none of them becomes {}) and prints
--     how many rows it rewrote. One statement is one transaction: it rewrites
--     every counted row or none. Run it only when the Part 1 numbers are what
--     you expect; running it is the commit. From psql instead, the same text
--     can sit between `begin;` and Part 3, followed by `commit;` or
--     `rollback;`.
--   Part 3 (read only): the after-check; must print 0.
--
-- IDEMPOTENT: a second run of Part 2 finds no row with another key and
-- rewrites none. It changes no other column: subject, error, status,
-- to_address, to_user_id and sent_at stay as they are, and no row is
-- deleted. A context that is null or not a JSON object is left alone. Part 1
-- never selects a context value, a subject or an address: counts only.
--
-- WHAT IT CANNOT UNDO:
--   - A password that reached the log stays valid until its account changes
--     it: a temporary password until the first sign-in, a password an admin
--     typed or a CSV carried until the person changes it. Part 1 reports the
--     affected accounts by count only (and how many still carry the
--     must-change-password flag). Whether to force a reset for them is the
--     owner's decision; this script does not do it.
--   - Reset codes expire after 10 minutes and sign-in links are single use
--     and short lived, so old ones are reported by count only.
--   - Subjects are not changed by this script. Part 1 counts the rows of the
--     sign-in and account events whose subject holds a token_hash, and the
--     password-reset rows whose subject holds six digits in a row.
--   - A password or link named in a custom subject. An organisation's own
--     template (notification_templates) can name a credential placeholder
--     ({Password}, {OTP_Code}, {Direct_Link} or {Portal_URL}) in its
--     subject, and older rows sent with it hold that value in the subject.
--     Part 1 counts the custom subjects that name one today (active or not)
--     and the log rows of those organisations and events. A template can
--     have changed since a row was sent, so the row figure is an
--     indication, not an exact count. Passwords found this way belong to
--     the accounts counted in section 3.
--
-- The key list appears in each statement, marked /* stored keys */.
-- tests/unit/notification-context-keys.test.ts checks every copy against
-- STORED_CONTEXT_KEYS. The credential keys Part 1 looks for in custom
-- subjects are marked /* credential keys */, and the same test checks that
-- list against its own list of credential keys.

-- ======================================================================
-- Part 1: counts only (one grid)
-- ======================================================================

with other_keys as (
  select l.event_type
  from public.notification_log l
  where case
          when jsonb_typeof(l.context) = 'object' then exists (
            select 1 from jsonb_object_keys(l.context) k
            where k <> all (/* stored keys */ array['course_id', 'course_name', 'path_id', 'path_name', 'journey_name', 'org_name', 'due_date', 'deadline_date', 'score', 'otp_minutes'])
          )
          else false
        end
),
password_rows as (
  select l.to_user_id, p.must_change_password
  from public.notification_log l
  left join public.profiles p on p.id = l.to_user_id
  where jsonb_typeof(l.context) = 'object'
    and l.context ? 'password'
),
credential_subjects as (
  select t.organization_id, t.event_type
  from public.notification_templates t
  where exists (
    select 1
    from unnest(/* credential keys */ array['password', 'otp_code', 'direct_link', 'portal_url']) as c(key_name)
    where strpos(lower(t.subject), '{' || c.key_name || '}') > 0
  )
)
select '1 rows to rewrite, total' as measure, count(*) as n from other_keys
union all
select '1 rows to rewrite, event ' || event_type, count(*) from other_keys group by event_type
union all
select '2 rows holding key ' || k.key_name, count(*)
from public.notification_log l
cross join lateral (values ('password'), ('otp_code'), ('direct_link'), ('portal_url')) as k(key_name)
where jsonb_typeof(l.context) = 'object'
  and l.context ? k.key_name
group by k.key_name
union all
select '3 rows holding a password', count(*) from password_rows
union all
select '3 accounts whose password reached the log', count(distinct to_user_id) from password_rows
union all
select '3 of those, still flagged must change password', count(distinct to_user_id) filter (where must_change_password) from password_rows
union all
select '4 subjects to review, event ' || l.event_type, count(*)
from public.notification_log l
where l.event_type in ('password_reset', 'magic_link', 'account_invite', 'account_creation')
  and (
    l.subject ilike '%token_hash%'
    or (l.event_type = 'password_reset' and l.subject ~ '[0-9]{6}')
  )
group by l.event_type
union all
select '5 custom subjects naming a credential placeholder', count(*) from credential_subjects
union all
select '5 log rows of those organisations and events', count(*)
from public.notification_log l
join credential_subjects cs
  on cs.organization_id = l.organization_id
 and cs.event_type = l.event_type
order by measure;

-- ======================================================================
-- Part 2: rewrite the context to the stored keys (one statement)
-- ======================================================================

with scrubbed as (
  update public.notification_log l
     set context = coalesce(
           (select jsonb_object_agg(e.key, e.value)
              from jsonb_each(l.context) e
             where e.key = any (/* stored keys */ array['course_id', 'course_name', 'path_id', 'path_name', 'journey_name', 'org_name', 'due_date', 'deadline_date', 'score', 'otp_minutes'])),
           '{}'::jsonb)
   where case
           when jsonb_typeof(l.context) = 'object' then exists (
             select 1 from jsonb_object_keys(l.context) k
             where k <> all (/* stored keys */ array['course_id', 'course_name', 'path_id', 'path_name', 'journey_name', 'org_name', 'due_date', 'deadline_date', 'score', 'otp_minutes'])
           )
           else false
         end
  returning 1
)
select count(*) as rows_rewritten from scrubbed;

-- ======================================================================
-- Part 3: after-check, must be 0
-- ======================================================================

select count(*) as rows_still_holding_other_keys
from public.notification_log l
where case
        when jsonb_typeof(l.context) = 'object' then exists (
          select 1 from jsonb_object_keys(l.context) k
          where k <> all (/* stored keys */ array['course_id', 'course_name', 'path_id', 'path_name', 'journey_name', 'org_name', 'due_date', 'deadline_date', 'score', 'otp_minutes'])
        )
        else false
      end;
