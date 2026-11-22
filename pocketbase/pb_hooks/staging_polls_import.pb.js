$app.rootCmd.addCommand(new Command({
    use: "import-findora-staging-polls <snapshot.json>",
    short: "Copy saved Findora polls and aggregate results into staging",
    run: (_command, args) => {
        if (args.length !== 1) throw new Error("Expected one poll snapshot file.");
        const rows = JSON.parse(toString($os.readFile(args[0])));
        let imported = 0;
        $app.runInTransaction(app => {
            const collection = app.findCollectionByNameOrId("staging_polls");
            const existing = new Set(app.findAllRecords(collection).map(record => record.getString("legacy_id")));
            for (const row of rows) {
                if (existing.has(row.legacy_id)) continue;
                const record = new Record(collection);
                for (const field of ["legacy_id", "question", "active", "created_at", "ends_at", "participant_goal", "options", "imported_participants"]) {
                    record.set(field, row[field]);
                }
                app.save(record);
                existing.add(row.legacy_id);
                imported++;
            }
        });
        console.log(`Copied ${imported} of ${rows.length} saved polls from the backup.`);
    },
}));
