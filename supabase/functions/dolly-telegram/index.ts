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

async function googleTrendsHeadlines() {
  try {
    const response = await fetch("https://trends.google.com/trends/api/dailytrends?hl=de&tz=-120&geo=DE&ns=15", { headers: { "User-Agent": "FindoraHome-Dolly/1.0" } });
    if (!response.ok) return [];
    const raw = await response.text();
    const data = JSON.parse(raw.replace(/^\)\]\}',?\s*/, ""));
    const searches = data?.default?.trendingSearchesDays?.[0]?.trendingSearches || [];
    return searches.slice(0, 5).map((item: any) => String(item?.title?.query || "")).filter(Boolean);
  } catch { return []; }
}

async function trendScoutText() {
  const googleTrends = await googleTrendsHeadlines();
  const date = new Date().toLocaleDateString("de-DE");
  const rows = ["🔎 Google Trends Deutschland", `Stand: ${date}`, "Aktuelle meistgesuchte Themen in Deutschland (keine Findora-Produktliste).", ""];
  if (googleTrends.length) googleTrends.forEach((headline, index) => rows.push(`${index + 1}. ${headline}`));
  else rows.push("Google-Trends-Daten sind gerade nicht abrufbar. Öffne https://trends.google.de/trends/trendingsearches/daily?geo=DE");
  rows.push("", "Quelle: Google Trends Deutschland", "https://trends.google.de/trends/trendingsearches/daily?geo=DE");
  return rows.join("\n").slice(0, 12000);
}

function fallbackEbook(topic: string) {
  const chapters = [
    ["Grundlagen und Ziel", "Kläre zuerst, was du mit dem Thema erreichen möchtest und für wen der Leitfaden gedacht ist. Beschreibe deine Ausgangssituation ehrlich, denn ein realistischer Startpunkt macht Fortschritte sichtbar. Formuliere ein konkretes Ergebnis und lege einfache Kriterien fest, mit denen du später prüfen kannst, ob deine Lösung funktioniert.\n\nNimm dir anschließend Zeit für eine kurze Bestandsaufnahme: Was ist bereits vorhanden, was fehlt noch und welche Grenzen gibt es bei Zeit, Platz oder Budget? Schreibe die Antworten auf. Diese Notizen helfen dir, Prioritäten zu setzen und dich nicht in Einzelheiten zu verlieren."],
    ["Vorbereitung und Planung", "Eine gute Vorbereitung spart später Zeit. Sammle Informationen, benötigte Materialien und hilfreiche Ansprechpartner. Teile das Vorhaben in kleine Schritte auf und ordne sie nach Wichtigkeit. Beginne mit Aufgaben, die eine Grundlage für alles Weitere schaffen.\n\nPlane bewusst Puffer ein. Unerwartete Änderungen gehören zu jedem Projekt. Eine kurze Tages- oder Wochenplanung mit drei erreichbaren Aufgaben ist oft wirksamer als eine lange Wunschliste. Halte Entscheidungen schriftlich fest, damit du jederzeit nachvollziehen kannst, warum du einen Weg gewählt hast."],
    ["Die Umsetzung Schritt für Schritt", "Starte mit einer einfachen, überschaubaren Aufgabe. Arbeite konzentriert und prüfe danach sofort das Ergebnis. Wenn etwas nicht passt, korrigiere zuerst die Ursache und nicht nur das sichtbare Symptom. So entsteht nach und nach ein stabiler Ablauf.\n\nNutze Zwischenstände: ein Foto, eine Checkliste, eine kurze Notiz oder ein Beispiel. Zwischenstände zeigen dir, was bereits gut funktioniert, und erleichtern Verbesserungen. Beziehe bei Bedarf eine vertraute Person ein und bitte um eine konkrete Rückmeldung statt um ein allgemeines Urteil."],
    ["Qualität, Sicherheit und Alltagstauglichkeit", "Eine Lösung ist erst dann gut, wenn sie im Alltag zuverlässig funktioniert. Prüfe Bedienbarkeit, Haltbarkeit, Pflegeaufwand und Sicherheit. Frage dich, ob die Schritte auch an einem stressigen Tag realistisch sind. Vereinfache alles, was regelmäßig unnötig Zeit kostet.\n\nTeste deine Lösung zunächst in kleinem Umfang. Beobachte, wo Unsicherheiten entstehen, und ergänze genau dort eine Erklärung oder ein Beispiel. Vermeide Versprechen, die du nicht belegen kannst, und kennzeichne Empfehlungen als persönliche Erfahrung."],
    ["Typische Fehler und bessere Alternativen", "Zu große Ziele, fehlende Reihenfolge und unklare Zuständigkeiten gehören zu den häufigsten Stolpersteinen. Teile ein großes Ziel in überprüfbare Etappen und lege für jede Etappe einen Abschluss fest. Wenn du feststeckst, reduziere den Umfang, statt alles aufzugeben.\n\nEin weiterer Fehler ist, zu viele Methoden gleichzeitig zu testen. Ändere immer nur einen wichtigen Faktor und beobachte die Wirkung. Notiere Fehler ohne Schuldzuweisung: Was ist passiert, warum ist es passiert und welche kleine Änderung verhindert eine Wiederholung?"],
    ["Praktische Beispiele und Varianten", "Übertrage das Thema „${topic}“ auf mindestens drei unterschiedliche Situationen: wenig Zeit, begrenztes Budget und eine besonders anspruchsvolle Ausgangslage. Für jede Situation beschreibst du eine einfache Variante, eine komfortable Variante und einen sinnvollen nächsten Schritt.\n\nBeispiele machen Inhalte greifbar. Verwende konkrete Abläufe, aber lasse Raum für persönliche Anpassungen. Eine gute Variante ist nicht die teuerste, sondern diejenige, die zu den eigenen Gewohnheiten, Räumlichkeiten und Zielen passt."],
    ["Routine, Kontrolle und Weiterentwicklung", "Damit die Ergebnisse bleiben, brauchst du eine Routine. Lege einen festen Zeitpunkt für eine kurze Kontrolle fest und entscheide vorher, worauf du achten möchtest. Nach zwei bis vier Wochen vergleichst du deine Notizen mit dem ursprünglichen Ziel. Behalte wirksame Schritte bei und streiche unnötige.\n\nPlane kleine Verbesserungen statt radikaler Neustarts. Eine Änderung pro Woche ist leichter umzusetzen und lässt sich besser bewerten. Aktualisiere diesen Leitfaden, wenn sich deine Bedürfnisse oder Rahmenbedingungen ändern."],
    ["Abschluss und persönliche Checkliste", "Fasse die wichtigsten Erkenntnisse in deinen eigenen Worten zusammen. Formuliere drei Dinge, die du sofort umsetzen kannst, und einen Schritt, den du später vertiefen möchtest. Ein guter Abschluss macht aus Wissen eine konkrete Entscheidung.\n\nCheckliste:\n- Ziel und Ausgangssituation notiert\n- Vorbereitung und Reihenfolge festgelegt\n- Erste Etappe umgesetzt und geprüft\n- Sicherheit und Alltagstauglichkeit getestet\n- Fehler und Verbesserungen dokumentiert\n- Persönliche Routine für die nächsten Wochen geplant"],
  ];
  return `# ${topic}\n\nEin ausführlicher Findora-Home-Leitfaden\n\nDieser Leitfaden behandelt „${topic}“ verständlich, praktisch und mit vielen umsetzbaren Details. Passe die Empfehlungen an deine Situation an und prüfe wichtige Angaben selbst.\n\n${chapters.map((chapter, index) => `[KAPITEL ${index + 1}] ${chapter[0]}\n\n${chapter[1]}`).join("\n\n")}`;
}

async function generateEbook(topic: string) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return fallbackEbook(topic);
  const prompt = `Erstelle ein vollständiges, sehr detailliertes deutsches E-Book zum Thema „${topic}" für Findora Home. Schreibe mindestens 8 logisch aufeinanderfolgende Kapitel mit jeweils mehreren ausführlichen Absätzen, konkreten Beispielen, Varianten für unterschiedliche Situationen, praktischen Schritt-für-Schritt-Anleitungen, typischen Fehlern und Lösungen. Ergänze am Ende eine Zusammenfassung, einen 30-Tage-Aktionsplan und eine umfangreiche Checkliste. Beginne jedes Kapitel auf einer neuen Seite, indem du exakt eine eigene Zeile im Format [KAPITEL 1] Kapitelüberschrift, [KAPITEL 2] ... usw. verwendest. Schreibe keine erfundenen Produkt- oder Preisversprechen. Verwende klare Absätze, Listen und Zwischenüberschriften, aber keine Tabellen. Das E-Book soll direkt als hochwertiges PDF gesetzt werden können und mindestens 2500 Wörter enthalten.`;
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("DOLLY_MODEL") || "gpt-5", store: false, input: [{ role: "developer", content: "Du bist Dollys E-Book-Redaktion. Schreibe hochwertig, verständlich und vollständig auf Deutsch." }, { role: "user", content: prompt }] }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.output_text) return fallbackEbook(topic);
  return String(data.output_text).trim().slice(0, 50000);
}

function wrapText(text: string, font: any, size: number, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean); const lines: string[] = []; let line = "";
  for (const word of words) { const next = line ? `${line} ${word}` : word; if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next; else { lines.push(line); line = word; } }
  if (line) lines.push(line); return lines;
}

async function createEbookPdf(topic: string, content: string) {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1?target=deno");
  const pdf = await PDFDocument.create(); const regular = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo: any; try { const logoResponse = await fetch("https://findorahome.github.io/findora-home/findora-logo.png"); if (logoResponse.ok) logo = await pdf.embedPng(new Uint8Array(await logoResponse.arrayBuffer())); } catch { /* Logo bleibt optional. */ }
  const width = 595.28, height = 841.89, margin = 54, textWidth = width - margin * 2; const ink = rgb(0.12, 0.10, 0.08); const green = rgb(0.27, 0.32, 0.16); const gold = rgb(0.71, 0.55, 0.37); const paper = rgb(0.98, 0.96, 0.93);
  let page = pdf.addPage([width, height]); let y = height - margin;
  const centered = (target: any, text: string, font: any, size: number, yy: number, color = ink) => target.drawText(text, { x: (width - font.widthOfTextAtSize(text, size)) / 2, y: yy, size, font, color });
  // Cover: eigene erste Seite nur für Titel und Marke.
  page.drawRectangle({ x: 0, y: 0, width, height, color: paper });
  if (logo) page.drawImage(logo, { x: (width - 112) / 2, y: height - 210, width: 112, height: 112 });
  centered(page, "FINDORA HOME", bold, 13, height - 245, green);
  centered(page, "E-BOOK", regular, 10, height - 290, gold);
  const titleLines = wrapText(topic, bold, 27, width - 100); titleLines.forEach((line, index) => centered(page, line, bold, 27, height - 340 - index * 34));
  const titleBottom = height - 340 - (titleLines.length - 1) * 34;
  centered(page, "Ein ausführlicher Leitfaden von Dolly", regular, 12, titleBottom - 55, rgb(0.48, 0.39, 0.31));
  page.drawLine({ start: { x: width / 2 - 58, y: titleBottom - 82 }, end: { x: width / 2 + 58, y: titleBottom - 82 }, thickness: 1, color: gold });
  centered(page, "findorahome.github.io", regular, 9, 48, rgb(0.48, 0.39, 0.31));

  // Zweite Seite wird für das Inhaltsverzeichnis reserviert und erst nach dem Rendern gefüllt.
  const tocPage = pdf.addPage([width, height]);
  const header = (target: any) => { target.drawLine({ start: { x: margin, y: height - 42 }, end: { x: width - margin, y: height - 42 }, thickness: 1, color: gold }); target.drawText("FINDORA HOME · DOLLY", { x: margin, y: height - 32, size: 8, font: bold, color: green }); };
  const newBodyPage = () => { page = pdf.addPage([width, height]); y = height - 74; header(page); return page; };
  let bodyHasContent = false; newBodyPage();
  const chapterStarts: Array<{ title: string; page: number }> = [];
  const introText = content.split(/^\[KAPITEL\s+\d+\]/im)[0].replace(/^#.*$/gm, "").trim();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) { y -= 10; continue; }
    const chapter = line.match(/^\[KAPITEL\s+(\d+)\]\s*(.*)$/i);
    if (chapter) {
      if (bodyHasContent) { newBodyPage(); bodyHasContent = false; }
      const heading = wrapText(chapter[2] || `Kapitel ${chapter[1]}`, bold, 19, textWidth); page.drawRectangle({ x: margin - 10, y: y - heading.length * 24 - 8, width: textWidth + 20, height: heading.length * 24 + 16, color: rgb(0.94, 0.91, 0.86) }); heading.forEach((part, i) => page.drawText(part, { x: margin, y: y - i * 24, size: 19, font: bold, color: ink })); y -= heading.length * 24 + 20; bodyHasContent = true; chapterStarts.push({ title: chapter[2] || `Kapitel ${chapter[1]}`, page: pdf.getPages().length }); continue;
    }
    const isHeading = /^#{1,3}\s/.test(line); const text = line.replace(/^#{1,3}\s*/, ""); const size = isHeading ? 15 : 10.5; const font = isHeading ? bold : regular; const lineHeight = isHeading ? 20 : 15;
    for (const part of wrapText(text, font, size, textWidth)) { if (y < margin + lineHeight + 18) { newBodyPage(); bodyHasContent = false; } page.drawText(part, { x: margin, y, size, font, color: ink }); y -= lineHeight; bodyHasContent = true; }
    if (isHeading) y -= 6;
  }
  header(tocPage); tocPage.drawText("Inhaltsangabe", { x: margin, y: height - 98, size: 23, font: bold, color: ink }); tocPage.drawLine({ start: { x: margin, y: height - 112 }, end: { x: margin + 90, y: height - 112 }, thickness: 2, color: gold });
  let tocY = height - 155; const tocEntries = [...(introText ? [{ title: "Einleitung", page: 3 }] : []), ...chapterStarts];
  tocEntries.forEach((entry, index) => { if (tocY < margin + 25) return; tocPage.drawText(`${index + 1}. ${entry.title}`, { x: margin, y: tocY, size: 12, font: regular, color: ink }); tocPage.drawText(String(entry.page), { x: width - margin - 12, y: tocY, size: 12, font: regular, color: rgb(0.48, 0.39, 0.31) }); tocPage.drawLine({ start: { x: margin + 220, y: tocY + 3 }, end: { x: width - margin - 28, y: tocY + 3 }, thickness: 0.5, color: rgb(0.84, 0.78, 0.70) }); tocY -= 28; });
  tocPage.drawText("Die Kapitel beginnen jeweils auf einer neuen Seite.", { x: margin, y: 80, size: 10, font: regular, color: rgb(0.48, 0.39, 0.31) });
  const pages = pdf.getPages(); pages.forEach((currentPage: any, index: number) => currentPage.drawText(`${index + 1} / ${pages.length}`, { x: width - margin - 34, y: 24, size: 8, font: regular, color: rgb(0.48, 0.39, 0.31) }));
  return await pdf.save();
}

async function handleMessage(chatId: string, rawText: string) {
  const text = clean(rawText, 4000);
  const [command, ...rest] = text.split(/\s+/);
  const argument = rest.join(" ").trim();
  if (command === "/start" || command === "/hilfe") return sendMessage(chatId, "✨ Dolly – Findora Home\n\n/produkte – aktuelle Produkte anzeigen\n/beratung Frage – passende Produkte empfehlen lassen\n/service Frage – Hilfe zu Produkten, PayPal und Downloads\n/ebook Thema – komplettes E-Book als PDF erstellen\n/trend – aktuelle Google-Trends in Deutschland anzeigen");
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
      const content = await generateEbook(argument);
      let pdf: Uint8Array;
      try { pdf = await createEbookPdf(argument, content); } catch {
        await sendMessage(chatId, "Der E-Book-Text ist fertig, aber die PDF-Gestaltung konnte gerade nicht geladen werden. Ich sende dir den vollständigen Text jetzt direkt:");
        return sendMessage(chatId, content);
      }
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
