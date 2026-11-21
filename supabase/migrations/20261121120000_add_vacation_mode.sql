alter table public.site_settings
  alter column value drop default;

alter table public.site_settings
  alter column value type jsonb using to_jsonb(value);

alter table public.site_settings
  alter column value set default 'true'::jsonb;

insert into public.site_settings(key, value)
values (
  'vacation_mode',
  jsonb_build_object(
    'enabled', false,
    'start_date', null,
    'end_date', null,
    'daily_summary_hour', 22,
    'pause_visit_notifications', true,
    'pause_click_notifications', true,
    'keep_contact_notifications', true,
    'keep_order_notifications', true
  )
)
on conflict (key) do nothing;

create policy "Admins can read all site settings"
  on public.site_settings for select
  to authenticated
  using (public.is_admin());
