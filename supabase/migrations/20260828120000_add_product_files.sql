alter table public.own_products
  add column if not exists file_path text,
  add column if not exists file_name text;

insert into storage.buckets (id, name, public)
values ('product-files', 'product-files', false)
on conflict (id) do update set public = false;

drop policy if exists "Admins can manage product files" on storage.objects;
create policy "Admins can manage product files"
  on storage.objects for all to authenticated
  using (bucket_id = 'product-files' and (select public.is_admin()))
  with check (bucket_id = 'product-files' and (select public.is_admin()));

grant select, insert, update, delete on public.own_products to authenticated;
