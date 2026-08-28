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
  const productId = Number(input.product_id);
  if (!Number.isSafeInteger(productId) || productId <= 0) return json({ error: "Ungültiges Produkt." }, 400);
  const service = db();
  const { data: product, error: productError } = await service.from("own_products").select("id,name,price,active").eq("id", productId).maybeSingle();
  if (productError || !product || product.active !== true) return json({ error: "Produkt nicht verfügbar." }, 404);
  const amount = Number(product.price);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "Für dieses Produkt ist noch kein gültiger Preis hinterlegt." }, 400);
  try {
    const response = await fetch(`${base()}/v2/checkout/orders`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", "PayPal-Request-Id": crypto.randomUUID() }, body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ custom_id: String(product.id), description: String(product.name || "Findora-Produkt").slice(0, 127), amount: { currency_code: "EUR", value: amount.toFixed(2) } }] }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) return json({ error: "PayPal konnte die Bestellung nicht erstellen." }, 502);
    const { error: insertError } = await service.from("paypal_transactions").insert({ own_product_id: product.id, paypal_order_id: data.id, status: "CREATED", amount, currency: "EUR" });
    if (insertError) return json({ error: "Bestellung konnte nicht gespeichert werden." }, 500);
    return json({ id: data.id });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "PayPal ist nicht verfügbar." }, 503); }
});
