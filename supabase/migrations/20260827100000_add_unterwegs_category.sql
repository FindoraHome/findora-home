-- Add the general "Unterwegs" category for products used on the go,
-- at celebrations, or while travelling. Keep the migration idempotent.
insert into public.categories (name, sort_order, active)
select 'Unterwegs', coalesce(max(sort_order), -1) + 1, true
from public.categories
where not exists (
  select 1
  from public.categories
  where lower(name) = lower('Unterwegs')
);
