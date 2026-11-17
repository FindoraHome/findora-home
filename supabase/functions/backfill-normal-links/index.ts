import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const service = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");

function canonicalAmazonUrl(value: string) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (match) return `https://www.amazon.de/dp/${match[1].toUpperCase()}`;
    const asin = url.searchParams.get("asin") || url.searchParams.get("ASIN");
    if (asin && /^[A-Z0-9]{10}$/i.test(asin)) return `https://www.amazon.de/dp/${asin.toUpperCase()}`;
  } catch { /* invalid URL */ }
  return "";
}

async function resolveNormalLink(link: string) {
  const direct = canonicalAmazonUrl(link);
  if (direct) return direct;
  const response = await fetch(link, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; FindoraHomeLinkManager/1.0)" },
  });
  return canonicalAmazonUrl(response.url);
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization) return json({ error: "Anmeldung fehlt." }, 401);
  const userClient = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_ANON_KEY") || "", { global: { headers: { Authorization: authorization } } });
  const adminCheck = await userClient.rpc("is_admin");
  if (adminCheck.error || adminCheck.data !== true) return json({ error: "Nur für Findora-Admins." }, 403);
  const body = await request.json().catch(() => ({}));
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(25, Math.max(1, Number(body.limit) || 20));
  const result = await service.from("products").select("id,name,link,normal_link").order("id").range(offset, offset + limit - 1);
  if (result.error) return json({ error: result.error.message }, 500);

  const rows = result.data || [];
  const updated: Array<{ id: number; name: string; normal_link: string }> = [];
  const unresolved: Array<{ id: number; name: string; link: string; reason?: string }> = [];
  const skipped: Array<{ id: number; name: string }> = [];

  for (const product of rows) {
    if (product.normal_link) { skipped.push({ id: product.id, name: product.name }); continue; }
    if (!product.link) { unresolved.push({ id: product.id, name: product.name, link: "", reason: "Kein Affiliate-Link" }); continue; }
    try {
      const normalLink = await resolveNormalLink(product.link);
      if (!normalLink) { unresolved.push({ id: product.id, name: product.name, link: product.link, reason: "Keine ASIN erkannt" }); continue; }
      const update = await service.from("products").update({ normal_link: normalLink }).eq("id", product.id);
      if (update.error) throw update.error;
      updated.push({ id: product.id, name: product.name, normal_link: normalLink });
    } catch (error) {
      unresolved.push({ id: product.id, name: product.name, link: product.link, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return json({ offset, processed: rows.length, nextOffset: rows.length === limit ? offset + limit : null, updated, skipped, unresolved });
});
