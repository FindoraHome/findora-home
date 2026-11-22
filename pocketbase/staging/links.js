    const api = window.FindoraStagingSite;
    const { adminRequest: request } = api;
    window.addEventListener("findora-session-expired", logout);

    function logout() {
      api.clearSession();
      location.replace("admin.html");
    }

    async function boot() {
      if (!api.token()) return logout();
      try {
        const result = await request("links");
        products = result.data.map(product => ({ ...product, recordId: product.id, id: Number(product.legacy_id),
          image_url: api.fileUrl("products", product),
        })).sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
        render();
      } catch (error) {
        showNotice(error.message, "error");
      }
    }

    async function saveProductRow(product, fields, button) {
      button.disabled = true;
      try {
        const changes = { name: fields.name.value, link: fields.affiliate.value, normal_link: fields.normal.value };
        await api.saveProduct("products", { ...product, id: product.recordId }, changes, fields.imageInput.files[0]);
        await boot();
        showNotice(`„${changes.name}“ wurde gespeichert.`);
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
        await request(api.productPath("products", product.recordId), { method: "DELETE" });
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
        return await request("links", api.json({ p_updates: updates }));
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
