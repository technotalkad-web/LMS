-- scripts/migration-rehearsal/plant-0114-mark-fn.sql
-- Scenario 0114-drift (ADR 0029, D4): a second public.mail_job_mark with other
-- arguments (P14), beside a stand-in with 0114's own signature and result.
-- The stand-in is made first, so the pre-check lists it first (by oid). Both
-- the pre-check and 0114's section 0 must take the stand-in as the file's own
-- and still refuse on the second one: two functions of the name, one of them
-- not the file's. The second one takes p_kind and p_mark without p_day, so a
-- call that leaves out the day fits both.
create function public.mail_job_mark(p_kind text, p_mark text, p_day date default null) returns date
language sql stable as $$ select null::date $$;
create function public.mail_job_mark(p_kind text, p_mark text) returns date
language sql stable as $$ select null::date $$;
