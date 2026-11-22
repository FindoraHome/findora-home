const deliveries = "staging_deliveries";
const env = name => $os.getenv(`FINDORA_STAGING_${name}`);
const siteName = () => $os.getenv("FINDORA_SITE_MODE") === "production" ? "Findora Home" : "Findora-Vorschau";

function berlinTime(value) {
    return new DateTime(value).time().in(new Timezone("Europe/Berlin"));
}

function telegramTime(value = new Date().toISOString()) {
    return berlinTime(value).format("02.01.06, 15:04");
}

function settings(bot) {
    const prefix = bot === "dolly" ? "DOLLY_TELEGRAM_" : "TELEGRAM_";
    const token = env(`${prefix}BOT_TOKEN`);
    const chat = env(`${prefix}CHAT_ID`);
    return /^\d+:[A-Za-z0-9_-]+$/.test(token) && /^-?\d+$/.test(chat) ? { token, chat } : null;
}

function telegram(bot, method, input) {
    const config = settings(bot);
    if (!config) throw new ApiError(503, "Für die Vorschau fehlen Telegram-Bot-Token oder Chat-ID.");
    let response;
    try {
        response = $http.send({ url: `https://api.telegram.org/bot${config.token}/${method}`, method: "POST", timeout: 5,
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
        });
    } catch (_) {
        throw new ApiError(502, "Telegram ist gerade nicht erreichbar.");
    }
    if (response.statusCode !== 200 || response.json?.ok !== true) throw new ApiError(502, "Telegram konnte die Anfrage nicht abschließen.");
    return response.json.result;
}

function send(bot, text) {
    const config = settings(bot);
    const heading = bot === "main" ? `🔔 ${siteName()}\n\n` : "";
    telegram(bot, "sendMessage", { chat_id: config?.chat, text: heading + Array.from(text).slice(0, 3700).join(""),
        disable_web_page_preview: true });
}

function enqueue(app, bot, text, key = "", source = "") {
    try {
        if (!settings(bot)) return;
        app.runInTransaction(tx => {
            if (key && tx.findRecordsByFilter(deliveries, "key = {:key}", "", 1, 0, { key }).length) return;
            const cutoff = new Date(Date.now() - 10 * 60000).toISOString().replace("T", " ");
            if (source && tx.findRecordsByFilter(deliveries, "destination = {:source} && created_at >= {:cutoff}", "", 10, 0,
                { source, cutoff }).length >= 10) return;
            const record = new Record(tx.findCollectionByNameOrId(deliveries));
            for (const [name, value] of Object.entries({ key, kind: bot, body: text, destination: source, created_at: new Date().toISOString() })) {
                record.set(name, value);
            }
            tx.save(record);
        });
    } catch (_) {
        app.logger().warn("Could not queue Findora staging notification");
    }
}

function flush(app) {
    for (const bot of ["main", "dolly"]) {
        if (!settings(bot)) continue;
        const pending = app.findRecordsByFilter(deliveries, "kind = {:bot} && sent_at = '' && attempts < 5", "created_at", 8, 0, { bot });
        for (const record of pending) {
            try {
                send(bot, record.getString("body"));
                record.set("sent_at", new Date().toISOString());
                record.set("body", "");
            } catch (_) {
                record.set("attempts", record.getInt("attempts") + 1);
            }
            app.save(record);
        }
    }
}

function email(app, payload) {
    const recipient = env("CONTACT_TO_EMAIL");
    if (!recipient || !app.settings().smtp.enabled) return false;
    try {
        app.newMailClient().send(new MailerMessage({
            from: { address: app.settings().meta.senderAddress, name: app.settings().meta.senderName },
            to: [{ address: recipient }],
            subject: `${siteName()} – Neue Nachricht`,
            text: `${payload.topic}\n\n${payload.message}\n\n${payload.name || "Ohne Namen"}\n${payload.email}`,
            headers: payload.email ? { "Reply-To": payload.email } : {},
        }));
        return true;
    } catch (_) {
        app.logger().warn("Findora staging contact email could not be delivered");
        return false;
    }
}

function admin(e) {
    const input = e.requestInfo().body;
    const action = e.request.pathValue("action");
    if (action === "notify-telegram") {
        if (input.type === "test") send("dolly", "✅ Dolly\n\nDolly-Telegram-Verbindung funktioniert.");
        else if (input.type === "amazon_report" && typeof input.items === "string") {
            const count = Math.max(1, Math.min(9999, Number(input.count) || 1));
            const items = Array.from(input.items.trim()).slice(0, 3000).join("");
            if (!items) throw new BadRequestError("Keine Bestellungen übergeben.");
            send("dolly", `🛒 Amazon PartnerNet\n\n${count} neue bestellte Artikel erkannt\n\n${items}\n\n🕒 Importiert: ${telegramTime()}`);
        } else throw new BadRequestError("Unbekannter Benachrichtigungstyp.");
        return e.json(200, { data: { ok: true } });
    }
    if (action !== "telegram-setup") throw new NotFoundError();
    if (input.action === "set_dolly_webhook") {
        const url = env("DOLLY_WEBHOOK_URL");
        const secret = env("DOLLY_TELEGRAM_WEBHOOK_SECRET");
        if (!/^https:\/\/[a-z0-9.-]+\/[a-z0-9/-]*dolly$/i.test(url) || !/^[a-zA-Z0-9_-]{16,256}$/.test(secret)) {
            throw new BadRequestError("Der Webhook braucht eine öffentliche HTTPS-Adresse und ein Webhook-Geheimnis.");
        }
        telegram("dolly", "setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });
        return e.json(200, { data: { configured: true, webhook_url: url } });
    }
    const updates = telegram("dolly", "getUpdates", { limit: 20, allowed_updates: ["message"] });
    const chats = new Map();
    for (const update of updates || []) {
        const chat = update.message?.chat;
        if (chat?.id) chats.set(String(chat.id), { chat_id: String(chat.id), name: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "Telegram" });
    }
    return e.json(200, { data: { chats: [...chats.values()] } });
}

module.exports = { admin, berlinTime, email, enqueue, flush, telegramTime };
