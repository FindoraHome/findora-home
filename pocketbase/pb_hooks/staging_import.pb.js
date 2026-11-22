$app.rootCmd.addCommand(new Command({
    use: "import-findora <snapshot-directory>",
    aliases: ["import-findora-staging"],
    short: "Import a verified Supabase backup into Findora PocketBase",
    run: (_command, args) => {
        if (args.length !== 1) throw new Error("Expected one verified snapshot directory.");
        const directory = args[0];
        const snapshot = JSON.parse(toString($os.readFile(`${directory}/snapshot.json`)));
        const production = $os.getenv("FINDORA_SITE_MODE") === "production";
        if ((snapshot.mode === "production") !== production) throw new Error("The snapshot and PocketBase environment do not match.");
        const keys = {
            categories: ["legacy_id"], partners: ["legacy_id"], products: ["legacy_id"], own_products: ["legacy_id"],
            findora_admins: ["email"], staging_polls: ["legacy_id"], staging_site_settings: ["key"],
            staging_site_events: ["kind", "source_id"], staging_contact_messages: ["source_id"],
            staging_amazon_reports: ["fingerprint"],
        };
        if (production) keys.staging_deliveries = ["key"];
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
                    const { image, source, download, hash, ballots, results_sent, ...fields } = entry;
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
                    if (production && name === "staging_polls") {
                        const ballotCollection = app.findCollectionByNameOrId("staging_poll_ballots");
                        for (const { voter, choices } of ballots) {
                            const ballot = new Record(ballotCollection);
                            ballot.set("poll", record.id);
                            ballot.set("voter", voter);
                            ballot.set("choices", choices);
                            app.save(ballot);
                        }
                        if (results_sent) {
                            const sent = new Record(app.findCollectionByNameOrId("staging_deliveries"));
                            const ends = record.getString("ends_at").replace(" ", "T");
                            sent.set("key", `poll-result:${record.id}:${ends}`);
                            sent.set("kind", "dolly");
                            sent.set("created_at", ends);
                            sent.set("sent_at", ends);
                            app.save(sent);
                        }
                    }
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
