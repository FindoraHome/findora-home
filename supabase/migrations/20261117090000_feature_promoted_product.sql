alter table public.products
  add column if not exists featured boolean not null default false;

create unique index if not exists products_single_featured_idx
  on public.products (featured)
  where featured = true;

create or replace function public.set_featured_product(p_product_id bigint default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  update public.products
  set featured = false
  where featured = true;

  if p_product_id is not null then
    update public.products
    set featured = true
    where id = p_product_id;

    if not found then
      raise exception 'Product not found';
    end if;
  end if;
end;
$$;

revoke all on function public.set_featured_product(bigint) from public;
grant execute on function public.set_featured_product(bigint) to authenticated;
