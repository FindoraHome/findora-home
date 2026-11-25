const events = "staging_site_events";
const settings = "staging_site_settings";
const messages = "staging_contact_messages";
const reports = "staging_amazon_reports";
const delivery = require(`${__hooks}/staging_delivery.js`);

function first(app, table, expression, args) {
    return app.findRecordsByFilter(table, expression, "", 1, 0, args)[0];
}

function write(app, table, values, record) {
    const item = record || new Record(app.findCollectionByNameOrId(table));
    for (const [key, value] of Object.entries(values)) item.set(key, value);
    app.save(item);
    return item;
}

function getSetting(app, key) {
    const record = first(app, settings, "key = {:key}", { key });
    return record ? JSON.parse(record.getString("value")) : null;
}

function setSetting(app, key, value) {
    write(app, settings, { key, value }, first(app, settings, "key = {:key}", { key }));
}

function now() { return new Date().toISOString(); }

function dateValue(record, name) { return record.getString(name).replace(" ", "T"); }

function berlinDate(value) {
    return delivery.berlinTime(new Date(value).toISOString()).format("2006-01-02");
}

function berlinMidnight(date) {
    // Berlin's offset at 00:00 UTC also applies at the start of this local date.
    const offset = delivery.berlinTime(`${date}T00:00:00Z`).format("-07:00");
    return new Date(`${date}T00:00:00${offset}`).toISOString();
}

function vacation(app) {
    const value = getSetting(app, "vacation_mode") || {};
    const today = berlinDate(Date.now());
    return { ...value, active: value.enabled === true && today >= value.start_date && today <= value.end_date };
}

function text(value, max, min = 0) {
    const result = typeof value === "string" ? value.trim() : "";
    const length = Array.from(result).length;
    if (length < min || length > max) throw new BadRequestError("Bitte überprüfe die Eingaben.");
    return result;
}

function visitorKey(value) {
    if (typeof value !== "string" || !/^[a-z0-9_-]{8,128}$/i.test(value)) throw new BadRequestError("Ungültige Besucherkennung.");
    return $security.sha256(value);
}

function productKey(app, value) {
    const id = String(value);
    if (!/^\d+$/.test(id) || !first(app, "products", "legacy_id = {:id} && active = true", { id })) throw new NotFoundError();
    return id;
}

function readEvents(app, kind) {
    return app.findRecordsByFilter(events, "kind = {:kind}", "-occurred_at,-id", 0, 0, { kind });
}

function countBy(list, column) {
    const counts = new Map();
    for (const item of list) {
        const key = item.getString(column);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function publicCounts(app) {
    const rows = app.findRecordsByFilter("products", "active = true", "", 0, 0);
    const active = new Set(rows.map(record => record.getString("legacy_id")));
    const counts = countBy(readEvents(app, "like"), "product");
    const likes = Object.fromEntries(counts.filter(([id]) => active.has(id)));
    const popular = countBy(readEvents(app, "click"), "product").filter(([id]) => active.has(id)).slice(0, 4).map(([id]) => id);
    return { likes, popular };
}

function stats(app) {
    const products = new Map(app.findAllRecords("products").map(row => [row.getString("legacy_id"), {
        id: row.id, name: row.getString("name"),
    }]));
    const visits = readEvents(app, "visit");
    const clicks = readEvents(app, "click");
    const likes = readEvents(app, "like");
    const currentTime = Date.now();
    const cutoff = new Date(currentTime - 30 * 86400000).toISOString();
    const searches = readEvents(app, "search").filter(record => dateValue(record, "occurred_at") >= cutoff);
    const productTotals = (records, label) => countBy(records, "product").filter(([id]) => products.has(id))
        .map(([id, count]) => ({ ...products.get(id), [label]: count }));
    const today = berlinDate(currentTime);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const dayStart = berlinMidnight(today);
    const monthStart = berlinMidnight(`${today.slice(0, 7)}-01`);
    const dayEnd = berlinMidnight(tomorrow);
    const visitTimes = visits.map(record => dateValue(record, "occurred_at"));
    return {
        total: visits.length,
        today: visitTimes.filter(time => time >= dayStart && time < dayEnd).length,
        month: visitTimes.filter(time => time >= monthStart && time < dayEnd).length,
        next_day_in_ms: Date.parse(dayEnd) - currentTime,
        last30: visitTimes.filter(time => time >= cutoff).length,
        products: productTotals(clicks, "clicks"), likes: productTotals(likes, "likes"),
        recent_visits: visits.slice(0, 150).map(row => ({ visited_at: dateValue(row, "occurred_at") })),
        recent_clicks: clicks.filter(row => products.has(row.getString("product"))).slice(0, 150).map(row => ({
            ...products.get(row.getString("product")), clicked_at: dateValue(row, "occurred_at"),
        })),
        searches: countBy(searches, "term").slice(0, 30).map(([search_term, searches]) => ({ search_term, searches })),
        recent_searches: searches.slice(0, 100).map(row => ({ search_term: row.getString("term"), searched_at: dateValue(row, "occurred_at") })),
    };
}

function sendContact(e, input) {
    const app = e.app;
    const payload = {
        name: text(input.name, 200), email: text(input.email, 254), topic: text(input.topic, 160, 2),
        message: text(input.message, 5000, 3), created_at: now(), sender: $security.sha256(e.realIP()),
    };
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw new BadRequestError("Ungültige E-Mail-Adresse.");
    app.runInTransaction(tx => {
        if (getSetting(tx, "contact_enabled") === false) throw new BadRequestError("Das Kontaktformular ist pausiert.");
        const cutoff = new Date(Date.now() - 3600000).toISOString().replace("T", " ");
        if (tx.findRecordsByFilter(messages, "sender = {:sender} && created_at >= {:cutoff}", "", 6, 0,
            { sender: payload.sender, cutoff }).length >= 6) throw new ApiError(429, "Bitte versuche es später erneut.");
        write(tx, messages, payload);
    });
    const message = Array.from(payload.message).slice(0, 3000).join("");
    const notice = `✉️ Neue Nachricht\n📌 Thema: ${payload.topic}\n👤 Name: ${payload.name || "Nicht angegeben"}\n📧 E-Mail: ${payload.email || "Nicht angegeben"}\n\n${message}\n🕒 ${delivery.telegramTime(payload.created_at)}`;
    delivery.enqueue(app, "main", notice, "", payload.sender);
    return { saved: true, mail_sent: delivery.email(app, payload) };
}

function event(app, action, input, occurredAt) {
    const value = { occurred_at: occurredAt };
    switch (action) {
        case "record_page_view":
            value.kind = "visit";
            value.visitor = visitorKey(input.visitor_token);
            break;
        case "record_product_click":
            value.kind = "click";
            value.product = productKey(app, input.p_product_id);
            break;
        case "record_search_query":
            value.kind = "search";
            value.term = text(input.p_query, 100, 2).toLowerCase();
            value.visitor = visitorKey(input.p_visitor_token);
            break;
        default: throw new NotFoundError();
    }
    let added = true;
    app.runInTransaction(tx => {
        if (value.kind === "visit" && first(tx, events, "kind = 'visit' && visitor = {:visitor}", { visitor: value.visitor })) {
            added = false;
            return;
        }
        write(tx, events, value);
    });
    return added;
}

function trafficNotice(app, click, productId, occurredAt) {
    const time = delivery.telegramTime(occurredAt);
    if (click) {
        const product = first(app, "products", "legacy_id = {:id}", { id: productId });
        const name = Array.from(product?.getString("name") || "Unbekannt").slice(0, 160).join("");
        const productClicks = app.countRecords(events, $dbx.hashExp({ kind: "click", product: productId }));
        const totalClicks = app.countRecords(events, $dbx.hashExp({ kind: "click" }));
        return `🛒 Produkt angeklickt\n📦 ${name}\n📊 Klicks für dieses Produkt: ${productClicks}\n📈 Klicks insgesamt: ${totalClicks}\n🕒 ${time}`;
    }
    const date = berlinDate(occurredAt);
    const since = new DateTime(berlinMidnight(date)).string();
    const visits = $dbx.hashExp({ kind: "visit" });
    const total = app.countRecords(events, visits);
    const today = app.countRecords(events, visits, $dbx.exp("occurred_at >= {:since}", { since }));
    return `👀 Neue Seitenansicht\n📊 Seitenbesuche gesamt: ${total}\n📅 Heute: ${today}\n🕒 ${time}`;
}

function toggleLike(app, input) {
    const product = productKey(app, input.p_product_id);
    const visitor = visitorKey(input.p_visitor_token);
    let result;
    app.runInTransaction(tx => {
        const previous = first(tx, events, "kind = 'like' && product = {:product} && visitor = {:visitor}", { product, visitor });
        if (previous) tx.delete(previous);
        else write(tx, events, { kind: "like", product, visitor, occurred_at: now() });
        const count = tx.findRecordsByFilter(events, "kind = 'like' && product = {:product}", "", 0, 0, { product }).length;
        result = { liked: !previous, count };
    });
    return result;
}

function visitor(e) {
    const action = e.request.pathValue("action");
    const input = e.requestInfo().body;
    const app = e.app;
    let data;
    switch (action) {
        case "get_vacation_notice": data = { active: vacation(app).active }; break;
        case "contact_enabled": data = getSetting(app, "contact_enabled") !== false; break;
        case "submit_contact": data = sendContact(e, input); break;
        case "public_counts": data = publicCounts(app); break;
        case "toggle_product_like": data = toggleLike(app, input); break;
        default: {
            const occurredAt = now();
            data = event(app, action, input, occurredAt);
            if (data && (action === "record_page_view" || action === "record_product_click")) {
                const mode = vacation(app);
                const click = action === "record_product_click";
                if (!mode.active || mode[click ? "pause_click_notifications" : "pause_visit_notifications"] === false) {
                    const notice = trafficNotice(app, click, String(input.p_product_id), occurredAt);
                    delivery.enqueue(app, "main", notice, "", $security.sha256(e.realIP()));
                }
            }
        }
    }
    return e.json(200, { data });
}

function saveVacation(app, input) {
    const start_date = input.p_start_date || null, end_date = input.p_end_date || null;
    const enabled = input.p_enabled === true;
    const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if ((enabled && (!start_date || !end_date)) || (start_date && !validDate(start_date)) || (end_date && !validDate(end_date)) ||
        (start_date && end_date && end_date < start_date)) throw new BadRequestError("Ungültiger Urlaubszeitraum.");
    setSetting(app, "vacation_mode", { ...getSetting(app, "vacation_mode"), enabled, start_date, end_date,
        daily_summary_hour: 22, pause_visit_notifications: true, pause_click_notifications: true });
}

function contactRecord(record) {
    return { id: record.id, name: record.getString("name"), email: record.getString("email"), topic: record.getString("topic"),
        message: record.getString("message"), is_read: record.getBool("is_read"), created_at: dateValue(record, "created_at") };
}

function saveReports(app, rows) {
    if (!Array.isArray(rows) || rows.length > 1000) throw new BadRequestError("Ungültiger Bericht.");
    let added = 0;
    app.runInTransaction(tx => {
        for (const row of rows) {
            const fingerprint = text(row.fingerprint, 128, 1);
            if (first(tx, reports, "fingerprint = {:id}", { id: fingerprint })) continue;
            const entry = { ...row, product_title: text(row.product_title, 500, 1) };
            if (!Number.isInteger(row.ordered_count) || row.ordered_count < 1) throw new BadRequestError("Ungültige Bestellmenge.");
            write(tx, reports, { fingerprint, entry, imported_at: now() });
            added++;
        }
    });
    return added;
}

function admin(e) {
    const app = e.app;
    const input = e.requestInfo().body;
    const action = e.request.pathValue("action");
    let data = null;
    switch (action) {
        case "get_page_view_stats": data = stats(app); break;
        case "settings": data = {
            contact_enabled: getSetting(app, "contact_enabled"), vacation_mode: getSetting(app, "vacation_mode"),
            stats_reset_log: getSetting(app, "stats_reset_log"), product_clicks_reset_log: getSetting(app, "product_clicks_reset_log"),
        }; break;
        case "contact_enabled":
            if (typeof input.value !== "boolean") throw new BadRequestError("Ungültige Einstellung.");
            setSetting(app, "contact_enabled", input.value);
            break;
        case "save_vacation_mode": saveVacation(app, input); break;
        case "contact_messages": data = app.findRecordsByFilter(messages, "", "-created_at,-id", 100, 0).map(contactRecord); break;
        case "update_contact": {
            const record = app.findRecordById(messages, input.id);
            if (input.delete === true) app.delete(record);
            else write(app, messages, { is_read: input.is_read === true }, record);
            break;
        }
        case "reset_search_history":
            app.db().newQuery("DELETE FROM staging_site_events WHERE kind = 'search'").execute();
            break;
        case "reset_page_view_stats":
        case "reset_product_click_stats": {
            const clicks = action === "reset_product_click_stats";
            app.runInTransaction(tx => {
                for (const kind of clicks ? ["click"] : ["visit", "search", "like"]) {
                    for (const record of readEvents(tx, kind)) tx.delete(record);
                }
                setSetting(tx, clicks ? "product_clicks_reset_log" : "stats_reset_log", now());
            });
            break;
        }
        case "amazon_reports": data = app.findRecordsByFilter(reports, "", "-imported_at,-id", 50, 0)
            .map(record => JSON.parse(record.getString("entry"))); break;
        case "amazon_fingerprints": {
            if (!Array.isArray(input.fingerprints) || input.fingerprints.length > 100) throw new BadRequestError("Ungültiger Bericht.");
            data = input.fingerprints.filter(id => first(app, reports, "fingerprint = {:id}", { id })).map(fingerprint => ({ fingerprint }));
            break;
        }
        case "import_amazon": data = saveReports(app, input.rows); break;
        default: throw new NotFoundError();
    }
    return e.json(200, { data });
}

module.exports = { admin, visitor };
