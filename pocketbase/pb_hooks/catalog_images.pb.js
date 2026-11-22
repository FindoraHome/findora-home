$app.rootCmd.addCommand(new Command({
    use: "import-findora-catalog-images <snapshot-directory>",
    short: "Attach downloaded Supabase images to the staged catalog",
    run: (_command, args) => {
        if (args.length !== 1) {
            throw new Error("Expected one catalog image snapshot directory.");
        }

        const directory = args[0];
        const entries = JSON.parse(toString($os.readFile(`${directory}/images.json`)));
        const products = new Map($app.findAllRecords("products")
            .map((record) => [record.getString("legacy_id"), record]));
        let copied = 0;
        let unchanged = 0;

        for (const entry of entries) {
            if (!/^\d+\.(webp|avif|png|jpg)$/.test(entry.filename) ||
                !/^[a-f0-9]{64}$/.test(entry.sha256)) {
                throw new Error("Invalid image snapshot entry.");
            }
            const product = products.get(entry.legacy_id);
            if (!product || product.getString("image_url") !== entry.source_url) {
                throw new Error(`Source image changed for product ${entry.legacy_id}.`);
            }

            if (product.getString("image") && product.getString("image_import_sha256") === entry.sha256) {
                unchanged++;
                continue;
            }

            product.set("image", $filesystem.fileFromPath(`${directory}/${entry.filename}`));
            product.set("image_import_sha256", entry.sha256);
            $app.save(product);
            copied++;
        }

        console.log(`Catalog images: ${copied} copied, ${unchanged} already present.`);
    },
}));
