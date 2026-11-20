create or replace function public.get_active_poll(p_visitor_token text default null)
returns json language plpgsql security definer set search_path = public
as $$
declare
  selected_poll public.polls%rowtype;
  has_voted boolean := false;
  result json;
begin
  select * into selected_poll
  from public.polls
  where active = true and ends_at > now()
  order by created_at desc
  limit 1;

  if selected_poll.id is null then return null; end if;

  if p_visitor_token is not null then
    select exists(select 1 from public.poll_votes where poll_id = selected_poll.id and visitor_token = p_visitor_token)
    into has_voted;
  end if;

  select json_build_object(
    'id', selected_poll.id,
    'question', selected_poll.question,
    'ends_at', selected_poll.ends_at,
    'has_voted', has_voted,
    'options', coalesce((
      select json_agg(json_build_object('id', option_item.id, 'label', option_item.label) order by option_item.sort_order, option_item.id)
      from public.poll_options option_item
      where option_item.poll_id = selected_poll.id
    ), '[]'::json)
  ) into result;

  return result;
end;
$$;

grant execute on function public.get_active_poll(text) to anon, authenticated;
