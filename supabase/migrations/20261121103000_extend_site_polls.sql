create or replace function public.extend_site_poll(p_poll_id bigint, p_extra_days integer)
returns timestamptz language plpgsql security definer set search_path = public
as $$
declare
  new_end timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen Abstimmungen verlängern.' using errcode = '42501';
  end if;
  if p_extra_days < 1 or p_extra_days > 365 then
    raise exception 'Die Verlängerung muss zwischen 1 und 365 Tagen liegen.' using errcode = '22023';
  end if;

  update public.polls
  set ends_at = greatest(ends_at, now()) + make_interval(days => p_extra_days),
      active = true,
      result_notified = false
  where id = p_poll_id
  returning ends_at into new_end;

  if new_end is null then
    raise exception 'Abstimmung wurde nicht gefunden.' using errcode = 'P0002';
  end if;
  return new_end;
end;
$$;

grant execute on function public.extend_site_poll(bigint, integer) to authenticated;
