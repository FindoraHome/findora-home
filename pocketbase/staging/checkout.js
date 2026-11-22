(() => {
    const base = "/api/findora/sandbox-checkout/";
    const receiptKey = id => "findora-sandbox-receipt:" + id;
    let settings;

    async function invoke(name, { body }) {
        try {
            let receipt, attemptKey;
            if (name === "paypal-create-order") {
                const ids = (body.product_ids ?? [body.product_id]).map(String).sort();
                attemptKey = "findora-sandbox-cart:" + ids.join(",");
                const attempt = JSON.parse(sessionStorage.getItem(attemptKey) || "null");
                receipt = attempt?.expires > Date.now() ? attempt.receipt : null;
                if (!receipt) {
                    receipt = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
                    sessionStorage.setItem(attemptKey, JSON.stringify({ receipt, expires: Date.now() + 15 * 60000 }));
                }
            } else {
                receipt = localStorage.getItem(receiptKey(body.order_id));
                if (!receipt) throw new Error("Öffne die Bestellung im Browser, in dem du bezahlt hast.");
            }
            const response = await fetch(base + name, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...body, receipt }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Die Bestellung konnte nicht geladen werden.");
            if (attemptKey) localStorage.setItem(receiptKey(data.id), receipt);
            if (name === "paypal-capture-order" && data.completed) {
                const url = new URL(location.href);
                url.searchParams.set("bestellung", data.order_id);
                history.replaceState(null, "", url);
                sessionStorage.removeItem("findora-sandbox-cart:" + data.downloads.map(item => item.product_id).sort().join(","));
            }
            return { data, error: null };
        } catch (error) {
            return { data: { error: error.message }, error };
        }
    }

    window.FindoraSandboxCheckout = {
        config() {
            settings ??= fetch(base + "paypal-config").then(response => response.ok ? response.json() : null).catch(() => null);
            return settings;
        },
        functions: { invoke },
    };
})();
