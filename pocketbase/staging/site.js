(() => {
    const publicRpc = (action, input) => window.FindoraStagingPollRpc("staging-site", action, input);
    const adminRpc = (action, input) => window.FindoraStagingPollRpc("staging-admin/site", action, input,
        sessionStorage.getItem("findora-staging-admin") || "");

    const getSettings = async (key, reset = false) => {
        const result = await adminRpc("settings");
        if (result.error) return result;
        return { data: { [reset ? "reset_at" : "value"]: result.data[key] }, error: null };
    };

    function from(collection, admin = false) {
        if (collection === "site_settings") {
            return {
                select: () => ({ eq: (_field, key) => ({ maybeSingle: async () => {
                    if (admin) return getSettings(key);
                    if (key !== "contact_enabled") throw new Error("Unknown public setting");
                    const result = await publicRpc(key);
                    return result.error ? result : { data: { value: result.data }, error: null };
                } }) }),
                update: ({ value }) => ({ eq: () => adminRpc("contact_enabled", { value }) }),
            };
        }
        if (collection === "contact_messages") {
            return {
                select: () => ({ order: () => ({ limit: () => adminRpc("contact_messages") }) }),
                insert: payload => publicRpc("submit_contact", payload),
                update: ({ is_read }) => ({ eq: (_field, id) => adminRpc("update_contact", { id, is_read }) }),
                delete: () => ({ eq: (_field, id) => adminRpc("update_contact", { id, delete: true }) }),
            };
        }
        if (collection === "amazon_order_imports") {
            return {
                select: () => ({
                    order: () => ({ limit: () => adminRpc("amazon_reports") }),
                    in: (_field, fingerprints) => adminRpc("amazon_fingerprints", { fingerprints }),
                }),
                insert: rows => adminRpc("import_amazon", { rows }),
            };
        }
        if (["stats_reset_log", "product_clicks_reset_log"].includes(collection)) {
            return { select: () => ({ eq: () => ({ maybeSingle: () => getSettings(collection, true) }) }) };
        }
        throw new Error(`Unsupported staging collection ${collection}`);
    }

    async function invoke(name, { body }) {
        if (["check-product-links", "backfill-normal-links"].includes(name)) {
            const linkRpc = input => window.FindoraStagingPollRpc("staging-admin/link-tools", name, input,
                sessionStorage.getItem("findora-staging-admin") || "");
            if (name === "backfill-normal-links") return linkRpc(body);
            const data = { checked: 0, ok: 0, broken: [], temporary: [], unsupported: [] };
            let offset = 0;
            do {
                const batch = await linkRpc({ offset });
                if (batch.error) return batch;
                data.checked += batch.data.checked;
                data.ok += batch.data.ok;
                for (const kind of ["broken", "temporary", "unsupported"]) data[kind].push(...batch.data[kind]);
                offset = batch.data.nextOffset;
            } while (offset !== null);
            return { data, error: null };
        }
        if (["notify-telegram", "telegram-setup"].includes(name) && this === window.FindoraStagingSite.admin.functions) {
            return window.FindoraStagingPollRpc("staging-admin/delivery", name, body,
                sessionStorage.getItem("findora-staging-admin") || "");
        }
        return Promise.resolve({ error: { message: "Diese Benachrichtigung ist in der Vorschau nicht eingerichtet." } });
    }

    window.FindoraStagingSite = {
        public: { rpc: publicRpc, from: name => from(name), functions: { invoke } },
        admin: { rpc: adminRpc, from: name => from(name, true), functions: { invoke } },
    };
})();
