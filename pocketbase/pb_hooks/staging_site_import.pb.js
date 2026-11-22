$app.rootCmd.addCommand(new Command({
    use: "import-findora-staging-site <snapshot.json>",
    short: "Import Findora settings, inbox, analytics and affiliate reports",
    run: (_command, args) => {
        if (args.length !== 1) throw new Error("Expected one website snapshot file.");
        const rows = JSON.parse(toString($os.readFile(args[0])));
        const keys = {
            staging_site_events: ["kind", "source_id"], staging_site_settings: ["key"],
            staging_contact_messages: ["source_id"], staging_amazon_reports: ["fingerprint"],
        };
        const totals = {};
        $app.runInTransaction(app => {
            for (const [table, fields] of Object.entries(keys)) {
                const collection = app.findCollectionByNameOrId(table);
                const identity = parts => parts.join(":");
                const existing = new Set(app.findAllRecords(collection).map(row => identity(fields.map(key => row.getString(key)))));
                let copied = 0;
                for (const row of rows[table]) {
                    const key = identity(fields.map(field => row[field]));
                    if (existing.has(key)) continue;
                    const item = new Record(collection);
                    for (const [name, value] of Object.entries(row)) item.set(name, value);
                    app.save(item);
                    existing.add(key);
                    copied++;
                }
                totals[table] = { saved: copied, source: rows[table].length };
            }
        });
        console.log(JSON.stringify(totals));
    },
}));
