-- Thumbnail display options for course cards.
--
-- Cards render a fixed 16:9 banner; non-16:9 uploads (especially portrait
-- posters) were always centre-cropped with no admin control. Admins can now
-- choose per course:
--   thumbnail_fit   'cover'   = crop & fill the banner (default, old behavior)
--                   'contain' = fit the whole image inside the banner
--   thumbnail_pos_x/_y        = object-position percentages (0-100) chosen by
--                               dragging in the admin editor; only meaningful
--                               for 'cover', where they pick WHICH part of the
--                               image stays visible. 50/50 = centre.

alter table public.courses
  add column if not exists thumbnail_fit text not null default 'cover'
    constraint courses_thumbnail_fit_check
      check (thumbnail_fit in ('cover', 'contain')),
  add column if not exists thumbnail_pos_x smallint not null default 50
    constraint courses_thumbnail_pos_x_check
      check (thumbnail_pos_x between 0 and 100),
  add column if not exists thumbnail_pos_y smallint not null default 50
    constraint courses_thumbnail_pos_y_check
      check (thumbnail_pos_y between 0 and 100);
