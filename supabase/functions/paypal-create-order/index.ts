import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const db = () => createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const base = () => Deno.env.get("PAYPAL_ENVIRONMENT") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
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
  const requested = Array.isArray(input.product_ids) ? input.product_ids : [input.product_id];
  const productIds = [...new Set(requested.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 20);
  if (!productIds.length) return json({ error: "Ungültiges Produkt." }, 400);
  const service = db();
  const { data: products, error: productError } = await service.from("own_products").select("id,name,price,active,file_path").in("id", productIds);
  if (productError || !products || products.length !== productIds.length || products.some(p => p.active !== true)) return json({ error: "Mindestens ein Produkt ist nicht verfügbar." }, 404);
  if (products.some(p => !Number.isFinite(Number(p.price)) || Number(p.price) <= 0 || !p.file_path)) return json({ error: "Preis oder Download-Datei fehlt bei einem Produkt." }, 400);
  const amount = products.reduce((sum, product) => sum + Number(product.price), 0);
  try {
    const response = await fetch(`${base()}/v2/checkout/orders`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", "PayPal-Request-Id": crypto.randomUUID() }, body: JSON.stringify({ intent: "CAPTURE", application_context: { brand_name: "Findora Home", locale: "de-DE", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" }, purchase_units: [{ custom_id: productIds.join(","), description: products.map(p => p.name).join(", ").slice(0, 127), amount: { currency_code: "EUR", value: amount.toFixed(2) } }] }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) return json({ error: "PayPal konnte die Bestellung nicht erstellen." }, 502);
    const { data: transaction, error: insertError } = await service.from("paypal_transactions").insert({ own_product_id: products[0].id, paypal_order_id: data.id, status: "CREATED", amount, currency: "EUR" }).select("id").single();
    if (insertError || !transaction) return json({ error: "Bestellung konnte nicht gespeichert werden." }, 500);
    const { error: itemError } = await service.from("paypal_transaction_items").insert(products.map(product => ({ transaction_id: transaction.id, own_product_id: product.id, price: product.price })));
    if (itemError) return json({ error: "Warenkorb konnte nicht gespeichert werden." }, 500);
    return json({ id: data.id });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "PayPal ist nicht verfügbar." }, 503); }
});
