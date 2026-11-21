create or replace function public.set_site_poll_duration(p_poll_id bigint, p_days_from_now integer)
returns timestamptz language plpgsql security definer set search_path = public
as $$
declare
  new_end timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen den Abstimmungszeitraum ändern.' using errcode = '42501';
  end if;
  if p_days_from_now < 1 or p_days_from_now > 365 then
    raise exception 'Der Zeitraum muss zwischen 1 und 365 Tagen liegen.' using errcode = '22023';
  end if;

  update public.polls
  set ends_at = now() + make_interval(days => p_days_from_now),
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

grant execute on function public.set_site_poll_duration(bigint, integer) to authenticated;

alter table public.polls
  add column if not exists participant_goal integer
  check (participant_goal is null or participant_goal between 1 and 100000);

create or replace function public.set_site_poll_participant_goal(p_poll_id bigint, p_participant_goal integer)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  saved_goal integer;
  participant_count integer;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen das Teilnehmerziel ändern.' using errcode = '42501';
  end if;
  if p_participant_goal is not null and (p_participant_goal < 1 or p_participant_goal > 100000) then
    raise exception 'Das Teilnehmerziel muss zwischen 1 und 100000 liegen.' using errcode = '22023';
  end if;

  select count(distinct visitor_token)::integer into participant_count
  from public.poll_votes where poll_id = p_poll_id;

  update public.polls
  set participant_goal = p_participant_goal,
      active = case when p_participant_goal is not null and participant_count >= p_participant_goal then false else active end,
      result_notified = case when p_participant_goal is not null and participant_count >= p_participant_goal then false else result_notified end
  where id = p_poll_id
  returning participant_goal into saved_goal;

  if not found then raise exception 'Abstimmung wurde nicht gefunden.' using errcode = 'P0002'; end if;
  return saved_goal;
end;
$$;

create or replace function public.get_admin_polls()
returns json language plpgsql security definer set search_path = public
as $$
declare result json;
begin
  if not public.is_admin() then raise exception 'Nur Admins dürfen Abstimmungsergebnisse sehen.' using errcode = '42501'; end if;
  select coalesce(json_agg(poll_data order by poll_data.created_at desc), '[]'::json) into result
  from (
    select poll.id, poll.question, poll.active, poll.created_at, poll.ends_at, poll.participant_goal,
      (select count(distinct vote.visitor_token)::integer from public.poll_votes vote where vote.poll_id = poll.id) as total_votes,
      coalesce((select json_agg(json_build_object('id', option_item.id, 'label', option_item.label, 'votes', (select count(*)::integer from public.poll_votes vote where vote.option_id = option_item.id)) order by option_item.sort_order, option_item.id) from public.poll_options option_item where option_item.poll_id = poll.id), '[]'::json) as options
    from public.polls poll
    order by poll.created_at desc limit 50
  ) poll_data;
  return result;
end;
$$;

create or replace function public.vote_in_poll_multi(p_poll_id bigint, p_option_ids bigint[], p_visitor_token text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  selected_option bigint;
  goal integer;
  participant_count integer;
begin
  if p_visitor_token is null or char_length(p_visitor_token) < 8 or char_length(p_visitor_token) > 200 then raise exception 'Ungültige Besucherkennung.' using errcode = '22023'; end if;
  if not exists(select 1 from public.polls where id = p_poll_id and active = true and ends_at > now()) then raise exception 'Diese Abstimmung ist nicht mehr aktiv.' using errcode = '22023'; end if;
  if p_option_ids is null or cardinality(p_option_ids) < 1 then raise exception 'Bitte mindestens eine Antwort auswählen.' using errcode = '22023'; end if;
  if exists(select 1 from public.poll_votes where poll_id = p_poll_id and visitor_token = p_visitor_token) then raise exception 'Du hast bereits abgestimmt.' using errcode = '23505'; end if;

  foreach selected_option in array p_option_ids loop
    if not exists(select 1 from public.poll_options where id = selected_option and poll_id = p_poll_id) then raise exception 'Eine Antwort gehört nicht zur Abstimmung.' using errcode = '22023'; end if;
    insert into public.poll_votes(poll_id, option_id, visitor_token) values (p_poll_id, selected_option, p_visitor_token);
  end loop;

  select participant_goal into goal from public.polls where id = p_poll_id;
  if goal is not null then
    select count(distinct visitor_token)::integer into participant_count from public.poll_votes where poll_id = p_poll_id;
    if participant_count >= goal then
      update public.polls set active = false, ends_at = now(), result_notified = false where id = p_poll_id;
    end if;
  end if;

  perform net.http_post(
    url := 'https://wcpifcdwomjzmvnvgqwr.supabase.co/functions/v1/notify-telegram',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('type', 'poll_vote', 'poll_id', p_poll_id, 'option_ids', to_jsonb(p_option_ids)),
    timeout_milliseconds := 10000
  );
end;
$$;

grant execute on function public.set_site_poll_participant_goal(bigint, integer) to authenticated;
grant execute on function public.get_admin_polls() to authenticated;
grant execute on function public.vote_in_poll_multi(bigint, bigint[], text) to anon, authenticated;
