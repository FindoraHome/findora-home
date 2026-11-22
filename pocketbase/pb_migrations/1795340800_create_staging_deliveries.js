migrate((app) => {
    app.save(new Collection({ name: "staging_deliveries", type: "base", fields: [
        { name: "key", type: "text", max: 150 },
        { name: "kind", type: "text", max: 30, required: true },
        { name: "body", type: "text", max: 7000 },
        { name: "destination", type: "text", max: 64 },
        { name: "created_at", type: "date", required: true },
        { name: "sent_at", type: "date" },
        { name: "attempts", type: "number", onlyInt: true, min: 0 },
    ], indexes: [
        "CREATE UNIQUE INDEX idx_staging_deliveries_key ON staging_deliveries (key) WHERE key <> ''",
        "CREATE INDEX idx_staging_deliveries_pending ON staging_deliveries (kind, sent_at, created_at)",
    ] }));
});
