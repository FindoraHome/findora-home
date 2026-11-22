    const endpoint = "/api/findora/staging-admin";
    const tokenKey = "findora-staging-admin";

    async function request(url, options = {}) {
      const headers = new Headers(options.headers);
      headers.set("Authorization", sessionStorage.getItem(tokenKey) || "");
      const response = await fetch(url, { ...options, headers });
      const result = await response.json();
      if (response.status === 401) logout();
      if (!response.ok) throw new Error(result.message || "Die Linkverwaltung ist gerade nicht erreichbar.");
      return result;
    }

    function logout() {
      sessionStorage.removeItem(tokenKey);
      sessionStorage.removeItem(`${tokenKey}-email`);
      location.replace("admin.html");
    }

    async function boot() {
      if (!sessionStorage.getItem(tokenKey)) return logout();
      try {
        const result = await request(`${endpoint}/links`);
        products = result.data.map(product => ({ ...product, recordId: product.id, id: Number(product.legacy_id),
          image_url: product.image ? `/api/files/products/${product.id}/${encodeURIComponent(product.image)}` : "",
        })).sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
        render();
      } catch (error) {
        showNotice(error.message, "error");
      }
    }

    async function saveProductRow(product, fields, button) {
      button.disabled = true;
      try {
        const payload = { ...product, name: fields.name.value, link: fields.affiliate.value, normal_link: fields.normal.value };
        const image = fields.imageInput.files[0];
        const body = new FormData();
        body.set("payload", JSON.stringify({ ...payload, replace_image: Boolean(image) }));
        if (image) body.set("image", await optimizeImage(image));
        await request(`${endpoint}/products/products/${product.recordId}`, { method: "POST", body });
        await boot();
        showNotice(`„${payload.name}“ wurde gespeichert.`);
      } catch (error) {
        showNotice(error.message, "error");
      } finally {
        button.disabled = false;
      }
    }

    async function deleteProduct(product, button) {
      if (!confirm(`Produkt „${product.name}“ wirklich vollständig löschen?`)) return;
      button.disabled = true;
      try {
        await request(`${endpoint}/products/products/${product.recordId}`, { method: "DELETE" });
        await boot();
        showNotice("Produkt wurde gelöscht.");
      } catch (error) {
        showNotice(error.message, "error");
      } finally {
        button.disabled = false;
      }
    }

    async function bulkLinks(updates) {
      try {
        return await request(`${endpoint}/links`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ p_updates: updates }),
        });
      } catch (error) {
        return { error };
      }
    }

    async function replaceAll() {
      const oldValue = byId("old-value").value.trim();
      const newValue = byId("new-value").value.trim();
      if (!oldValue || !newValue) return showNotice("Bitte alte und neue Tracking-ID eintragen.", "error");
      const updates = products.filter(product => (product.link || "").includes(oldValue))
        .map(product => ({ id: product.id, link: product.link.split(oldValue).join(newValue) }));
      if (!updates.length) return showNotice("Der alte Bestandteil wurde in keinem Produktlink gefunden.", "error");
      if (!confirm(`Die Links von ${updates.length} Produkten wirklich ändern?`)) return;
      const button = byId("replace-all");
      button.disabled = true;
      try {
        const result = await bulkLinks(updates);
        if (result.error) throw result.error;
        await boot();
        showNotice(`${updates.length} Produktlinks wurden erfolgreich aktualisiert.`);
      } catch (error) {
        showNotice(error.message, "error");
      } finally {
        button.disabled = false;
      }
    }
