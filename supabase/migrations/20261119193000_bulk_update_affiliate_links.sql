create or replace function public.bulk_update_affiliate_links(p_updates jsonb)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  updated_count integer;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen Affiliate-Links gesammelt ändern.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_updates) <> 'array' then
    raise exception 'Die Linkliste ist ungültig.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_updates) as item(id bigint, link text)
    where item.id is null or item.link is null or item.link !~* '^https://'
  ) then
    raise exception 'Alle Affiliate-Links müssen mit https:// beginnen.' using errcode = '22023';
  end if;

  update public.products as product
  set link = item.link
  from jsonb_to_recordset(p_updates) as item(id bigint, link text)
  where product.id = item.id;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

grant execute on function public.bulk_update_affiliate_links(jsonb) to authenticated;
