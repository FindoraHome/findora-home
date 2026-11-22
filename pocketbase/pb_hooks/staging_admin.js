function related(app, collection, product) {
    return app.findRecordsByFilter(collection, "product = {:product}", "", 1, 0, { product })[0];
}

function productCollection(name) {
    if (name !== "products" && name !== "own_products") {
        throw new NotFoundError("Unbekannter Produktbereich.");
    }
    return name;
}

function readProduct(app, collection, id) {
    const record = app.findRecordsByFilter(collection, "id = {:id}", "", 1, 0, { id })[0];
    if (!record) throw new NotFoundError("Produkt nicht gefunden.");
    return record;
}

function newCatalogRecord(app, collection) {
    const record = new Record(app.findCollectionByNameOrId(collection));
    let legacyId = Date.now() * 1000;
    while (app.findRecordsByFilter(collection, "legacy_id = {:id}", "", 1, 0, { id: String(legacyId) }).length) legacyId++;
    record.set("legacy_id", String(legacyId));
    record.set("created_at", new Date().toISOString());
    if (collection === "own_products") record.set("staging_only", true);
    return record;
}

function productDetails(record, collection, details) {
    const item = {
        id: record.id,
        name: record.getString("name"),
        description: record.getString("description"),
        active: record.getBool("active"),
        image: record.getString("image"),
    };
    if (collection === "products") {
        for (const name of ["link", "category", "partner"]) item[name] = record.getString(name);
        item.normal_link = details?.getString("normal_link") || "";
        item.featured = record.getBool("featured");
        item.is_disney = record.getBool("is_disney");
    } else {
        item.price_cents = JSON.parse(record.getString("price_cents") || "null");
        item.purchase_url = record.getString("purchase_url");
        item.download_name = details?.getString("download_name") || "";
    }
    const revision = $security.sha256(JSON.stringify([item, details?.getString("document") || ""]));
    return { ...item, revision };
}

function text(value, max, required = false) {
    if (typeof value !== "string" || Array.from(value).length > max || (required && !value.trim())) {
        throw new BadRequestError("Bitte überprüfe die Produktangaben.");
    }
    return value.trim();
}

function webUrl(value) {
    const url = text(value, 4000);
    if (url && !/^https?:\/\/[^\s/]+[^\s]*$/i.test(url)) {
        throw new BadRequestError("Links müssen mit https:// oder http:// beginnen.");
    }
    return url;
}

function uploadedFile(e, field, replace) {
    if (replace !== true) return null;
    const files = e.findUploadedFiles(field);
    if (files.length !== 1) throw new BadRequestError("Bitte wähle genau eine Datei aus.");
    return files[0];
}

function relatedCollection(collection) {
    return collection === "products" ? "product_source_details" : "own_product_downloads";
}

function catalog(e) {
    const options = (name) => e.app.findRecordsByFilter(name, "", "sort_order,name", 0, 0).map(record => ({
        id: record.id, name: record.getString("name"), active: record.getBool("active"),
    }));
    const downloads = new Set(e.app.findAllRecords("own_product_downloads").map(record => record.getString("product")));
    const products = ["products", "own_products"].flatMap(collection => e.app.findAllRecords(collection)
        .map(record => {
            const summary = { collection, id: record.id, active: record.getBool("active") };
            for (const name of ["name", "description", "image", "created_at", "legacy_id"]) summary[name] = record.getString(name);
            if (collection === "products") {
                for (const name of ["link", "category", "partner"]) summary[name] = record.getString(name);
                summary.featured = record.getBool("featured");
            } else {
                summary.price_cents = JSON.parse(record.getString("price_cents") || "null");
                summary.has_download = downloads.has(record.id);
            }
            return summary;
        }));
    return e.json(200, { products, categories: options("categories"), partners: options("partners") });
}

function details(e) {
    const collection = productCollection(e.request.pathValue("collection"));
    const record = readProduct(e.app, collection, e.request.pathValue("id"));
    return e.json(200, productDetails(record, collection, related(e.app, relatedCollection(collection), record.id)));
}

function save(e) {
    const collection = productCollection(e.request.pathValue("collection"));
    const id = e.request.pathValue("id");
    const isNew = id === "new";
    const body = new DynamicModel({ payload: "" });
    e.bindBody(body);
    let input;
    try {
        input = JSON.parse(body.payload);
    } catch (_) {
        throw new BadRequestError("Ungültige Produktdaten.");
    }
    if (!input || typeof input.active !== "boolean" || (!isNew && typeof input.revision !== "string")) {
        throw new BadRequestError("Ungültige Produktdaten.");
    }

    const image = uploadedFile(e, "image", input.replace_image);
    const production = $os.getenv("FINDORA_SITE_MODE") === "production";
    const document = collection === "own_products" ? uploadedFile(e, "document", input.replace_document) : null;
    if (isNew && (!image || (collection === "own_products" && !production && !document))) {
        throw new BadRequestError("Bitte wähle ein Produktbild und bei eigenen Produkten eine PDF-Datei aus.");
    }
    if (image && input.remove_image === true) throw new BadRequestError("Ungültige Bildänderung.");
    let saved;
    e.app.runInTransaction(txApp => {
        const product = isNew ? newCatalogRecord(txApp, collection) : readProduct(txApp, collection, id);
        const detailCollection = relatedCollection(collection);
        const existingDetails = isNew ? null : related(txApp, detailCollection, id);
        if (!isNew && input.revision !== productDetails(product, collection, existingDetails).revision) {
            throw new ApiError(409, "Das Produkt wurde geändert. Bitte lade es erneut.");
        }

        product.set("name", text(input.name, 140, true));
        product.set("description", text(input.description, 3000));
        product.set("active", input.active);
        if (image || input.remove_image === true) {
            product.set("image", image || null);
            if (collection === "products") product.set("image_url", "");
            product.set("image_import_sha256", "");
        }

        if (collection === "products") {
            product.set("link", webUrl(input.link));
            product.set("category", text(input.category, 200));
            product.set("partner", text(input.partner, 200));
            product.set("is_disney", input.is_disney === true);
            const featured = input.featured === true && input.active;
            if (featured && !product.getBool("featured")) {
                const previous = txApp.findRecordsByFilter(collection, "featured = true", "", 1, 0)[0];
                if (previous) {
                    previous.set("featured", false);
                    txApp.save(previous);
                }
            }
            product.set("featured", featured);
        } else {
            if (input.price_cents !== null && (!Number.isSafeInteger(input.price_cents) || input.price_cents < 0 || input.price_cents > 9999999999)) {
                throw new BadRequestError("Bitte gib einen gültigen Preis ein.");
            }
            product.set("price_cents", input.price_cents);
            if (!production) product.set("purchase_url", webUrl(input.purchase_url));
        }
        txApp.save(product);
        if (collection === "products" || document) {
            const item = existingDetails || new Record(txApp.findCollectionByNameOrId(detailCollection));
            item.set("product", product.id);
            if (collection === "products") item.set("normal_link", webUrl(input.normal_link));
            else {
                item.set("document", document);
                item.set("download_name", text(document.originalName, 255, true));
                item.set("import_sha256", "");
            }
            txApp.save(item);
        }
        saved = productDetails(product, collection, related(txApp, detailCollection, product.id));
    });
    return e.json(200, saved);
}

function remove(e) {
    const collection = productCollection(e.request.pathValue("collection"));
    e.app.runInTransaction(app => {
        const record = readProduct(app, collection, e.request.pathValue("id"));
        const item = related(app, relatedCollection(collection), record.id);
        if (item) app.delete(item);
        app.delete(record);
    });
    return e.json(200, { data: true });
}

function duplicate(e) {
    e.app.runInTransaction(app => {
        const original = readProduct(app, "products", e.request.pathValue("id"));
        const record = newCatalogRecord(app, "products");
        const suffix = " (Kopie)";
        record.set("name", Array.from(original.getString("name") || "Produkt").slice(0, 140 - suffix.length).join("") + suffix);
        for (const field of ["description", "link", "category", "partner"]) record.set(field, original.getString(field));
        for (const field of ["active", "is_disney"]) record.set(field, original.getBool(field));
        const image = original.getString("image");
        if (image) record.set("image", $filesystem.fileFromPath(`${app.dataDir()}/storage/${original.baseFilesPath()}/${image}`));
        app.save(record);
        const details = related(app, "product_source_details", original.id);
        if (details) {
            const copy = new Record(app.findCollectionByNameOrId("product_source_details"));
            copy.set("product", record.id);
            for (const field of ["normal_link", "keywords"]) copy.set(field, details.getString(field));
            app.save(copy);
        }
    });
    return e.json(200, { data: true });
}

function taxonomy(e) {
    const collection = e.request.pathValue("collection");
    if (!["categories", "partners"].includes(collection)) throw new NotFoundError();
    const input = e.requestInfo().body;
    const field = collection === "categories" ? "category" : "partner";
    e.app.runInTransaction(app => {
        const record = input.id ? readProduct(app, collection, input.id) : newCatalogRecord(app, collection);
        const previous = record.getString("name");
        if (input.delete === true) {
            if (!input.id) throw new BadRequestError("Ungültiger Eintrag.");
            app.delete(record);
            if (collection === "categories") return;
        } else {
            record.set("name", text(input.name, 200, true));
            if (!input.id) {
                record.set("active", true);
                record.set("sort_order", app.countRecords(collection));
            }
            app.save(record);
        }
        const name = input.delete ? "" : record.getString("name");
        if (previous && previous !== name) {
            for (const product of app.findRecordsByFilter("products", `${field} = {:previous}`, "", 0, 0, { previous })) {
                product.set(field, name);
                app.save(product);
            }
        }
    });
    return e.json(200, { data: true });
}

function links(e) {
    const products = e.app.findAllRecords("products");
    const records = e.app.findAllRecords("product_source_details");
    const details = new Map(records.map(record => [record.getString("product"), record]));
    return e.json(200, { data: products.map(record => ({ ...productDetails(record, "products", details.get(record.id)),
        legacy_id: record.getString("legacy_id"),
    })) });
}

function bulkLinks(e) {
    const updates = e.requestInfo().body.p_updates;
    if (!Array.isArray(updates) || !updates.length || updates.length > 2000) throw new BadRequestError("Ungültige Linkliste.");
    e.app.runInTransaction(app => {
        for (const update of updates) {
            if (!/^\d+$/.test(String(update.id))) throw new BadRequestError("Ungültige Produkt-ID.");
            const record = app.findRecordsByFilter("products", "legacy_id = {:id}", "", 1, 0, { id: String(update.id) })[0];
            if (!record) throw new NotFoundError("Produkt wurde nicht gefunden.");
            record.set("link", webUrl(update.link));
            app.save(record);
        }
    });
    return e.json(200, { data: updates.length });
}

module.exports = { catalog, details, save, remove, duplicate, taxonomy, links, bulkLinks };
