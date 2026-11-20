create or replace function public.get_active_polls(p_visitor_token text default null)
returns json language sql security definer set search_path = public
as $$
  select coalesce(json_agg(poll_data order by poll_data.created_at asc), '[]'::json)
  from (
    select
      poll.id,
      poll.question,
      poll.ends_at,
      poll.created_at,
      exists(
        select 1 from public.poll_votes vote
        where vote.poll_id = poll.id and vote.visitor_token = p_visitor_token
      ) as has_voted,
      coalesce((
        select json_agg(
          json_build_object('id', option_item.id, 'label', option_item.label)
          order by option_item.sort_order, option_item.id
        )
        from public.poll_options option_item
        where option_item.poll_id = poll.id
      ), '[]'::json) as options
    from public.polls poll
    where poll.active = true and poll.ends_at > now()
    order by poll.created_at asc
  ) poll_data;
$$;

create or replace function public.create_site_poll(p_question text, p_options jsonb, p_duration_days integer)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  new_poll_id bigint;
  option_record record;
begin
  if not public.is_admin() then raise exception 'Nur Admins dürfen Abstimmungen erstellen.' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_question, ''))) < 3 then raise exception 'Bitte eine Frage eintragen.' using errcode = '22023'; end if;
  if p_duration_days < 1 or p_duration_days > 365 then raise exception 'Die Laufzeit muss zwischen 1 und 365 Tagen liegen.' using errcode = '22023'; end if;
  if jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) < 2 then raise exception 'Mindestens zwei Antworten sind erforderlich.' using errcode = '22023'; end if;

  insert into public.polls(question, ends_at)
  values (trim(p_question), now() + make_interval(days => p_duration_days))
  returning id into new_poll_id;

  for option_record in select value, ordinality from jsonb_array_elements_text(p_options) with ordinality loop
    if char_length(trim(option_record.value)) > 0 then
      insert into public.poll_options(poll_id, label, sort_order)
      values (new_poll_id, trim(option_record.value), option_record.ordinality - 1);
    end if;
  end loop;

  if (select count(*) from public.poll_options where poll_id = new_poll_id) < 2 then
    raise exception 'Mindestens zwei ausgefüllte Antworten sind erforderlich.' using errcode = '22023';
  end if;
  return new_poll_id;
end;
$$;

grant execute on function public.get_active_polls(text) to anon, authenticated;
grant execute on function public.create_site_poll(text, jsonb, integer) to authenticated;
