create or replace function public.get_page_view_stats()
returns json language plpgsql security definer set search_path = public
as $$
declare stats json;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen Besucherstatistiken sehen.' using errcode = '42501';
  end if;
  select json_build_object(
    'total', (select count(*) from public.page_views),
    'today', (select count(*) from public.page_views where visited_at >= current_date),
    'last30', (select count(*) from public.page_views where visited_at >= now() - interval '30 days'),
    'products', coalesce((select json_agg(row_to_json(product_stats) order by product_stats.clicks desc, product_stats.name)
      from (select p.id, p.name, count(pc.id)::integer as clicks
            from public.products p join public.product_clicks pc on pc.product_id = p.id
            group by p.id, p.name order by count(pc.id) desc limit 10) product_stats), '[]'::json),
    'likes', coalesce((select json_agg(row_to_json(like_stats) order by like_stats.likes desc, like_stats.name)
      from (select p.id, p.name, count(pl.id)::integer as likes
            from public.products p join public.product_likes pl on pl.product_id = p.id
            group by p.id, p.name order by count(pl.id) desc limit 10) like_stats), '[]'::json),
    'recent_visits', coalesce((select json_agg(row_to_json(recent_visit) order by recent_visit.visited_at desc)
      from (select visited_at from public.page_views order by visited_at desc limit 50) recent_visit), '[]'::json),
    'recent_clicks', coalesce((select json_agg(row_to_json(recent_click) order by recent_click.clicked_at desc)
      from (select pc.product_id, p.name, pc.clicked_at
            from public.product_clicks pc join public.products p on p.id = pc.product_id
            order by pc.clicked_at desc limit 50) recent_click), '[]'::json),
    'searches', coalesce((select json_agg(row_to_json(search_stats) order by search_stats.searches desc, search_stats.search_term)
      from (select search_term, count(*)::integer as searches
            from public.search_queries where searched_at >= now() - interval '30 days'
            group by search_term order by count(*) desc, search_term limit 20) search_stats), '[]'::json),
    'recent_searches', coalesce((select json_agg(row_to_json(recent_search) order by recent_search.searched_at desc)
      from (select search_term, searched_at from public.search_queries order by searched_at desc limit 50) recent_search), '[]'::json)
  ) into stats;
  return stats;
end;
$$;

grant execute on function public.get_page_view_stats() to authenticated;
