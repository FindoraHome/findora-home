import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Anmeldung erforderlich." }, 401);
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authorization } } });
  const { data: userData, error: userError } = await supabase.auth.getUser(authorization.replace("Bearer ", ""));
  if (userError || !userData.user) return json({ error: "Anmeldung erforderlich." }, 401);
  const { data: admin, error: adminError } = await supabase.rpc("is_admin");
  if (adminError || admin !== true) return json({ error: "Nur Admins dürfen Telegram einrichten." }, 403);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return json({ error: "TELEGRAM_BOT_TOKEN fehlt in den Edge-Function-Secrets." }, 503);
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20&allowed_updates=%5B%22message%22%5D`);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) return json({ error: "Telegram-Token konnte nicht geprüft werden." }, 502);
  const chats = new Map<string, { chat_id: string; name: string }>();
  for (const update of Array.isArray(result.result) ? result.result : []) {
    const chat = update?.message?.chat;
    if (!chat?.id) continue;
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "Telegram-Chat";
    chats.set(String(chat.id), { chat_id: String(chat.id), name });
  }
  return json({ chats: [...chats.values()] });
});
