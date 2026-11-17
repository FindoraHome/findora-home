revoke select on table public.products from anon, authenticated;

grant select (
  id,
  name,
  description,
  link,
  category,
  image_url,
  active,
  created_at,
  partner,
  featured
) on table public.products to anon, authenticated;

create or replace function public.get_admin_product_links()
returns table (
  id bigint,
  name text,
  image_url text,
  link text,
  normal_link text,
  category text,
  partner text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  return query
  select p.id, p.name, p.image_url, p.link, p.normal_link, p.category, p.partner
  from public.products p
  order by p.name;
end;
$$;

revoke all on function public.get_admin_product_links() from public;
grant execute on function public.get_admin_product_links() to authenticated;
