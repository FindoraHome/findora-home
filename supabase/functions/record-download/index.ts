import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const service = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
async function notify(name: string) { const token = Deno.env.get("TELEGRAM_BOT_TOKEN"), chatId = Deno.env.get("TELEGRAM_CHAT_ID"); if (!token || !chatId) return; await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: `📥 Download geöffnet\n📦 ${name}\n🕒 ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}` }) }); }
Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  const body = await request.json().catch(() => ({})); const orderId = String(body.order_id || ""); const productId = Number(body.product_id);
  if (!/^[A-Za-z0-9_-]{5,80}$/.test(orderId) || !Number.isSafeInteger(productId)) return json({ error: "Ungültiger Download." }, 400);
  const { data: tx } = await service.from("paypal_transactions").select("id,status,own_product_id").eq("paypal_order_id", orderId).maybeSingle();
  if (!tx || tx.status !== "COMPLETED") return json({ error: "Zahlung nicht bestätigt." }, 403);
  const { count } = await service.from("paypal_transaction_items").select("id", { count: "exact", head: true }).eq("transaction_id", tx.id).eq("own_product_id", productId);
  if (tx.own_product_id !== productId && !count) return json({ error: "Produkt gehört nicht zu dieser Bestellung." }, 403);
  const { data: product } = await service.from("own_products").select("name,file_path,file_name").eq("id", productId).maybeSingle();
  if (!product?.file_path) return json({ error: "Download-Datei fehlt." }, 404);
  await service.from("download_events").insert({ transaction_id: tx.id, own_product_id: productId });
  const signed = await service.storage.from("product-files").createSignedUrl(product.file_path, 3600);
  if (signed.error || !signed.data?.signedUrl) return json({ error: "Download konnte nicht freigegeben werden." }, 500);
  await notify(product.name || "Findora-Produkt").catch(() => {});
  return json({ download_url: signed.data.signedUrl, file_name: product.file_name || "findora-download" });
});
