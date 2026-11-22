$app.rootCmd.addCommand(new Command({
    use: "import-findora-staging-admins <snapshot.json>",
    short: "Create private staging accounts for the existing Findora admins",
    run: (_command, args) => {
        if (args.length !== 1) throw new Error("Expected one private admin snapshot.");
        const accounts = JSON.parse(toString($os.readFile(args[0])));
        if (!Array.isArray(accounts) || !accounts.length) throw new Error("No source admin accounts found.");

        $app.runInTransaction((txApp) => {
            const collection = txApp.findCollectionByNameOrId("findora_admins");
            const passwordField = collection.fields.getByName("password");
            for (const account of accounts) {
                if (typeof account.email !== "string" || !account.email ||
                    !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(account.password_hash)) {
                    throw new Error("Source admin record is missing a supported password hash.");
                }
                const matches = txApp.findRecordsByFilter(collection, "email = {:email}", "", 1, 0, { email: account.email });
                const admin = matches[0] || new Record(collection);
                admin.setEmail(account.email);
                admin.setVerified(account.verified === true);
                if (admin.getString("password:hash") !== account.password_hash) {
                    admin.setRaw("password", passwordField.prepareValue(admin, account.password_hash));
                    admin.refreshTokenKey();
                }
                txApp.save(admin);
                const saved = txApp.findRecordById(collection, admin.id);
                if (saved.getString("password:hash") !== account.password_hash) {
                    throw new Error("Imported password hash did not match the source.");
                }
            }
        });

        console.log(`Verified ${accounts.length} staging admin password hashes.`);
    },
}));
