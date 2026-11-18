alter table public.products
  add column if not exists is_disney boolean not null default false;

create index if not exists products_is_disney_active_idx
  on public.products (is_disney, active, created_at desc);

comment on column public.products.is_disney is
  'Zeigt das Produkt zusätzlich im öffentlichen Findora-Home-Disney-Bereich.';
