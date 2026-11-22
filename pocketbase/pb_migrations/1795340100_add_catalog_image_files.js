migrate((app) => {
    const products = app.findCollectionByNameOrId("products");
    products.fields.add(new FileField({
        name: "image",
        maxSelect: 1,
        maxSize: 10 * 1024 * 1024,
        mimeTypes: ["image/webp", "image/avif", "image/png", "image/jpeg"],
    }));
    products.fields.add(new TextField({
        name: "image_import_sha256",
        hidden: true,
        pattern: "^[a-f0-9]{64}$",
    }));
    app.save(products);
});
