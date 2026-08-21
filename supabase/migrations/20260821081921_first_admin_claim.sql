create or replace function public.claim_first_admin()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(918273645);
  if exists (select 1 from public.admin_users) then
    return false;
  end if;

  insert into public.admin_users (user_id) values (auth.uid());
  return true;
end;
$$;

grant execute on function public.claim_first_admin() to authenticated;
