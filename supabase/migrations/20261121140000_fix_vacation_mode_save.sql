create or replace function public.save_vacation_mode(
  p_enabled boolean,
  p_start_date date,
  p_end_date date
)
returns json language plpgsql security definer set search_path = public
as $$
declare
  saved_value jsonb;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen den Urlaubsmodus ändern.' using errcode = '42501';
  end if;
  if p_enabled and (p_start_date is null or p_end_date is null) then
    raise exception 'Bitte Start- und Rückkehrdatum eintragen.' using errcode = '22023';
  end if;
  if p_enabled and p_end_date < p_start_date then
    raise exception 'Das Rückkehrdatum darf nicht vor dem Startdatum liegen.' using errcode = '22023';
  end if;

  saved_value := jsonb_build_object(
    'enabled', p_enabled,
    'start_date', p_start_date,
    'end_date', p_end_date,
    'daily_summary_hour', 22,
    'pause_visit_notifications', true,
    'pause_click_notifications', true,
    'keep_contact_notifications', true,
    'keep_order_notifications', true
  );

  insert into public.site_settings(key, value, updated_at)
  values ('vacation_mode', saved_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

  return saved_value::json;
end;
$$;

grant execute on function public.save_vacation_mode(boolean, date, date) to authenticated;
