const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
Deno.serve((request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Nur GET wird unterstützt." }, 405);
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID") ?? "";
  const environment = Deno.env.get("PAYPAL_ENVIRONMENT") === "live" ? "live" : "sandbox";
  return json({ configured: Boolean(clientId), clientId, environment });
});
