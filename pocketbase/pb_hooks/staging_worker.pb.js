routerAdd("POST", "/api/findora/internal/staging-worker", (e) => {
    const secret = $os.getenv("FINDORA_STAGING_WORKER_KEY");
    if (!secret || !$security.equal(secret, e.request.header.get("X-Findora-Worker-Key"))) throw new UnauthorizedError();
    const input = e.requestInfo().body;
    const app = e.app;
    const limit = Math.max(1, Math.min(2000, Number(input.limit) || 2000));
    const table = input.table;
    const eventKinds = { page_views: "visit", product_clicks: "click", search_queries: "search" };
    if (["products", "own_products"].includes(table)) {
        const data = app.findRecordsByFilter(table, "active = true", table === "products" ? "legacy_id" : "-created_at", limit, 0)
            .map(record => ({ name: record.getString("name"), description: record.getString("description"),
                category: record.getString("category"), partner: record.getString("partner"), link: record.getString("link"),
                price: table === "own_products" ? JSON.parse(record.getString("price_cents") || "null") : null,
            })).map(({ price, ...record }) => ({ ...record, price: price === null ? null : price / 100 }));
        return e.json(200, { data });
    }
    if (Object.prototype.hasOwnProperty.call(eventKinds, table)) {
        const kind = eventKinds[table];
        const from = typeof input.from === "string" ? input.from.replace("T", " ") : "";
        const before = typeof input.before === "string" ? input.before.replace("T", " ") : "9999-01-01";
        const records = app.findRecordsByFilter("staging_site_events", "kind = {:kind} && occurred_at >= {:from} && occurred_at < {:before}",
            "-occurred_at,-id", input.count ? 0 : limit, 0, { kind, from, before });
        if (input.count) return e.json(200, { count: records.length });
        const names = new Map(app.findAllRecords("products").map(row => [row.getString("legacy_id"), row.getString("name")]));
        return e.json(200, { data: records.map(record => ({
            product_id: record.getString("product"), products: { name: names.get(record.getString("product")) || "" },
            search_term: record.getString("term"), searched_at: record.getString("occurred_at").replace(" ", "T"),
        })) });
    }
    if (table === "telegram_notification_log" && /^(daily|weekly)-summary-\d{4}-\d{2}-\d{2}$/.test(input.marker || "")) {
        const key = `dolly:${input.marker}`;
        const found = app.findRecordsByFilter("staging_deliveries", "key = {:key}", "", 1, 0, { key });
        if (input.insert && !found.length) {
            const marker = new Record(app.findCollectionByNameOrId("staging_deliveries"));
            marker.set("key", key);
            marker.set("kind", "summary");
            marker.set("created_at", new Date().toISOString());
            marker.set("sent_at", new Date().toISOString());
            app.save(marker);
        }
        return e.json(200, { count: found.length });
    }
    throw new NotFoundError();
}, $apis.bodyLimit(16384));
