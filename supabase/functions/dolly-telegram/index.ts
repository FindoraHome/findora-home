import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const clean = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const service = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

async function telegram(method: string, body: Record<string, unknown>) {
  const token = Deno.env.get("DOLLY_TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN fehlt.");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error("Telegram konnte nicht erreicht werden.");
}

async function sendMessage(chatId: string, text: string) {
  const chunks = text.match(/[\s\S]{1,3900}/g) || ["Dolly konnte keine Antwort erstellen."];
  for (const chunk of chunks) await telegram("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
}

async function sendDocument(chatId: string, bytes: Uint8Array, filename: string, caption: string) {
  const token = Deno.env.get("DOLLY_TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("DOLLY_TELEGRAM_BOT_TOKEN fehlt in den Supabase-Secrets.");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption.slice(0, 900));
  form.append("document", new Blob([bytes], { type: "application/pdf" }), filename);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error("Das E-Book konnte nicht an Telegram gesendet werden.");
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

function amazonAsin(link: unknown) {
  const match = String(link || "").match(/(?:\/dp\/|\/gp\/product\/|\/ASIN\/)([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : "nicht hinterlegt";
}

async function trendScoutText() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: products, error: productError }, { data: clicks, error: clickError }] = await Promise.all([
    service.from("products").select("id,name,category,partner,link").eq("active", true).order("id", { ascending: true }).limit(200),
    service.from("product_clicks").select("product_id,created_at").gte("created_at", since).limit(10000),
  ]);
  if (productError) throw new Error("Der Produktkatalog konnte nicht geladen werden.");
  const counts = new Map<number, number>();
  if (!clickError) for (const click of clicks || []) counts.set(Number(click.product_id), (counts.get(Number(click.product_id)) || 0) + 1);
  const groups = new Map<string, any[]>();
  for (const product of products || []) { const category = String(product.category || "Weitere Produkte"); if (!groups.has(category)) groups.set(category, []); groups.get(category)!.push(product); }
  if (!groups.size) return "📈 Trend Scout\n\nNoch keine aktiven Produkte im Findora-Katalog.";
  const rows = ["📈 Findora Trend Scout · letzte 30 Tage", "Deine beworbenen Findora-Home-Produkte, sortiert nach Klicks. Dies sind keine Amazon-Verkaufszahlen.", ""];
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const score = (items: any[]) => items.reduce((sum, item) => sum + (counts.get(Number(item.id)) || 0), 0);
    return score(b[1]) - score(a[1]) || a[0].localeCompare(b[0], "de");
  });
  for (const [category, items] of sortedGroups) {
    const top = items.slice().sort((a, b) => (counts.get(Number(b.id)) || 0) - (counts.get(Number(a.id)) || 0) || String(a.name || "").localeCompare(String(b.name || ""), "de")).slice(0, 5);
    rows.push(`📂 ${category}`);
    top.forEach((item, index) => {
      const clicksForProduct = counts.get(Number(item.id)) || 0;
      rows.push(`${index + 1}. ${item.name || "Unbenanntes Produkt"}`);
      rows.push(`   Marke/Modell: im Produktnamen hinterlegt · ASIN: ${amazonAsin(item.link)}`);
      rows.push(`   Trendgrund: ${clicksForProduct} Klick${clicksForProduct === 1 ? "" : "s"} auf Findora · ${item.partner || "Partner nicht angegeben"}`);
      if (item.link) rows.push(`   Link: ${item.link}`);
    });
    rows.push("");
  }
  return rows.join("\n").slice(0, 12000);
}

async function generateEbook(topic: string) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY fehlt in den Supabase-Secrets.");
  const prompt = `Erstelle ein vollständiges, gut lesbares deutsches E-Book zum Thema „${topic}" für Findora Home. Schreibe einen Titel, eine kurze Einleitung, danach 5 logisch aufeinanderfolgende Kapitel mit praktischen Beispielen und am Ende eine Checkliste. Beginne jedes Kapitel auf einer neuen Seite, indem du exakt eine eigene Zeile im Format [KAPITEL 1] Kapitelüberschrift, [KAPITEL 2] ... usw. verwendest. Schreibe keine erfundenen Produkt- oder Preisversprechen. Verwende klare Absätze und keine Tabellen. Das E-Book soll direkt als PDF gesetzt werden können.`;
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("DOLLY_MODEL") || "gpt-5", store: false, input: [{ role: "developer", content: "Du bist Dollys E-Book-Redaktion. Schreibe hochwertig, verständlich und vollständig auf Deutsch." }, { role: "user", content: prompt }] }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.output_text) throw new Error("Dolly konnte das E-Book gerade nicht erstellen.");
  return String(data.output_text).trim().slice(0, 50000);
}

function wrapText(text: string, font: any, size: number, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean); const lines: string[] = []; let line = "";
  for (const word of words) { const next = line ? `${line} ${word}` : word; if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next; else { lines.push(line); line = word; } }
  if (line) lines.push(line); return lines;
}

async function createEbookPdf(topic: string, content: string) {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");
  const pdf = await PDFDocument.create(); const regular = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo: any; try { const logoResponse = await fetch("https://findorahome.github.io/findora-home/findora-logo.png"); if (logoResponse.ok) logo = await pdf.embedPng(new Uint8Array(await logoResponse.arrayBuffer())); } catch { /* Logo bleibt optional. */ }
  const width = 595.28, height = 841.89, margin = 54, textWidth = width - margin * 2; let page = pdf.addPage([width, height]); let y = height - margin;
  const newPage = () => { page = pdf.addPage([width, height]); y = height - margin; };
  const header = () => { page.drawLine({ start: { x: margin, y: height - 42 }, end: { x: width - margin, y: height - 42 }, thickness: 1, color: rgb(0.71, 0.55, 0.37) }); page.drawText("FINDORA HOME", { x: margin, y: height - 32, size: 8, font: bold, color: rgb(0.27, 0.32, 0.16) }); };
  if (logo) page.drawImage(logo, { x: margin, y: height - margin - 72, width: 72, height: 72 });
  page.drawText("FINDORA HOME", { x: margin, y: height - margin - 100, size: 12, font: bold, color: rgb(0.27, 0.32, 0.16) });
  const titleLines = wrapText(topic, bold, 25, textWidth); titleLines.forEach((line, index) => page.drawText(line, { x: margin, y: height - margin - 145 - index * 31, size: 25, font: bold, color: rgb(0.12, 0.10, 0.08) }));
  y = height - margin - 190 - (titleLines.length - 1) * 31; page.drawText("Ein E-Book von Dolly · Findora Home", { x: margin, y, size: 11, font: regular, color: rgb(0.48, 0.39, 0.31) }); y -= 34;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) { y -= 10; continue; }
    const chapter = line.match(/^\[KAPITEL\s+\d+\]\s*(.*)$/i);
    if (chapter) { newPage(); header(); y -= 36; const heading = wrapText(chapter[1] || "Kapitel", bold, 19, textWidth); heading.forEach((part, i) => page.drawText(part, { x: margin, y: y - i * 24, size: 19, font: bold, color: rgb(0.12, 0.10, 0.08) })); y -= heading.length * 24 + 20; continue; }
    const isHeading = /^#{1,3}\s/.test(line); const text = line.replace(/^#{1,3}\s*/, ""); const size = isHeading ? 15 : 10.5; const font = isHeading ? bold : regular; const lineHeight = isHeading ? 20 : 15;
    for (const part of wrapText(text, font, size, textWidth)) { if (y < margin + lineHeight) { newPage(); header(); y -= 28; } page.drawText(part, { x: margin, y, size, font, color: rgb(0.16, 0.14, 0.12) }); y -= lineHeight; }
    if (isHeading) y -= 6;
  }
  return await pdf.save();
}

async function handleMessage(chatId: string, rawText: string) {
  const text = clean(rawText, 4000);
  const [command, ...rest] = text.split(/\s+/);
  const argument = rest.join(" ").trim();
  if (command === "/start" || command === "/hilfe") return sendMessage(chatId, "✨ Dolly – Findora Home\n\n/produkte – aktuelle Produkte anzeigen\n/beratung Frage – passende Produkte empfehlen lassen\n/service Frage – Hilfe zu Produkten, PayPal und Downloads\n/ebook Thema – komplettes E-Book als PDF erstellen\n/trend – Produkte mit Klick-Trend nach Kategorien anzeigen");
  if (command === "/produkte") return sendMessage(chatId, `📦 Aktuelle Findora-Produkte\n\n${(await catalogText()).slice(0, 3800)}`);
  if (command === "/beratung" || command === "/service") {
    if (!argument) return sendMessage(chatId, command === "/beratung" ? "Schreibe z. B.: /beratung Ich suche etwas für unterwegs bis 30 €." : "Schreibe z. B.: /service Wie funktioniert der Download nach PayPal-Zahlung?");
    try { return sendMessage(chatId, await askOpenAI(command === "/beratung" ? "beratung" : "service", argument)); } catch (error) { return sendMessage(chatId, error instanceof Error ? error.message : "Dolly ist gerade nicht verfügbar."); }
  }
  if (command === "/trend") { try { return sendMessage(chatId, await trendScoutText()); } catch (error) { return sendMessage(chatId, error instanceof Error ? error.message : "Trend Scout ist gerade nicht verfügbar."); } }
  if (command === "/ebook") {
    if (!argument) return sendMessage(chatId, "Schreibe ein Thema hinter /ebook, z. B. /ebook Ordnung im kleinen Zuhause.");
    try {
      await sendMessage(chatId, `📘 Dolly erstellt dein E-Book zum Thema „${argument}“. Einen Moment bitte …`);
      const content = await generateEbook(argument); const pdf = await createEbookPdf(argument, content);
      const filename = `findora-ebook-${argument.toLowerCase().replace(/[^a-z0-9äöüß]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50) || "ebook"}.pdf`;
      return sendDocument(chatId, pdf, filename, `📘 Dein E-Book „${argument}“ ist fertig.`);
    } catch (error) { return sendMessage(chatId, error instanceof Error ? error.message : "Dolly konnte das E-Book gerade nicht erstellen."); }
  }
  if (!text) return sendMessage(chatId, "Schreibe /hilfe für Dollys Befehle.");
  try { return sendMessage(chatId, await askOpenAI("service", text)); } catch (error) { return sendMessage(chatId, error instanceof Error ? error.message : "Dolly ist gerade nicht verfügbar."); }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Nur POST wird unterstützt." }, 405);
  const secret = Deno.env.get("DOLLY_TELEGRAM_WEBHOOK_SECRET") || Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const configuredChatId = Deno.env.get("DOLLY_TELEGRAM_CHAT_ID") || Deno.env.get("TELEGRAM_CHAT_ID");
  if (!secret || !configuredChatId || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return json({ error: "Ungültiger Telegram-Webhook." }, 401);
  let update: Record<string, any>;
  try { update = await request.json(); } catch { return json({ error: "Ungültige Telegram-Aktualisierung." }, 400); }
  const message = update?.message;
  const chatId = message?.chat?.id;
  if (!chatId || String(chatId) !== String(configuredChatId) || typeof message?.text !== "string") return json({ ok: true });
  try { await handleMessage(String(chatId), message.text); } catch (error) { console.error("Dolly konnte Telegram-Nachricht nicht verarbeiten:", error); }
  return json({ ok: true });
});
