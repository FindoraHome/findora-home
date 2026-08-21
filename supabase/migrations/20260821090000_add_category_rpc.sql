create or replace function public.create_category(category_name text)
returns public.categories
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned_name text := btrim(category_name);
  created_category public.categories;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen Kategorien anlegen.' using errcode = '42501';
  end if;

  if cleaned_name = '' then
    raise exception 'Der Kategoriename darf nicht leer sein.' using errcode = '22023';
  end if;

  insert into public.categories (name, sort_order, active)
  values (cleaned_name, (select coalesce(max(sort_order), -1) + 1 from public.categories), true)
  returning * into created_category;

  return created_category;
end;
$$;

grant execute on function public.create_category(text) to authenticated;
