const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const encoder = new TextEncoder();

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function validMetaSignature(rawBody: string, signature: string | null, appSecret: string) {
  if (!signature?.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  const expected = "sha256=" + [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, signature);
}

function commentEvents(payload: any) {
  const events: Array<{ id: string; text: string; accountId: string; senderId: string }> = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== "comments") continue;
      const value = change?.value || {};
      const id = String(value.id || value.comment_id || "");
      const text = String(value.text || "");
      const senderId = String(value.from?.id || "");
      if (id && text) events.push({ id, text, senderId, accountId: String(entry.id || "") });
    }
  }
  return events;
}

async function sendPrivateReply(commentId: string, igUserId: string, accessToken: string, message: string) {
  const graphBase = (Deno.env.get("INSTAGRAM_GRAPH_BASE") || "https://graph.facebook.com").replace(/\/$/, "");
  const version = Deno.env.get("INSTAGRAM_GRAPH_VERSION") || "v27.0";
  const response = await fetch(`${graphBase}/${version}/${encodeURIComponent(igUserId)}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text: message } }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Meta ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

Deno.serve(async request => {
  const url = new URL(request.url);
  const verifyToken = Deno.env.get("INSTAGRAM_WEBHOOK_VERIFY_TOKEN") || "";

  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    if (mode === "subscribe" && verifyToken && token === verifyToken) return new Response(challenge, { status: 200 });
    return new Response("Webhook-Verifizierung fehlgeschlagen.", { status: 403 });
  }

  if (request.method !== "POST") return json({ error: "Nur GET und POST werden unterstützt." }, 405);

  const rawBody = await request.text();
  const appSecret = Deno.env.get("INSTAGRAM_APP_SECRET") || "";
  if (!(await validMetaSignature(rawBody, request.headers.get("x-hub-signature-256"), appSecret))) {
    return json({ error: "Ungültige Meta-Signatur." }, 401);
  }

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: "Ungültiges JSON." }, 400); }

  const accessToken = Deno.env.get("INSTAGRAM_ACCESS_TOKEN") || "";
  const configuredUserId = Deno.env.get("INSTAGRAM_USER_ID") || "";
  const websiteUrl = Deno.env.get("INSTAGRAM_REPLY_URL") || "https://findorahome.github.io/findora-home/";
  const replyText = Deno.env.get("INSTAGRAM_REPLY_TEXT") || `Hallo 😊 Hier findest du alle Produkte und Ideen von Findora Home:\n${websiteUrl}\nViel Spaß beim Entdecken 🤍`;
  if (!accessToken || !configuredUserId) return json({ error: "Instagram-Zugangsdaten fehlen." }, 503);

  const matching = commentEvents(payload).filter(event => {
    const hasKeyword = /(^|[^\p{L}\p{N}])link([^\p{L}\p{N}]|$)/iu.test(event.text);
    return hasKeyword && event.senderId !== configuredUserId && (!event.accountId || event.accountId === configuredUserId);
  });

  const results = [];
  for (const event of matching) {
    try {
      const result = await sendPrivateReply(event.id, configuredUserId, accessToken, replyText);
      results.push({ commentId: event.id, ok: true, result });
    } catch (error) {
      console.error("Instagram private reply failed", event.id, error);
      results.push({ commentId: event.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return json({ received: true, matched: matching.length, results });
});
