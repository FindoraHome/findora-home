alter table public.polls add column if not exists result_notified boolean not null default false;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'findora-dolly-poll-results';
exception when others then
  null;
end $$;

select cron.schedule(
  'findora-dolly-poll-results',
  '*/5 * * * *',
  $schedule$
    select net.http_post(
      url := 'https://wcpifcdwomjzmvnvgqwr.supabase.co/functions/v1/notify-telegram?scheduled=poll-results',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $schedule$
);
