-- Scenarios 0104-at-0099, 0103-then-0104 and 0100-0103-then-0104: what
-- 0104_ignored_pass.sql (ADR 0017 step 11) must have done: the column is there and
-- is jsonb. Its index and grants are read on the real database by the paste kit's
-- after-apply check. Read-only.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'course_attempts'
      and column_name = 'ignored_pass'
      and data_type = 'jsonb'
  ) then
    raise exception 'assert-0104: public.course_attempts.ignored_pass jsonb is missing';
  end if;
end
$$;
