routerAdd("POST", "/api/findora/staging-admin/link-tools/{action}", (e) => {
    const action = e.request.pathValue("action");
    const input = e.requestInfo().body;
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new BadRequestError("Ungültige Startposition.");
    const limit = 12;
    const products = e.app.findRecordsByFilter("products", "", "id", limit, offset);
    const resolve = action === "backfill-normal-links";
    if (!resolve && action !== "check-product-links") throw new NotFoundError();
    const rows = products.map(record => ({ productId: record.id, name: record.getString("name"), url: record.getString("link") }));
    const skipped = [];
    const selected = rows.filter(row => {
        if (resolve && e.app.findRecordsByFilter("product_source_details", "product = {:id} && normal_link != ''", "", 1, 0,
            { id: row.productId }).length) {
            skipped.push(row);
            return false;
        }
        return resolve || Boolean(row.url);
    });
    const output = $os.cmd("/usr/bin/python3", `${__hooks}/link_checks.py`, resolve ? "resolve" : "check", JSON.stringify(selected)).output();
    const results = JSON.parse(toString(output));
    const nextOffset = products.length === limit ? offset + limit : null;
    if (!resolve) {
        return e.json(200, { data: { nextOffset, checked: results.length, ok: results.filter(row => row.state === "ok").length,
            broken: results.filter(row => row.state === "broken"), temporary: results.filter(row => row.state === "temporary"),
            unsupported: results.filter(row => row.state === "unsupported"),
        } });
    }
    const updated = [];
    const unresolved = [];
    e.app.runInTransaction(app => {
        for (const row of results) {
            if (!row.normal_link) {
                unresolved.push(row);
                continue;
            }
            const product = app.findRecordsByFilter("products", "id = {:id} && link = {:url}", "", 1, 0, { id: row.productId, url: row.url })[0];
            if (!product) continue;
            const detail = app.findRecordsByFilter("product_source_details", "product = {:id}", "", 1, 0, { id: row.productId })[0]
                || new Record(app.findCollectionByNameOrId("product_source_details"));
            if (detail.getString("normal_link")) continue;
            detail.set("product", row.productId);
            detail.set("normal_link", row.normal_link);
            app.save(detail);
            updated.push(row);
        }
    });
    return e.json(200, { data: { nextOffset, updated, unresolved, skipped } });
}, $apis.requireAuth("findora_admins"), $apis.bodyLimit(8192));
