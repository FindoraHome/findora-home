$app.rootCmd.addCommand(new Command({
    use: "import-findora-catalog <snapshot.json>",
    short: "Import a Findora catalog snapshot exported from Supabase",
    run: (_command, args) => {
        if (args.length !== 1) {
            throw new Error("Expected one catalog snapshot path.");
        }

        const snapshot = JSON.parse(toString($os.readFile(args[0])));
        const collections = {
            categories: ["name", "sort_order"],
            partners: ["name", "sort_order"],
            products: ["name", "description", "link", "category", "image_url", "partner", "featured", "is_disney"],
        };

        for (const name of Object.keys(collections)) {
            if (!Array.isArray(snapshot[name])) {
                throw new Error(`Missing ${name} rows in catalog snapshot.`);
            }

            const ids = new Set();
            for (const row of snapshot[name]) {
                if (typeof row.legacy_id !== "string" || !/^\d+$/.test(row.legacy_id) || ids.has(row.legacy_id)) {
                    throw new Error(`Invalid or duplicate source ID in ${name}.`);
                }
                ids.add(row.legacy_id);
            }
        }

        $app.runInTransaction((txApp) => {
            const sourceDetailsCollection = txApp.findCollectionByNameOrId("product_source_details");
            const detailsByProduct = new Map(txApp.findAllRecords(sourceDetailsCollection)
                .map((record) => [record.getString("product"), record]));

            for (const [name, fields] of Object.entries(collections)) {
                const collection = txApp.findCollectionByNameOrId(name);
                const recordsByLegacyId = new Map(txApp.findAllRecords(collection)
                    .map((record) => [record.getString("legacy_id"), record]));

                if (name === "products") {
                    const featuredProduct = snapshot.products.find((row) => row.featured === true);
                    const previousFeature = Array.from(recordsByLegacyId.values())
                        .find((record) => record.getBool("featured"));
                    if (previousFeature && previousFeature.getString("legacy_id") !== featuredProduct?.legacy_id) {
                        previousFeature.set("featured", false);
                        txApp.save(previousFeature);
                    }
                }

                for (const row of snapshot[name]) {
                    const record = recordsByLegacyId.get(row.legacy_id) || new Record(collection);
                    record.set("legacy_id", row.legacy_id);
                    record.set("active", row.active === true);
                    record.set("created_at", row.created_at);
                    for (const field of fields) {
                        record.set(field, row[field]);
                    }
                    txApp.save(record);

                    if (name === "products") {
                        const details = detailsByProduct.get(record.id) || new Record(sourceDetailsCollection);
                        details.set("product", record.id);
                        details.set("normal_link", row.normal_link);
                        details.set("keywords", row.keywords);
                        txApp.save(details);
                    }
                }
            }
        });

        for (const name of Object.keys(collections)) {
            console.log(`${name}: ${snapshot[name].length} rows imported`);
        }
    },
}));
