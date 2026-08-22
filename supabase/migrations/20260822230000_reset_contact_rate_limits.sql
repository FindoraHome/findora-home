-- Clear failed diagnostic attempts so the first real contact message is not blocked.
update public.contact_rate_limits
set window_started_at = now(), sent_count = 0;
