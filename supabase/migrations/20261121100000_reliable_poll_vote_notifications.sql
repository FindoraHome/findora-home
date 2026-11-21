create extension if not exists pg_net with schema extensions;

create or replace function public.vote_in_poll_multi(p_poll_id bigint, p_option_ids bigint[], p_visitor_token text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  selected_option bigint;
begin
  if p_visitor_token is null or char_length(p_visitor_token) < 8 or char_length(p_visitor_token) > 200 then
    raise exception 'Ungültige Besucherkennung.' using errcode = '22023';
  end if;
  if not exists(select 1 from public.polls where id = p_poll_id and active = true and ends_at > now()) then
    raise exception 'Diese Abstimmung ist nicht mehr aktiv.' using errcode = '22023';
  end if;
  if p_option_ids is null or cardinality(p_option_ids) < 1 then
    raise exception 'Bitte mindestens eine Antwort auswählen.' using errcode = '22023';
  end if;
  if exists(select 1 from public.poll_votes where poll_id = p_poll_id and visitor_token = p_visitor_token) then
    raise exception 'Du hast bereits abgestimmt.' using errcode = '23505';
  end if;

  foreach selected_option in array p_option_ids loop
    if not exists(select 1 from public.poll_options where id = selected_option and poll_id = p_poll_id) then
      raise exception 'Eine Antwort gehört nicht zur Abstimmung.' using errcode = '22023';
    end if;
    insert into public.poll_votes(poll_id, option_id, visitor_token)
    values (p_poll_id, selected_option, p_visitor_token);
  end loop;

  perform net.http_post(
    url := 'https://wcpifcdwomjzmvnvgqwr.supabase.co/functions/v1/notify-telegram',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('type', 'poll_vote', 'poll_id', p_poll_id, 'option_ids', to_jsonb(p_option_ids)),
    timeout_milliseconds := 10000
  );
end;
$$;

grant execute on function public.vote_in_poll_multi(bigint, bigint[], text) to anon, authenticated;
