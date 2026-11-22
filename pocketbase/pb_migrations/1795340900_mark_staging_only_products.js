migrate((app) => {
    const collection = app.findCollectionByNameOrId("own_products");
    collection.fields.add(new BoolField({ name: "staging_only" }));
    app.save(collection);
    // The staging catalog allocates a microsecond-style legacy ID for records it creates.
    for (const record of app.findAllRecords(collection)) {
        if (!/^\d{16}$/.test(record.getString("legacy_id"))) continue;
        record.set("staging_only", true);
        app.save(record);
    }
});
