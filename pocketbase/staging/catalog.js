(() => {
    // Promotional composites found in the public catalog. Match the file so a
    // replacement image for the same product can appear immediately.
    const suppressedProductImages = new Set([
        "2_product_yaaplquplp.png",
        "3_product_an9dfpqjg4.png",
        "4_product_1iknq97nhb.png",
        "5_product_m4v2mzslrj.png",
        "6_product_i9s7jjcmez.png",
        "7_product_eshlts91vf.png",
        "51_product_5a18kkljft.webp",
        "64_product_f2g6yh0kue.webp",
        "72_product_5ks7qjai2a.webp",
        "78_product_rf3bj55f7t.webp",
        "79_product_e9j31mbj4a.webp",
        "80_product_6tixsn870f.webp",
        "101_product_57xunywzmf.webp",
        "113_product_rt05c6fqey.webp",
        "117_product_vwy5dlwsvv.webp",
        "141_product_xg218b2o0k.webp",
        "146_product_s9srxicp54.webp",
        "147_product_qj5w2z9ch0.webp",
        "173_product_w746m3ei6s.webp",
        "174_product_2dpdbqv5wy.webp",
        "176_product_3brbksbqul.webp",
        "177_product_6xm9wakm81.webp",
        "178_product_mg58z5ifwo.webp",
        "186_product_iefgtvlhia.webp",
        "187_product_9u0chl5blq.webp",
        "188_product_7fgm973pcz.webp",
        "193_product_mh7rf5qda8.webp",
        "197_product_iq1mfaftw1.webp",
        "200_product_za9r33u0zx.webp",
        "201_product_b7kcdbj2d6.webp",
        "202_product_fgaf2xxyp3.webp",
        "204_product_cxdwmn4j2r.webp",
        "205_product_u58u6hxsmp.webp",
        "207_product_c7dgty5g2l.webp",
        "208_product_tuj8vpafup.webp",
        "210_product_jml7jwdvic.webp",
        "211_product_qmcfo2liun.webp",
        "212_product_f4y91rs3ea.webp",
        "213_product_2iudxttxo7.webp",
        "214_product_sfrzyq6j4y.webp",
        "215_product_9011z1a4lz.webp",
        "216_product_e41wzpwdmu.webp",
        "222_product_ov5ztzd1ar.webp",
        "227_product_6sao0m8da4.webp",
        "228_product_nn0utctb90.webp",
        "229_product_d186qu2zvb.webp",
        "230_product_7a66w4nidi.webp",
        "234_product_6wz9stkx9c.webp",
        "238_product_cx4ne9jp3n.webp",
        "239_product_wnf8bxoz6e.webp",
        "240_product_uooyjsx2m5.webp",
        "241_product_x3yvizk14i.webp",
        "242_product_lzk0y34v8b.webp",
        "243_product_7pk58qzfmg.webp",
        "244_product_mhbjyws9pz.webp",
        "245_product_brsno87ni1.webp",
        "246_product_cp4g2fjnrt.webp",
        "247_product_j4kw5m62e8.webp",
        "248_product_xr9crxiauz.webp",
        "249_product_wrg6bkg2mi.webp",
        "250_product_ydvo3szf2a.webp",
        "252_product_ucnx2nxv9o.webp",
        "253_product_iegy8sa685.webp",
        "254_product_n0ywbhix6w.webp",
        "255_product_s4bl9c5l68.webp",
        "260_product_wu6li4zw5o.webp",
        "1000248307_39zq8crkua.webp",
    ]);

    async function records(collection, options = {}) {
        const query = new URLSearchParams({ ...options, perPage: "200" });
        const items = [];
        let page = 1;
        let totalPages;

        do {
            query.set("page", String(page++));
            const url = window.FindoraStagingSite.apiUrl(`/api/collections/${collection}/records?${query}`);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Katalogabfrage fehlgeschlagen (${response.status}).`);
            const result = await response.json();
            items.push(...result.items);
            totalPages = result.totalPages;
        } while (page <= totalPages);

        return items;
    }

    function product(record) {
        const { legacy_id, name, description, link, category, active, created_at, partner, featured, is_disney } = record;
        const listing = {
            id: legacy_id, name, description, category, active, partner, featured, is_disney,
            created_at: created_at.replace(" ", "T"),
            link: /^https?:\/\//i.test(link) ? link : "",
            image_url: suppressedProductImages.has(record.image) ? "" : window.FindoraStagingSite.fileUrl("products", record),
        };

        if (name === "Amazon Prime" && link === "https://link.amazon/A07YzjAQ0") {
            listing.name = "Prime Video";
            listing.description = "Auf Prime Video kannst du Filme und Serien entdecken. Informationen zu verfügbaren Titeln und Kosten findest du beim Anbieter.";
        }
        if (name === "MYCARBON Digitale Kofferwaage Gepäckwaage Analog" && link === "https://amzn.to/4wTsHkN") {
            listing.name = "MYCARBON Digitale Kofferwaage";
        }
        if (name === "etro Konsole, Game Stick" && link === "https://link.amazon/B0bo6jgNP") {
            listing.name = "Retro-Konsole, Game Stick";
        }
        return listing;
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
                image_url: window.FindoraStagingSite.fileUrl("own_products", record),
            }));
        },
    };
})();
