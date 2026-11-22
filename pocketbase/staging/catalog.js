(() => {
    async function records(collection, options = {}) {
        const query = new URLSearchParams({ ...options, perPage: "200" });
        const items = [];
        let page = 1;
        let totalPages;

        do {
            query.set("page", String(page++));
            const response = await fetch(`/api/collections/${collection}/records?${query}`);
            if (!response.ok) throw new Error(`Katalogabfrage fehlgeschlagen (${response.status}).`);
            const result = await response.json();
            items.push(...result.items);
            totalPages = result.totalPages;
        } while (page <= totalPages);

        return items;
    }

    function imageUrl(collection, record) {
        return record.image
            ? `/api/files/${collection}/${encodeURIComponent(record.id)}/${encodeURIComponent(record.image)}`
            : "";
    }

    function product(record) {
        const { legacy_id, name, description, link, category, active, created_at, partner, featured, is_disney } = record;
        return {
            id: legacy_id, name, description, category, active, partner, featured, is_disney,
            created_at: created_at.replace(" ", "T"),
            link: /^https?:\/\//i.test(link) ? link : "",
            image_url: imageUrl("products", record),
        };
    }

    window.FindoraStagingCatalog = {
        async home() {
            const [products, categories, partners] = await Promise.all([
                records("products", { sort: "-created_at,id" }),
                records("categories", { sort: "sort_order,id" }),
                records("partners", { sort: "sort_order,id" }),
            ]);
            return { products: products.map(product), categories, partners };
        },
        async disney() {
            const products = await records("products", { filter: "is_disney = true", sort: "-created_at,id" });
            return products.map(product);
        },
        async digital() {
            const products = await records("own_products", { sort: "-created_at,id" });
            return products.map(record => ({
                id: record.legacy_id,
                name: record.name,
                description: record.description,
                price: record.price_cents == null ? null : record.price_cents / 100,
                staging_only: record.staging_only === true,
                image_url: imageUrl("own_products", record),
            }));
        },
    };
})();
