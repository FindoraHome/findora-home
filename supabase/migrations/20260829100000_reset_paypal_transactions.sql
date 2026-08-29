create or replace function public.reset_paypal_transactions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen das PayPal-Protokoll löschen.' using errcode = '42501';
  end if;

  delete from public.paypal_transactions where id is not null;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

grant execute on function public.reset_paypal_transactions() to authenticated;
