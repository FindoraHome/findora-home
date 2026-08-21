create or replace function public.reset_page_view_stats()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen Statistiken zurücksetzen.' using errcode = '42501';
  end if;
  delete from public.product_clicks;
  delete from public.page_views;
end;
$$;

grant execute on function public.reset_page_view_stats() to authenticated;
