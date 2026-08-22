create table if not exists public.contact_rate_limits (
  ip_hash text primary key,
  window_started_at timestamptz not null default now(),
  sent_count integer not null default 0
);

alter table public.contact_rate_limits enable row level security;
