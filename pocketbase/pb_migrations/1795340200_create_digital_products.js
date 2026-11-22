migrate((app) => {
    const products = new Collection({
        type: "base",
        name: "own_products",
        listRule: "active = true",
        viewRule: "active = true",
        fields: [
            { name: "legacy_id", type: "text", required: true, pattern: "^[0-9]+$" },
            { name: "created_at", type: "date", required: true },
            { name: "name", type: "text", required: true, max: 140 },
            { name: "description", type: "text", max: 3000 },
            { name: "price_cents", type: "json", maxSize: 32 },
            { name: "purchase_url", type: "text", max: 1000 },
            { name: "active", type: "bool" },
            { name: "image", type: "file", maxSelect: 1, maxSize: 10 * 1024 * 1024,
                mimeTypes: ["image/webp", "image/avif", "image/png", "image/jpeg"] },
            { name: "image_import_sha256", type: "text", hidden: true, pattern: "^[a-f0-9]{64}$" },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_own_products_legacy_id ON own_products (legacy_id)"],
    });
    app.save(products);

    app.save(new Collection({
        type: "base",
        name: "own_product_downloads",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: "product", type: "relation", collectionId: products.id, maxSelect: 1, required: true },
            { name: "download_name", type: "text", required: true },
            { name: "document", type: "file", required: true, protected: true, maxSelect: 1,
                maxSize: 50 * 1024 * 1024, mimeTypes: ["application/pdf"] },
            { name: "import_sha256", type: "text", hidden: true, pattern: "^[a-f0-9]{64}$" },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_own_product_downloads_product ON own_product_downloads (product)"],
    }));
});
