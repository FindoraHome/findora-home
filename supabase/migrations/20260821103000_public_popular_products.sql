create or replace function public.get_popular_products()
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(row_to_json(popular) order by popular.clicks desc, popular.name), '[]'::json)
  from (
    select p.id, p.name, p.link, p.image_url, count(pc.id)::integer as clicks
    from public.products p
    join public.product_clicks pc on pc.product_id = p.id
    where p.active = true
    group by p.id, p.name, p.link, p.image_url
    order by count(pc.id) desc
    limit 8
  ) popular;
$$;

grant execute on function public.get_popular_products() to anon, authenticated;
