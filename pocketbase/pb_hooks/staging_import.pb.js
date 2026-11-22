$app.rootCmd.addCommand(new Command({
    use: "import-findora-staging <snapshot-directory>",
    short: "Import the verified Supabase backup into PocketBase staging",
    run: (_command, args) => {
        if (args.length !== 1) throw new Error("Expected one verified snapshot directory.");
        const directory = args[0];
        const snapshot = JSON.parse(toString($os.readFile(`${directory}/snapshot.json`)));
        const keys = {
            categories: ["legacy_id"], partners: ["legacy_id"], products: ["legacy_id"], own_products: ["legacy_id"],
            findora_admins: ["email"], staging_polls: ["legacy_id"], staging_site_settings: ["key"],
            staging_site_events: ["kind", "source_id"], staging_contact_messages: ["source_id"],
            staging_amazon_reports: ["fingerprint"],
        };
        const copyFile = asset => {
            if (!/^\d+-(?:product|cover|download)\.(?:webp|avif|png|jpg|pdf)$/.test(asset.filename) ||
                !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid verified asset metadata.");
            return $filesystem.fileFromPath(`${directory}/assets/${asset.filename}`);
        };
        const totals = {};

        $app.runInTransaction(app => {
            let featured = app.findRecordsByFilter("products", "featured = true", "", 1, 0).length > 0;
            for (const [name, identity] of Object.entries(keys)) {
                if (!Array.isArray(snapshot[name])) throw new Error(`Missing ${name} in the snapshot.`);
                const collection = app.findCollectionByNameOrId(name);
                const existing = new Set(app.findAllRecords(collection).map(record => JSON.stringify(identity.map(key => record.getString(key)))));
                let imported = 0;
                for (const entry of snapshot[name]) {
                    const key = JSON.stringify(identity.map(field => entry[field]));
                    if (existing.has(key)) continue;
                    const record = new Record(collection);
                    const { image, source, download, hash, ...fields } = entry;
                    for (const [field, value] of Object.entries(fields)) record.set(field, value);
                    if (name === "findora_admins") {
                        if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) throw new Error("Unsupported source admin password hash.");
                        record.setVerified(true);
                        record.setRaw("password", collection.fields.getByName("password").prepareValue(record, hash));
                    }
                    if (name === "products" && fields.featured) {
                        record.set("featured", !featured);
                        featured = true;
                    }
                    if (image) {
                        record.set("image", copyFile(image));
                        record.set("image_import_sha256", image.sha256);
                    }
                    app.save(record);
                    if (source) {
                        const details = new Record(app.findCollectionByNameOrId("product_source_details"));
                        details.set("product", record.id);
                        details.set("normal_link", source.normal_link);
                        details.set("keywords", source.keywords);
                        app.save(details);
                    }
                    if (download) {
                        const details = new Record(app.findCollectionByNameOrId("own_product_downloads"));
                        details.set("product", record.id);
                        details.set("document", copyFile(download));
                        details.set("download_name", download.name);
                        details.set("import_sha256", download.sha256);
                        app.save(details);
                    }
                    if (name === "findora_admins" && app.findRecordById(collection, record.id).getString("password:hash") !== hash) {
                        throw new Error("The staging admin hash did not match the source.");
                    }
                    existing.add(key);
                    imported++;
                }
                totals[name] = { imported, source: snapshot[name].length };
            }
        });
        console.log(JSON.stringify(totals));
    },
}));
