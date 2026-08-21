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
            group by p.id, p.name order by count(pl.id) desc limit 10) like_stats), '[]'::json)
  ) into stats;
  return stats;
end;
$$;

grant execute on function public.get_page_view_stats() to authenticated;
