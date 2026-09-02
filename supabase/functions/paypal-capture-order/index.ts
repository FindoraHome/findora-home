import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const db = () => createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const base = () => Deno.env.get("PAYPAL_ENVIRONMENT") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
async function notifyPurchase(productName: string, amount: unknown, orderId: string, downloadReady: boolean, payerEmail?: string | null) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  const price = Number(amount);
  const amountText = Number.isFinite(price) ? price.toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "Betrag unbekannt";
  const time = new Date().toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: `🔔 Findora Home\n\n🛒 Zahlung erfolgreich\n📦 ${String(productName || "Eigenes Produkt").slice(0, 160)}\n💶 ${amountText}\n📧 ${payerEmail || "E-Mail nicht übermittelt"}\n📥 ${downloadReady ? "Download wurde freigegeben" : "Achtung: Keine Download-Datei hinterlegt"}\n🧾 PayPal: ${orderId}\n🕒 ${time}`, disable_web_page_preview: true }) });
  } catch (error) { console.error("Telegram-Bestellbenachrichtigung fehlgeschlagen:", error); }
}
async function token() {
  const id = Deno.env.get("PAYPAL_CLIENT_ID"), secret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!id || !secret) throw new Error("PayPal ist noch nicht eingerichtet.");
  const response = await fetch(`${base()}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("PayPal-Anmeldung fehlgeschlagen.");
  return data.access_token as string;
}
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  let input: Record<string, unknown>; try { input = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
  const orderId = String(input.order_id || "").trim();
  if (!orderId || !/^[A-Za-z0-9_-]{5,80}$/.test(orderId)) return json({ error: "Ungültige PayPal-Bestellung." }, 400);
  const service = db();
  const { data: transaction, error: transactionError } = await service.from("paypal_transactions").select("id,status,amount,payer_email,own_products(name,file_path,file_name)").eq("paypal_order_id", orderId).maybeSingle();
  if (transactionError || !transaction) return json({ error: "Bestellung nicht gefunden." }, 404);
  if (transaction.status === "COMPLETED") {
    let downloadUrl = null;
    const filePath = transaction.own_products?.file_path;
    if (filePath) {
      const signed = await service.storage.from("product-files").createSignedUrl(filePath, 3600);
      if (!signed.error) downloadUrl = signed.data?.signedUrl || null;
    }
    return json({ completed: true, download_url: downloadUrl, file_name: transaction.own_products?.file_name || null, product_name: transaction.own_products?.name || null, amount: transaction.amount || null });
  }
  try {
    const response = await fetch(`${base()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" } });
    const data = await response.json().catch(() => ({}));
    const completed = response.ok && data.status === "COMPLETED";
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    const payerEmail = data.payer?.email_address || null;
    await service.from("paypal_transactions").update({ status: completed ? "COMPLETED" : "FAILED", payer_email: payerEmail, captured_at: completed ? new Date().toISOString() : null }).eq("id", transaction.id);
    if (!completed) return json({ error: "PayPal konnte die Zahlung nicht abschließen." }, 502);
    let downloadUrl = null;
    const filePath = transaction.own_products?.file_path;
    if (completed && filePath) {
      const signed = await service.storage.from("product-files").createSignedUrl(filePath, 3600);
      if (!signed.error) downloadUrl = signed.data?.signedUrl || null;
    }
    if (completed) await notifyPurchase(transaction.own_products?.name || "Eigenes Produkt", transaction.amount, orderId, Boolean(downloadUrl), payerEmail);
    return json({ completed: true, capture_id: capture?.id || null, download_url: downloadUrl, file_name: transaction.own_products?.file_name || null, product_name: transaction.own_products?.name || null, amount: transaction.amount || null });
  } catch (error) { await service.from("paypal_transactions").update({ status: "FAILED" }).eq("id", transaction.id); return json({ error: error instanceof Error ? error.message : "PayPal ist nicht verfügbar." }, 503); }
});
