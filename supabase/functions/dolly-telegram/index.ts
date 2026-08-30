import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const clean = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const service = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

async function telegram(method: string, body: Record<string, unknown>) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN fehlt.");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error("Telegram konnte nicht erreicht werden.");
}

async function sendMessage(chatId: string, text: string) {
  const chunks = text.match(/[\s\S]{1,3900}/g) || ["Dolly konnte keine Antwort erstellen."];
  for (const chunk of chunks) await telegram("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
}

async function catalogText() {
  const [{ data: products }, { data: ownProducts }] = await Promise.all([
    service.from("products").select("name,description,category,partner,link").eq("active", true).order("id", { ascending: true }).limit(80),
    service.from("own_products").select("name,description,price").eq("active", true).order("created_at", { ascending: false }).limit(40),
  ]);
  const partnerRows = (products || []).map((item) => `- ${item.name || "Produkt"} | Kategorie: ${item.category || "–"} | Partner: ${item.partner || "–"} | ${item.description || ""} | Link: ${item.link || "–"}`);
  const ownRows = (ownProducts || []).map((item) => `- ${item.name || "Eigenes Produkt"} | Preis: ${item.price == null ? "auf Anfrage" : `${Number(item.price).toFixed(2)} EUR`} | ${item.description || ""}`);
  return [...partnerRows, ...ownRows].join("\n").slice(0, 18000) || "Der Katalog ist derzeit leer.";
}

async function askOpenAI(mode: "service" | "beratung", question: string) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY fehlt in den Supabase-Secrets.");
  const instructions = mode === "beratung"
    ? "Du bist Dollys Produktberaterin für Findora Home. Empfehle nur Produkte aus dem Katalog. Nenne exakte Namen, Kategorien und vorhandene Links. Erfinde keine Preise, Eigenschaften oder Verfügbarkeiten. Antworte kurz auf Deutsch."
    : "Du bist Dollys Kundenservice für Findora Home. Beantworte Fragen zu Produkten, Downloads und PayPal nur mit den Kataloginformationen. Wenn etwas fehlt, sage das offen. Antworte kurz auf Deutsch.";
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("DOLLY_MODEL") || "gpt-5", store: false, input: [{ role: "developer", content: `${instructions}\n\nKatalog:\n${await catalogText()}` }, { role: "user", content: question }] }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.output_text) throw new Error("Dolly konnte gerade keine KI-Antwort erstellen.");
  return String(data.output_text).trim().slice(0, 12000);
}

async function handleMessage(chatId: string, rawText: string) {
  const text = clean(rawText, 4000);
  const [command, ...rest] = text.split(/\s+/);
  const argument = rest.join(" ").trim();
  if (command === "/start" || command === "/hilfe") return sendMessage(chatId, "✨ Dolly – Findora Home\n\n/produkte – aktuelle Produkte anzeigen\n/beratung Frage – passende Produkte empfehlen lassen\n/service Frage – Hilfe zu Produkten, PayPal und Downloads\n/ebook Thema – E-Book-Auftrag vormerken\n/trend – Trend-Scout-Status anzeigen");
  if (command === "/produkte") return sendMessage(chatId, `📦 Aktuelle Findora-Produkte\n\n${(await catalogText()).slice(0, 3800)}`);
  if (command === "/beratung" || command === "/service") {
    if (!argument) return sendMessage(chatId, command === "/beratung" ? "Schreibe z. B.: /beratung Ich suche etwas für unterwegs bis 30 €." : "Schreibe z. B.: /service Wie funktioniert der Download nach PayPal-Zahlung?");
    try { return sendMessage(chatId, await askOpenAI(command === "/beratung" ? "beratung" : "service", argument)); } catch (error) { return sendMessage(chatId, error instanceof Error ? error.message : "Dolly ist gerade nicht verfügbar."); }
  }
  if (command === "/ebook") return sendMessage(chatId, argument ? `📘 E-Book-Auftrag vorgemerkt: „${argument}“. Die PDF-Erstellung wird im E-Book-Modul ergänzt.` : "Schreibe ein Thema hinter /ebook.");
  if (command === "/trend") return sendMessage(chatId, "📈 Trend Scout ist noch nicht mit einer Produktdatenquelle verbunden.");
  if (!text) return sendMessage(chatId, "Schreibe /hilfe für Dollys Befehle.");
  try { return sendMessage(chatId, await askOpenAI("service", text)); } catch (error) { return sendMessage(chatId, error instanceof Error ? error.message : "Dolly ist gerade nicht verfügbar."); }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const configuredChatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!secret || !configuredChatId || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return json({ error: "Ungültiger Telegram-Webhook." }, 401);
  let update: Record<string, any>;
  try { update = await request.json(); } catch { return json({ error: "Ungültige Telegram-Aktualisierung." }, 400); }
  const message = update?.message;
  const chatId = message?.chat?.id;
  if (!chatId || String(chatId) !== String(configuredChatId) || typeof message?.text !== "string") return json({ ok: true });
  try { await handleMessage(String(chatId), message.text); } catch (error) { console.error("Dolly konnte Telegram-Nachricht nicht verarbeiten:", error); }
  return json({ ok: true });
});
