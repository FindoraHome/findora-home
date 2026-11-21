create or replace function public.get_vacation_notice()
returns json language sql security definer set search_path = public
as $$
  with setting as (
    select value
    from public.site_settings
    where key = 'vacation_mode'
  )
  select json_build_object(
    'active', coalesce(
      (value ->> 'enabled')::boolean
      and timezone('Europe/Berlin', now())::date between (value ->> 'start_date')::date and (value ->> 'end_date')::date,
      false
    )
  )
  from setting
  union all
  select json_build_object('active', false)
  where not exists (select 1 from setting)
  limit 1;
$$;

grant execute on function public.get_vacation_notice() to anon, authenticated;
