create table if not exists public.stats_reset_log (
  id boolean primary key default true check (id = true),
  reset_at timestamptz not null default now()
);

alter table public.stats_reset_log enable row level security;

drop policy if exists "Admins can read stats reset time" on public.stats_reset_log;
create policy "Admins can read stats reset time"
  on public.stats_reset_log for select
  to authenticated
  using (public.is_admin());

grant select on table public.stats_reset_log to authenticated;

create or replace function public.reset_page_view_stats()
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen Statistiken zurücksetzen.' using errcode = '42501';
  end if;

  delete from public.product_likes where true;
  delete from public.product_clicks where true;
  delete from public.page_views where true;
  delete from public.search_queries where true;

  insert into public.stats_reset_log (id, reset_at)
  values (true, now())
  on conflict (id) do update set reset_at = excluded.reset_at;
end;
$$;

grant execute on function public.reset_page_view_stats() to authenticated;
