import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const allowedHosts = new Set(["amazon.de", "amazon.com", "amazon.co.uk", "amzn.to", "amzn.eu", "ikea.de", "ikea.com", "shein.com", "temu.com", "otto.de", "ebay.de", "ebay.com", "etsy.com", "wayfair.de", "home24.de"]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function checkOne(product: { id: number; name: string; link: string }) {
  let parsed: URL;
  try { parsed = new URL(product.link); } catch { return { productId: product.id, name: product.name, url: product.link, state: "broken", status: null, reason: "Ungültige URL" }; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !allowedHosts.has(host)) return { productId: product.id, name: product.name, url: product.link, state: "unsupported", status: null, reason: "Domain nicht automatisch prüfbar" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let current = parsed;
    for (let redirects = 0; redirects < 4; redirects += 1) {
      let response = await fetch(current, { method: "HEAD", redirect: "manual", signal: controller.signal });
      if (response.status === 403 || response.status === 405) response = await fetch(current, { method: "GET", redirect: "manual", signal: controller.signal, headers: { Range: "bytes=0-0" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { productId: product.id, name: product.name, url: product.link, state: "unsupported", status: response.status, reason: "Weiterleitung ohne Ziel" };
        const next = new URL(location, current);
        const nextHost = next.hostname.toLowerCase().replace(/^www\./, "");
        if (!allowedHosts.has(nextHost)) return { productId: product.id, name: product.name, url: product.link, state: "unsupported", status: response.status, reason: "Weiterleitung zu nicht freigegebener Domain" };
        current = next;
        continue;
      }
      return { productId: product.id, name: product.name, url: product.link, state: response.ok ? "ok" : "broken", status: response.status, reason: response.ok ? null : response.statusText || "HTTP-Fehler" };
    }
    return { productId: product.id, name: product.name, url: product.link, state: "unsupported", status: null, reason: "Zu viele Weiterleitungen" };
  } catch (error) {
    return { productId: product.id, name: product.name, url: product.link, state: "broken", status: null, reason: error instanceof Error && error.name === "AbortError" ? "Zeitüberschreitung" : "Link nicht erreichbar" };
  } finally { clearTimeout(timeout); }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Anmeldung erforderlich." }, 401);
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authorization } } });
  const { data: userData, error: userError } = await supabase.auth.getUser(authorization.replace("Bearer ", ""));
  if (userError || !userData.user) return json({ error: "Anmeldung erforderlich." }, 401);
  const { data: isAdmin, error: adminError } = await supabase.rpc("is_admin");
  if (adminError || isAdmin !== true) return json({ error: "Nur Admins dürfen Produktlinks prüfen." }, 403);
  const { data: products, error: productsError } = await supabase.from("products").select("id,name,link").not("link", "is", null).order("id", { ascending: true });
  if (productsError) return json({ error: productsError.message }, 500);
  const results: Array<Record<string, unknown>> = [];
  for (let index = 0; index < (products ?? []).length; index += 4) results.push(...(await Promise.all((products ?? []).slice(index, index + 4).map(product => checkOne({ id: product.id, name: product.name || "Unbenanntes Produkt", link: product.link })) )));
  return json({ checkedAt: new Date().toISOString(), checked: results.length, broken: results.filter(result => result.state === "broken"), unsupported: results.filter(result => result.state === "unsupported"), ok: results.filter(result => result.state === "ok").length });
});
