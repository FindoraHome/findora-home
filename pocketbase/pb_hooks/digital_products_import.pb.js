$app.rootCmd.addCommand(new Command({
    use: "import-findora-digital-products <snapshot-directory>",
    short: "Import verified Findora digital products and protected PDFs",
    run: (_command, args) => {
        if (args.length !== 1) {
            throw new Error("Expected one digital product snapshot directory.");
        }

        const directory = args[0];
        const products = JSON.parse(toString($os.readFile(`${directory}/products.json`)));
        let imagesCopied = 0;
        let documentsCopied = 0;

        $app.runInTransaction((txApp) => {
            const productCollection = txApp.findCollectionByNameOrId("own_products");
            const downloadCollection = txApp.findCollectionByNameOrId("own_product_downloads");
            const productsByLegacyId = new Map(txApp.findAllRecords(productCollection)
                .map((record) => [record.getString("legacy_id"), record]));
            const downloadsByProduct = new Map(txApp.findAllRecords(downloadCollection)
                .map((record) => [record.getString("product"), record]));

            for (const row of products) {
                if (!/^\d+$/.test(row.legacy_id) ||
                    (row.price_cents !== null && (!Number.isSafeInteger(row.price_cents) || row.price_cents < 0))) {
                    throw new Error("Invalid source product ID or price.");
                }

                const product = productsByLegacyId.get(row.legacy_id) || new Record(productCollection);
                for (const name of ["legacy_id", "created_at", "name", "description", "price_cents", "purchase_url", "active"]) {
                    product.set(name, row[name]);
                }

                if (!product.getString("image") || product.getString("image_import_sha256") !== row.image.sha256) {
                    product.set("image", $filesystem.fileFromPath(`${directory}/${row.image.filename}`));
                    product.set("image_import_sha256", row.image.sha256);
                    imagesCopied++;
                }
                txApp.save(product);

                const download = downloadsByProduct.get(product.id) || new Record(downloadCollection);
                download.set("product", product.id);
                download.set("download_name", row.download_name);
                if (!download.getString("document") || download.getString("import_sha256") !== row.document.sha256) {
                    download.set("document", $filesystem.fileFromPath(`${directory}/${row.document.filename}`));
                    download.set("import_sha256", row.document.sha256);
                    documentsCopied++;
                }
                txApp.save(download);
            }
        });

        console.log(`Staged ${products.length} digital products, ${imagesCopied} covers and ${documentsCopied} PDFs copied.`);
    },
}));
