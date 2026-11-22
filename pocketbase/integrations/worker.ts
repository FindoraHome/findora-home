import { env, production } from "./bridge.ts";
import { handler as dolly, sendScheduledDailySummary } from "./dolly.ts";
import { handler as instagram } from "./instagram.ts";

export function handle(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return Response.json({ ok: true, dollyConfigured: Boolean(env("DOLLY_TELEGRAM_BOT_TOKEN")),
      instagramConfigured: Boolean(env("INSTAGRAM_ACCESS_TOKEN")) });
  }
  if (url.pathname === "/dolly") return dolly(request);
  if (url.pathname === "/instagram") return instagram(request);
  return new Response(null, { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ hostname: "127.0.0.1", port: production ? 8192 : 8191 }, handle);
  let sending = false;
  setInterval(async () => {
    if (sending || !env("DOLLY_TELEGRAM_BOT_TOKEN")) return;
    sending = true;
    try { await sendScheduledDailySummary(); }
    catch (_) { console.error("Findora staging Telegram summary could not be sent"); }
    finally { sending = false; }
  }, 5 * 60 * 1000);
}
