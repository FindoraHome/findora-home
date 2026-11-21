import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const clean = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

async function hashIp(ip: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isAdmin(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authorization } } });
  const { data: userData } = await supabase.auth.getUser(authorization.replace("Bearer ", ""));
  if (!userData.user) return false;
  const { data: admin } = await supabase.rpc("is_admin");
  return admin === true;
}

async function sendTelegram(text: string, bot = "main") {
  const token = bot === "dolly" ? (Deno.env.get("DOLLY_TELEGRAM_BOT_TOKEN") || Deno.env.get("TELEGRAM_BOT_TOKEN")) : Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = bot === "dolly" ? (Deno.env.get("DOLLY_TELEGRAM_CHAT_ID") || Deno.env.get("TELEGRAM_CHAT_ID")) : Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return { ok: false, status: 503, error: "TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt." };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) return { ok: false, status: 502, error: "Telegram konnte die Nachricht nicht senden." };
  return { ok: true, status: 200 };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.get("scheduled") === "poll-results") {
    const serviceUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!serviceUrl || !serviceKey) return json({ error: "Supabase-Service ist nicht konfiguriert." }, 503);
    const service = createClient(serviceUrl, serviceKey);
    const { data: endedPolls, error } = await service.from("polls").select("id,question,ends_at,active,result_notified").eq("result_notified", false).or(`ends_at.lte.${new Date().toISOString()},active.eq.false`).order("ends_at", { ascending: true }).limit(20);
    if (error) return json({ error: error.message }, 500);
    let sent = 0;
    for (const poll of endedPolls || []) {
      const [{ data: options }, { data: votes }] = await Promise.all([
        service.from("poll_options").select("id,label,sort_order").eq("poll_id", poll.id).order("sort_order", { ascending: true }),
        service.from("poll_votes").select("option_id,visitor_token").eq("poll_id", poll.id),
      ]);
      const voteRows = votes || [], participants = new Set(voteRows.map((vote) => vote.visitor_token)).size;
      const lines = (options || []).map((option) => `• ${clean(option.label, 160)}: ${voteRows.filter((vote) => vote.option_id === option.id).length} Stimmen`);
      const time = new Date(poll.ends_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
      const result = await sendTelegram(`📊 Abstimmung beendet\n\n❓ ${clean(poll.question, 300)}\n\n${lines.join("\n") || "Keine Stimmen abgegeben."}\n\n👥 Teilnehmer: ${participants}\n🕒 Ende: ${time}`, "dolly");
      if (result.ok) { await service.from("polls").update({ result_notified: true }).eq("id", poll.id); sent += 1; }
    }
    return json({ ok: true, sent });
  }
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
  const type = String(input.type || "");

  if (type === "test") {
    if (!(await isAdmin(request))) return json({ error: "Nur Admins dürfen testen." }, 403);
    const isDolly = input.bot === "dolly";
    const result = await sendTelegram(isDolly ? "✅ Dolly\n\nDolly-Telegram-Verbindung funktioniert." : "✅ Findora Home\n\nTelegram-Benachrichtigungen funktionieren.", isDolly ? "dolly" : "main");
    return json(result, result.status);
  }
  if (type === "amazon_report") {
    if (!(await isAdmin(request))) return json({ error: "Nur Admins dürfen Amazon-Berichte melden." }, 403);
    const count = Math.max(1, Math.min(9999, Number(input.count) || 1));
    const items = clean(input.items, 3000);
    if (!items) return json({ error: "Keine Bestellungen übergeben." }, 400);
    const time = new Date().toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
    const result = await sendTelegram(`🛒 Amazon PartnerNet\n\n${count} neue bestellte Artikel erkannt\n\n${items}\n\n🕒 Importiert: ${time}`, "dolly");
    return json(result, result.status);
  }
  if (type === "poll_vote") {
    const pollId = Number(input.poll_id), optionIds = Array.isArray(input.option_ids) ? input.option_ids.map(Number).filter(Number.isSafeInteger) : [];
    if (!Number.isSafeInteger(pollId) || pollId <= 0 || !optionIds.length) return json({ error: "Ungültige Abstimmung." }, 400);
    const serviceUrl = Deno.env.get("SUPABASE_URL") ?? "", serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!serviceUrl || !serviceKey) return json({ error: "Supabase-Service ist nicht konfiguriert." }, 503);
    const service = createClient(serviceUrl, serviceKey);
    const [{ data: poll }, { data: options }, { data: votes }] = await Promise.all([
      service.from("polls").select("id,question").eq("id", pollId).maybeSingle(),
      service.from("poll_options").select("id,label").eq("poll_id", pollId).in("id", optionIds),
      service.from("poll_votes").select("visitor_token").eq("poll_id", pollId),
    ]);
    if (!poll) return json({ error: "Abstimmung nicht gefunden." }, 404);
    const selected = (options || []).map((option) => `• ${clean(option.label, 160)}`).join("\n");
    const participants = new Set((votes || []).map((vote) => vote.visitor_token)).size;
    const time = new Date().toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
    const result = await sendTelegram(`🗳️ Neue Abstimmung\n\n❓ ${clean(poll.question, 300)}\n✅ Gewählt:\n${selected}\n\n👥 Teilnehmer bisher: ${participants}\n🕒 ${time}`, "dolly");
    return json(result, result.status);
  }
  if (type !== "visit" && type !== "click" && type !== "contact") return json({ error: "Unbekannter Benachrichtigungstyp." }, 400);

  const serviceUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceUrl || !serviceKey) return json({ error: "Supabase-Service ist nicht konfiguriert." }, 503);
  const service = createClient(serviceUrl, serviceKey);
  if (type === "visit" || type === "click") {
    const { data: vacationSetting } = await service.from("site_settings").select("value").eq("key", "vacation_mode").maybeSingle();
    const vacation = (vacationSetting?.value || {}) as Record<string, unknown>;
    const berlinDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
    const vacationActive = vacation.enabled === true && typeof vacation.start_date === "string" && typeof vacation.end_date === "string" && berlinDate >= vacation.start_date && berlinDate <= vacation.end_date;
    const shouldPause = type === "visit" ? vacation.pause_visit_notifications !== false : vacation.pause_click_notifications !== false;
    if (vacationActive && shouldPause) return json({ ok: true, suppressed: true, reason: "vacation_mode" });
  }
  const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const ipHash = await hashIp(clientIp);
  const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await service.from("telegram_notification_log").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("sent_at", windowStart);
  const limit = type === "contact" ? 3 : 20;
  if (Number(count || 0) >= limit) return json({ throttled: true }, 429);

  let text = "🔔 Findora Home\n\n👀 Neue Seitenansicht";
  if (type === "visit") {
    const [{ count: totalVisits }, { count: todayVisits }] = await Promise.all([
      service.from("page_views").select("id", { count: "exact", head: true }),
      service.from("page_views").select("id", { count: "exact", head: true }).gte("visited_at", new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" })).toISOString()),
    ]);
    text += `\n📊 Seitenbesuche gesamt: ${Number(totalVisits || 0)}\n📅 Heute: ${Number(todayVisits || 0)}`;
  }
  if (type === "click") {
    const productId = Number(input.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) return json({ error: "Ungültiges Produkt." }, 400);
    const { data: product } = await service.from("products").select("name,active").eq("id", productId).maybeSingle();
    if (!product?.active) return json({ error: "Produkt nicht verfügbar." }, 400);
    const [{ count: productClicks }, { count: totalClicks }] = await Promise.all([
      service.from("product_clicks").select("id", { count: "exact", head: true }).eq("product_id", productId),
      service.from("product_clicks").select("id", { count: "exact", head: true }),
    ]);
    text = `🔔 Findora Home\n\n🛒 Produkt angeklickt\n📦 ${String(product.name || "Unbekannt").slice(0, 160)}\n📊 Klicks für dieses Produkt: ${Number(productClicks || 0)}\n📈 Klicks insgesamt: ${Number(totalClicks || 0)}`;
  } else if (type === "contact") {
    const name = clean(input.name, 100) || "Nicht angegeben";
    const email = clean(input.email, 200) || "Nicht angegeben";
    const topic = clean(input.topic, 140);
    const message = clean(input.message, 3000);
    if (!topic || !message) return json({ error: "Thema und Nachricht sind erforderlich." }, 400);
    if (email !== "Nicht angegeben" && !/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Ungültige E-Mail-Adresse." }, 400);
    text = `🔔 Findora Home\n\n✉️ Neue Nachricht\n📌 Thema: ${topic}\n👤 Name: ${name}\n📧 E-Mail: ${email}\n\n${message}`;
  }
  const time = new Date().toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
  const result = await sendTelegram(`${text}\n🕒 ${time}`);
  if (result.ok) await service.from("telegram_notification_log").insert({ ip_hash: ipHash, event_type: type });
  return json(result, result.status);
});
