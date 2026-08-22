create table if not exists public.site_settings (
  key text primary key,
  value boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.site_settings (key, value)
values ('contact_enabled', true)
on conflict (key) do nothing;

alter table public.site_settings enable row level security;

create policy "Public can read contact setting"
  on public.site_settings for select
  to anon, authenticated
  using (key = 'contact_enabled');

create policy "Admins can update site settings"
  on public.site_settings for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on table public.site_settings to anon, authenticated;
grant update on table public.site_settings to authenticated;
