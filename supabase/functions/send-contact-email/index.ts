import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@^9";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const clean = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 3;

async function hashIp(ip: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);

  const smtpPassword = Deno.env.get("SMTP_PASSWORD");
  const smtpUser = Deno.env.get("SMTP_USERNAME") || "findora.home@web.de";
  const recipient = Deno.env.get("CONTACT_TO_EMAIL") || "homefindora@gmail.com";
  if (!smtpPassword) return json({ error: "E-Mail-Versand ist noch nicht konfiguriert." }, 503);

  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
  const name = clean(input.name, 100) || "Nicht angegeben";
  const email = clean(input.email, 200);
  const topic = clean(input.topic, 140);
  const message = clean(input.message, 3000);
  const honeypot = clean(input.website, 100);
  if (honeypot) return json({ sent: true });
  if (!topic || !message) return json({ error: "Thema und Nachricht sind erforderlich." }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Ungültige E-Mail-Adresse." }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "");
  const { data: setting } = await supabase.from("site_settings").select("value").eq("key", "contact_enabled").maybeSingle();
  if (setting?.value === false) return json({ error: "Das Kontaktformular ist derzeit pausiert." }, 403);

  // Store only a one-way hash of the client IP and allow a small number of
  // messages per time window. This keeps the public endpoint from being used
  // as an unrestricted mail relay without retaining visitors' IP addresses.
  const serviceUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceUrl || !serviceKey) return json({ error: "E-Mail-Versand ist noch nicht konfiguriert." }, 503);
  const service = createClient(serviceUrl, serviceKey);
  const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const ipHash = await hashIp(clientIp);
  const now = Date.now();
  const { data: rateRow } = await service.from("contact_rate_limits").select("window_started_at, sent_count").eq("ip_hash", ipHash).maybeSingle();
  const windowStarted = rateRow?.window_started_at ? Date.parse(rateRow.window_started_at) : 0;
  const windowActive = Number.isFinite(windowStarted) && now - windowStarted < RATE_WINDOW_MS;
  const previousCount = windowActive ? Number(rateRow?.sent_count || 0) : 0;
  if (previousCount >= RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - windowStarted)) / 1000));
    return new Response(JSON.stringify({ error: "Zu viele Anfragen. Bitte später erneut versuchen." }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": String(retryAfter) },
    });
  }
  const { error: rateError } = await service.from("contact_rate_limits").upsert({
    ip_hash: ipHash,
    window_started_at: windowActive ? new Date(windowStarted).toISOString() : new Date(now).toISOString(),
    sent_count: previousCount + 1,
  });
  if (rateError) {
    console.error("Kontakt-Ratenlimit konnte nicht gespeichert werden:", rateError);
    return json({ error: "Anfrage konnte nicht verarbeitet werden." }, 503);
  }

  const transport = nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOSTNAME") || "smtp.web.de",
    port: Number(Deno.env.get("SMTP_PORT") || "587"),
    secure: (Deno.env.get("SMTP_SECURE") || "false") === "true",
    requireTLS: true,
    auth: { user: smtpUser, pass: smtpPassword },
  });
  try {
    await transport.sendMail({
      from: Deno.env.get("SMTP_FROM") || smtpUser,
      to: recipient,
      replyTo: email || undefined,
      subject: `[FindoraHome] ${topic.replace(/[\r\n]+/g, " ")}`,
      text: `Neue Nachricht über FindoraHome\n\nThema: ${topic}\nName: ${name}\nE-Mail: ${email || "Nicht angegeben"}\n\n${message}`,
    });
    return json({ sent: true });
  } catch (error) {
    console.error("Kontaktmail konnte nicht gesendet werden:", error);
    return json({ error: "E-Mail konnte nicht gesendet werden." }, 502);
  }
});
