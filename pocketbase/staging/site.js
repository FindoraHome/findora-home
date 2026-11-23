(() => {
    const apiOrigin = "";
    const apiUrl = path => apiOrigin + path;
    const sessionKey = `findora-admin-session:${apiOrigin}`;
    const authPath = "/api/collections/findora_admins";
    let temporarySession = null;
    let storageAvailable = true;

    function session() {
        if (storageAvailable) {
            try {
                return JSON.parse(localStorage.getItem(sessionKey));
            } catch {
                storageAvailable = false;
            }
        }
        return temporarySession;
    }

    function saveSession(value) {
        temporarySession = value;
        if (!storageAvailable) return;
        try {
            if (value) localStorage.setItem(sessionKey, JSON.stringify(value));
            else localStorage.removeItem(sessionKey);
        } catch {
            storageAvailable = false;
        }
    }

    const token = () => session()?.token || "";
    const sessionEmail = () => session()?.email || "";
    try {
        const previous = sessionStorage.getItem("findora-staging-admin");
        if (previous && !token()) saveSession({ token: previous, email: sessionStorage.getItem("findora-staging-admin-email") });
        sessionStorage.removeItem("findora-staging-admin");
        sessionStorage.removeItem("findora-staging-admin-email");
    } catch { /* The browser can restrict storage on some devices. */ }
    window.addEventListener("storage", event => {
        if (event.key === sessionKey && !event.newValue) window.dispatchEvent(new Event("findora-session-expired"));
    });
    const json = payload => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    /* product image optimization */

    async function request(path, options = {}, admin = false) {
        const session = admin ? token() : "";
        const headers = new Headers(options.headers);
        if (session) headers.set("Authorization", session);
        const response = await fetch(apiUrl(path), { ...options, headers });
        const result = await response.json().catch(() => ({}));
        if (response.status === 401 && session && session === token()) {
            saveSession(null);
            window.dispatchEvent(new Event("findora-session-expired"));
        }
        if (!response.ok) throw new Error(result.message || "Die Anfrage konnte nicht abgeschlossen werden.");
        return result;
    }

    async function rpc(scope, action, input = {}, admin = false) {
        try {
            return await request(`/api/findora/${scope}/${action}`, json(input), admin);
        } catch (error) {
            return { error };
        }
    }

    const publicRpc = (action, input) => rpc("staging-site", action, input);
    const adminRpc = (action, input) => rpc("staging-admin/site", action, input, true);
    const adminRequest = (path, options) => request(`/api/findora/staging-admin/${path}`, options, true);
    const productPath = (collection, id) => `products/${collection}/${encodeURIComponent(id)}`;
    const fileUrl = (collection, record) => record.image
        ? apiUrl(`/api/files/${collection}/${encodeURIComponent(record.id)}/${encodeURIComponent(record.image)}`) : "";

    async function saveProduct(collection, product, changes, image, documentFile) {
        const body = new FormData();
        body.set("payload", JSON.stringify({ ...product, ...changes, replace_image: Boolean(image), replace_document: Boolean(documentFile) }));
        if (image) body.set("image", await optimizeImage(image));
        if (documentFile) body.set("document", documentFile);
        return adminRequest(productPath(collection, product.id), { method: "POST", body });
    }

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
            const linkRpc = input => rpc("staging-admin/link-tools", name, input, true);
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
            return rpc("staging-admin/delivery", name, body, true);
        }
        return Promise.resolve({ error: { message: "Diese Benachrichtigung ist in der Vorschau nicht eingerichtet." } });
    }

    window.FindoraStagingSite = {
        public: { rpc: publicRpc, from: name => from(name), functions: { invoke } },
        admin: { rpc: adminRpc, from: name => from(name, true), functions: { invoke } },
        polls: (action, input) => rpc("staging-polls", action, input),
        adminPolls: (action, input) => rpc("staging-admin/polls", action, input, true),
        adminRequest, json, productPath, apiUrl, fileUrl, saveProduct, token, sessionEmail,
        async signIn(email, password) {
            const result = await request(`${authPath}/auth-with-password`, json({ identity: email, password }));
            saveSession({ token: result.token, email });
            return result.token;
        },
        async refreshSession() {
            const previous = token();
            if (!previous) return;
            const result = await request(`${authPath}/auth-refresh`, { method: "POST" }, true);
            if (token() === previous) saveSession({ token: result.token, email: sessionEmail() });
        },
        clearSession: () => saveSession(null),
    };
})();
