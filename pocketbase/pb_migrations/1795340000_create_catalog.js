migrate((app) => {
    function catalogCollection(name, fields, indexes = []) {
        return new Collection({
            type: "base",
            name,
            listRule: "active = true",
            viewRule: "active = true",
            fields: [
                { name: "legacy_id", type: "text", required: true, pattern: "^[0-9]+$" },
                { name: "active", type: "bool" },
                { name: "created_at", type: "date", required: true },
                ...fields,
            ],
            indexes: [
                `CREATE UNIQUE INDEX idx_${name}_legacy_id ON ${name} (legacy_id)`,
                ...indexes,
            ],
        });
    }

    for (const name of ["categories", "partners"]) {
        app.save(catalogCollection(name, [
            { name: "name", type: "text", required: true },
            { name: "sort_order", type: "number", onlyInt: true },
        ], [`CREATE UNIQUE INDEX idx_${name}_name ON ${name} (name)`]));
    }

    const products = catalogCollection("products", [
        { name: "name", type: "text" },
        { name: "description", type: "text" },
        { name: "link", type: "text" },
        { name: "category", type: "text" },
        { name: "image_url", type: "text" },
        { name: "partner", type: "text" },
        { name: "featured", type: "bool" },
        { name: "is_disney", type: "bool" },
    ], ["CREATE UNIQUE INDEX idx_products_featured ON products (featured) WHERE featured = true"]);
    app.save(products);

    // Supabase already limits these columns to privileged access.
    app.save(new Collection({
        type: "base",
        name: "product_source_details",
        fields: [
            { name: "product", type: "relation", collectionId: products.id,
                maxSelect: 1, required: true, cascadeDelete: true },
            { name: "normal_link", type: "text" },
            { name: "keywords", type: "text" },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_product_source_details_product ON product_source_details (product)"],
    }));
});
