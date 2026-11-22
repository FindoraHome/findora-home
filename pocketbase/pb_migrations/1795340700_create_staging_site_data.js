migrate((app) => {
    const text = (name, max, required = false) => ({ name, type: "text", max, required });
    const date = name => ({ name, type: "date", required: true });
    const json = (name, maxSize = 65536) => ({ name, type: "json", maxSize });
    function collection(name, fields, indexes) {
        app.save(new Collection({ name, type: "base", fields, indexes }));
    }
    collection("staging_site_settings", [text("key", 80, true), json("value")], [
        "CREATE UNIQUE INDEX idx_staging_site_settings_key ON staging_site_settings (key)",
    ]);
    collection("staging_site_events", [text("kind", 8, true), text("source_id", 30), text("product", 25),
        text("visitor", 64), text("term", 100), date("occurred_at")], [
        "CREATE INDEX idx_staging_events_kind_date ON staging_site_events (kind, occurred_at)",
        "CREATE INDEX idx_staging_events_kind_product ON staging_site_events (kind, product)",
        "CREATE UNIQUE INDEX idx_staging_events_source ON staging_site_events (kind, source_id) WHERE source_id <> ''",
        "CREATE UNIQUE INDEX idx_staging_events_vote ON staging_site_events (kind, product, visitor) WHERE visitor <> '' AND kind IN ('visit', 'like')",
    ]);
    collection("staging_contact_messages", [text("source_id", 30), text("name", 200), text("email", 254),
        text("topic", 160, true), text("message", 5000, true), text("sender", 64), date("created_at"),
        { name: "is_read", type: "bool" }], [
        "CREATE UNIQUE INDEX idx_staging_contacts_source ON staging_contact_messages (source_id) WHERE source_id <> ''",
        "CREATE INDEX idx_staging_contacts_sender_date ON staging_contact_messages (sender, created_at)",
    ]);
    collection("staging_amazon_reports", [text("fingerprint", 128, true), json("entry"), date("imported_at")], [
        "CREATE UNIQUE INDEX idx_staging_amazon_fingerprint ON staging_amazon_reports (fingerprint)",
    ]);
});
