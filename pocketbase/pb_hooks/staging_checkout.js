const path = "/api/findora/sandbox-checkout";
const orders = "sandbox_orders";
const paypalHost = "https://api-m.sandbox.paypal.com";
const env = name => $os.getenv(`FINDORA_STAGING_${name}`);

function settings() {
    if ($os.getenv("FINDORA_SITE_MODE") === "production") throw new NotFoundError();
    return { clientId: env("PAYPAL_CLIENT_ID"), secret: env("PAYPAL_CLIENT_SECRET"), signingKey: env("WORKER_KEY") };
}

function configured(config) {
    return Boolean(config.clientId && config.secret && config.signingKey);
}

function config(e) {
    const credentials = settings();
    return e.json(200, {
        configured: configured(credentials), environment: "sandbox",
        clientId: configured(credentials) ? credentials.clientId : "",
    });
}

// PocketBase's JavaScript runtime has no browser btoa. PayPal credentials are ASCII.
function basicAuth(value) {
    const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let encoded = "";
    for (let i = 0; i < value.length; i += 3) {
        const a = value.charCodeAt(i), b = value.charCodeAt(i + 1) || 0, c = value.charCodeAt(i + 2) || 0;
        encoded += digits[a >> 2] + digits[((a & 3) << 4) | (b >> 4)];
        encoded += i + 1 < value.length ? digits[((b & 15) << 2) | (c >> 6)] : "=";
        encoded += i + 2 < value.length ? digits[c & 63] : "=";
    }
    return "Basic " + encoded;
}

function paypal(endpoint, method, headers, body) {
    try {
        return $http.send({ url: paypalHost + endpoint, method, headers, body, timeout: 10 });
    } catch (_) {
        return null;
    }
}

function paypalSession(credentials) {
    const response = paypal("/v1/oauth2/token", "POST", {
        Authorization: basicAuth(credentials.clientId + ":" + credentials.secret),
        "Content-Type": "application/x-www-form-urlencoded",
    }, "grant_type=client_credentials");
    if (response?.statusCode !== 200 || !response.json?.access_token) {
        throw new ApiError(502, "PayPal Sandbox ist gerade nicht verfügbar.");
    }
    return { Authorization: "Bearer " + response.json.access_token, "Content-Type": "application/json", Prefer: "return=representation" };
}

function find(app, collection, filter, bindings) {
    return app.findRecordsByFilter(collection, filter, "", 1, 0, bindings)[0];
}

const itemsOf = order => JSON.parse(order.getString("items"));
const amountOf = order => (order.getInt("price_cents") / 100).toFixed(2);
const privateFile = (app, product) => find(app, "own_product_downloads", "product = {:product}", { product });

function createOrder(app, input, receiptHash, credentials) {
    const ids = input.product_ids ?? [input.product_id];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
        ids.some(id => !["number", "string"].includes(typeof id) || !/^[1-9][0-9]{0,14}$/.test(String(id)))) {
        throw new BadRequestError("Ungültige Produktauswahl.");
    }
    const productIds = [...new Set(ids.map(String))].sort();
    let order;
    app.runInTransaction(tx => {
        order = find(tx, orders, "receipt_hash = {:receiptHash}", { receiptHash });
        if (order) {
            if (JSON.stringify(itemsOf(order).map(item => item.product_id)) !== JSON.stringify(productIds)) {
                throw new BadRequestError("Der Warenkorb hat sich geändert.");
            }
            return;
        }
        const items = productIds.map(id => {
            const product = find(tx, "own_products", "legacy_id = {:id} && active = true", { id });
            const cents = product ? JSON.parse(product.getString("price_cents") || "null") : null;
            if (!Number.isInteger(cents) || cents < 1 || !privateFile(tx, product.id)) {
                throw new BadRequestError("Ein Produkt ist gerade nicht verfügbar.");
            }
            return { product_id: id, record_id: product.id, product_name: product.getString("name"), cents };
        });
        order = new Record(tx.findCollectionByNameOrId(orders));
        order.set("receipt_hash", receiptHash);
        order.set("items", items);
        order.set("price_cents", items.reduce((total, item) => total + item.cents, 0));
        tx.save(order);
    });
    if (order.getString("paypal_id")) return { id: order.getString("paypal_id") };
    if (Date.now() - Date.parse(order.getString("created_at")) > 3 * 3600000) {
        throw new BadRequestError("Bitte starte eine neue Bestellung.");
    }
    const headers = paypalSession(credentials);
    headers["PayPal-Request-Id"] = "sandbox-create-" + order.id;
    const response = paypal("/v2/checkout/orders", "POST", headers, JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ reference_id: order.id, amount: { currency_code: "EUR", value: amountOf(order) } }],
        payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } },
    }));
    const id = response?.json?.id;
    if ((response?.statusCode !== 201 && response?.statusCode !== 200) || !/^[A-Z0-9]{10,32}$/.test(id || "")) {
        throw new ApiError(502, "Die PayPal-Bestellung konnte nicht erstellt werden.");
    }
    app.runInTransaction(tx => {
        const current = tx.findRecordById(orders, order.id);
        if (current.getString("paypal_id")) return;
        current.set("paypal_id", id);
        tx.save(current);
    });
    return { id: app.findRecordById(orders, order.id).getString("paypal_id") };
}

function completeCapture(data, order) {
    if (data?.id !== order.getString("paypal_id") || data.status !== "COMPLETED" || data.purchase_units?.length !== 1) return null;
    const unit = data.purchase_units[0], captures = unit.payments?.captures;
    const capture = captures?.[0];
    return unit.reference_id === order.id && captures?.length === 1 &&
        capture.status === "COMPLETED" && capture.amount?.currency_code === "EUR" &&
        capture.amount.value === amountOf(order) && capture.id ? capture : null;
}

function captureOrder(app, order, credentials) {
    if (!order.getString("capture_id")) {
        const endpoint = "/v2/checkout/orders/" + order.getString("paypal_id");
        const headers = paypalSession(credentials);
        const response = paypal(endpoint + "/capture", "POST",
            { ...headers, "PayPal-Request-Id": "sandbox-capture-" + order.id }, "{}");
        let capture = completeCapture(response?.json, order);
        if (!capture) capture = completeCapture(paypal(endpoint, "GET", headers, "")?.json, order);
        if (!capture) throw new ApiError(409, "PayPal hat die Zahlung noch nicht bestätigt.");
        order.set("capture_id", capture.id);
        app.save(order);
    }
    return { completed: true, order_id: order.getString("paypal_id"),
        downloads: itemsOf(order).map(({ product_id, product_name }) => ({ product_id, product_name })),
    };
}

function completedFile(app, order, product) {
    const item = itemsOf(order).find(item => item.product_id === product);
    if (!order.getString("capture_id") || !item) throw new NotFoundError();
    const record = privateFile(app, item.record_id);
    if (!record?.getString("document")) throw new NotFoundError();
    return record;
}

function signature(order, product, expires, signingKey) {
    return $security.hs256(`findora-sandbox-download:${order}:${product}:${expires}`, signingKey);
}

function invoke(e) {
    const credentials = settings();
    if (!configured(credentials)) throw new ApiError(503, "PayPal Sandbox ist noch nicht eingerichtet.");
    const input = e.requestInfo().body;
    if (typeof input.receipt !== "string" || !/^[a-f0-9]{64}$/.test(input.receipt)) throw new NotFoundError();
    const receiptHash = $security.sha256(input.receipt);
    const action = e.request.pathValue("action");
    if (action === "paypal-create-order") return e.json(200, createOrder(e.app, input, receiptHash, credentials));
    if (action !== "paypal-capture-order" && action !== "record-download") throw new NotFoundError();
    const orderId = input.order_id;
    if (typeof orderId !== "string" || !/^[A-Z0-9]{10,32}$/.test(orderId)) throw new NotFoundError();
    const order = find(e.app, orders, "paypal_id = {:orderId}", { orderId });
    if (!order || !$security.equal(order.getString("receipt_hash"), receiptHash)) throw new NotFoundError();
    if (action === "paypal-capture-order") return e.json(200, captureOrder(e.app, order, credentials));
    const product = String(input.product_id);
    const file = completedFile(e.app, order, product);
    const expires = Math.floor(Date.now() / 1000) + 300;
    const sig = encodeURIComponent(signature(orderId, product, expires, credentials.signingKey));
    return e.json(200, { download_url: `${path}/download/${orderId}/${product}?expires=${expires}&sig=${sig}`,
        file_name: file.getString("download_name") });
}

function download(e) {
    const { signingKey } = settings();
    const orderId = e.request.pathValue("order"), product = e.request.pathValue("product");
    const query = e.request.url.query(), expires = query.get("expires"), sig = query.get("sig");
    const secondsLeft = Number(expires) - Math.floor(Date.now() / 1000);
    if (!signingKey || !/^[A-Z0-9]{10,32}$/.test(orderId) || !/^[1-9][0-9]{0,14}$/.test(product) ||
        !/^[0-9]{10}$/.test(expires) || secondsLeft < 1 || secondsLeft > 300 ||
        !$security.equal(signature(orderId, product, expires, signingKey), sig)) throw new NotFoundError();
    const order = find(e.app, orders, "paypal_id = {:orderId}", { orderId });
    if (!order) throw new NotFoundError();
    const file = completedFile(e.app, order, product);
    const fs = e.app.newFilesystem();
    try {
        const reader = fs.getReader(file.baseFilesPath() + "/" + file.getString("document"));
        try {
            const name = encodeURIComponent(file.getString("download_name")).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16));
            e.response.header().set("Content-Disposition", `attachment; filename="findora-download.pdf"; filename*=UTF-8''${name}`);
            e.response.header().set("Cache-Control", "private, no-store");
            return e.stream(200, "application/pdf", reader);
        } finally { reader.close(); }
    } finally { fs.close(); }
}

module.exports = { config, invoke, download };
