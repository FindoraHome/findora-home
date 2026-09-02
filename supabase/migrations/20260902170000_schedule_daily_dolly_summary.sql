-- Dolly prüft alle fünf Minuten, ob es in Deutschland 22 Uhr ist.
-- Die Edge Function versendet pro Kalendertag höchstens eine Zusammenfassung.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'findora-dolly-daily-summary';
exception when others then
  null;
end $$;

select cron.schedule(
  'findora-dolly-daily-summary',
  '*/5 * * * *',
  $schedule$
    select net.http_post(
      url := 'https://wcpifcdwomjzmvnvgqwr.supabase.co/functions/v1/dolly-telegram?scheduled=daily-summary',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $schedule$
);
