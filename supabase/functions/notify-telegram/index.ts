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
  const token = Deno.env.get(bot === "dolly" ? "DOLLY_TELEGRAM_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get(bot === "dolly" ? "DOLLY_TELEGRAM_CHAT_ID" : "TELEGRAM_CHAT_ID");
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
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
  const type = String(input.type || "");

  if (type === "test") {
    if (!(await isAdmin(request))) return json({ error: "Nur Admins dürfen testen." }, 403);
    const isDolly = input.bot === "dolly";
    const result = await sendTelegram(isDolly ? "✅ Dolly\n\nDolly-Telegram-Verbindung funktioniert." : "✅ Findora Home\n\nTelegram-Benachrichtigungen funktionieren.", isDolly ? "dolly" : "main");
    return json(result, result.status);
  }
  if (type !== "visit" && type !== "click" && type !== "contact") return json({ error: "Unbekannter Benachrichtigungstyp." }, 400);

  const serviceUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceUrl || !serviceKey) return json({ error: "Supabase-Service ist nicht konfiguriert." }, 503);
  const service = createClient(serviceUrl, serviceKey);
  const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const ipHash = await hashIp(clientIp);
  const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await service.from("telegram_notification_log").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("sent_at", windowStart);
  const limit = type === "contact" ? 3 : 20;
  if (Number(count || 0) >= limit) return json({ throttled: true }, 429);

  let text = "🔔 Findora Home\n\n👀 Neue Seitenansicht";
  if (type === "click") {
    const productId = Number(input.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) return json({ error: "Ungültiges Produkt." }, 400);
    const { data: product } = await service.from("products").select("name,active").eq("id", productId).maybeSingle();
    if (!product?.active) return json({ error: "Produkt nicht verfügbar." }, 400);
    text = `🔔 Findora Home\n\n🛒 Produkt angeklickt\n📦 ${String(product.name || "Unbekannt").slice(0, 160)}`;
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
