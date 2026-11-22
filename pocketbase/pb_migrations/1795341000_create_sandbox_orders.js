migrate(app => {
    app.save(new Collection({
        type: "base",
        name: "sandbox_orders",
        fields: [
            { name: "receipt_hash", type: "text", required: true },
            { name: "paypal_id", type: "text" },
            { name: "capture_id", type: "text" },
            { name: "items", type: "json", required: true },
            { name: "price_cents", type: "number", onlyInt: true, required: true },
            { name: "created_at", type: "autodate", onCreate: true },
        ],
        indexes: [
            "CREATE UNIQUE INDEX idx_sandbox_orders_receipt ON sandbox_orders (receipt_hash)",
            "CREATE UNIQUE INDEX idx_sandbox_orders_paypal ON sandbox_orders (paypal_id) WHERE paypal_id != ''",
        ],
    }));
}, app => app.delete(app.findCollectionByNameOrId("sandbox_orders")));
