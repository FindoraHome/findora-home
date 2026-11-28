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
        products = result.data.map(product => ({ ...product, recordId: product.id, id: String(product.legacy_id),
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

    const linkColumns = [
      { field: "link", current: "Bisheriger Affiliate-Link", next: "Neuer Affiliate-Link", label: "Affiliate-Link" },
      { field: "normal_link", current: "Normaler Link (privat)", next: "Neuer Original-Link", label: "Original-Link" },
    ];

    function downloadLinkTemplate() {
      const xlsx = window.XLSX;
      if (!xlsx) return showNotice("Excel konnte nicht geladen werden. Bitte lade die Seite neu.", "error");
      const headers = ["Produkt-ID", "Produktname", ...linkColumns.flatMap(column => [column.current, column.next])];
      const rows = products.map(product => [product.id, product.name, ...linkColumns.flatMap(column => [product[column.field] || "", ""])]);
      const sheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
      sheet["!cols"] = [21, 48, 45, 45, 45, 45].map(wch => ({ wch }));
      sheet["!autofilter"] = { ref: sheet["!ref"] };
      const book = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(book, sheet, "Produktlinks");
      xlsx.writeFile(book, "Findora-Produktlinks.xlsx", { compression: true });
    }

    function readLinkUpdates(rows) {
      const headers = (rows[0] || []).map(value => String(value ?? "").trim());
      const namedHeaders = headers.filter(Boolean);
      if (rows.length > 2001 || new Set(namedHeaders).size !== namedHeaders.length) {
        throw new Error("Die Vorlage enthält zu viele Zeilen oder doppelte Spalten.");
      }
      const positions = new Map(headers.map((name, index) => [name, index]));
      const idIndex = positions.get("Produkt-ID");
      const columns = linkColumns.filter(column => positions.has(column.next));
      if (idIndex === undefined || !columns.length || columns.some(column => !positions.has(column.current))) {
        throw new Error("Die Spalten der Findora-Vorlage fehlen.");
      }
      const known = new Map(products.map(product => [product.id, product]));
      const updates = [];
      const preview = [];
      const seen = new Set();
      for (const [index, row] of rows.slice(1).entries()) {
        const rowNumber = index + 2;
        const requested = columns.map(column => ({ ...column, value: String(row[positions.get(column.next)] ?? "").trim() }))
          .filter(column => column.value);
        if (!requested.length) continue;
        const id = String(row[idIndex] ?? "").trim();
        const product = known.get(id);
        if (!product || seen.has(id)) throw new Error("Zeile " + rowNumber + " enthält eine unbekannte oder doppelte Produkt-ID.");
        seen.add(id);
        const update = { id };
        for (const { field, current, label, value } of requested) {
          if (!/^https:\/\/[^\s/]+[^\s]*$/i.test(value) || value.length > 4000 || !URL.canParse(value)) {
            throw new Error("Zeile " + rowNumber + " braucht für „" + label + "“ einen gültigen HTTPS-Link.");
          }
          if (value === (product[field] || "")) continue;
          const original = String(row[positions.get(current)] ?? "");
          if (original !== (product[field] || "")) {
            throw new Error("Zeile " + rowNumber + " enthält einen veralteten Link. Bitte lade eine aktuelle Vorlage herunter.");
          }
          update[field] = value;
          update["old_" + field] = original;
          preview.push({ name: product.name, label, before: original, after: value });
        }
        if (Object.keys(update).length > 1) updates.push(update);
      }
      return { updates, preview };
    }

    let linkBatch = null;

    function clearLinkPreview() {
      linkBatch = null;
      byId("link-import-preview").hidden = true;
      byId("link-import-changes").replaceChildren();
    }

    async function importLinkTemplate(file) {
      if (!file) return;
      clearLinkPreview();
      const button = byId("upload-link-template");
      button.disabled = true;
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error("Die Datei darf höchstens 5 MB groß sein.");
        let rows;
        if (/\.xlsx$/i.test(file.name)) {
          const xlsx = window.XLSX;
          if (!xlsx) throw new Error("Excel konnte nicht geladen werden. Bitte lade die Seite neu.");
          const book = xlsx.read(await file.arrayBuffer(), { sheets: ["Produktlinks"], sheetRows: 2002 });
          const sheet = book.Sheets.Produktlinks;
          if (!sheet?.["!ref"]) throw new Error("Das Blatt „Produktlinks“ fehlt.");
          const range = xlsx.utils.decode_range(sheet["!fullref"] || sheet["!ref"]);
          if (range.e.r > 2000 || range.e.c > 49) throw new Error("Die Excel-Tabelle ist zu groß.");
          rows = xlsx.utils.sheet_to_json(sheet, { header: 1, range: 0, raw: true, defval: "" });
        } else if (/\.(csv|txt)$/i.test(file.name)) {
          rows = parseCsv((await file.text()).replace(/^\ufeff/, ""));
        } else {
          throw new Error("Bitte eine Excel- oder CSV-Datei auswählen.");
        }
        const { updates, preview } = readLinkUpdates(rows);
        if (!updates.length) throw new Error("Die Vorlage enthält keine neuen Linkänderungen.");
        linkBatch = updates;
        byId("link-import-count").textContent = preview.length + " Linkänderungen bei " + updates.length + " Produkten";
        const items = preview.map(({ name, label, before, after }) => {
          const item = document.createElement("li");
          item.textContent = name + " · " + label + " · " + (before || "(leer)") + " → " + after;
          return item;
        });
        byId("link-import-changes").replaceChildren(...items);
        byId("link-import-preview").hidden = false;
      } catch (error) {
        showNotice(error.message, "error");
      } finally {
        button.disabled = false;
        byId("link-template-file").value = "";
      }
    }

    async function saveLinkBatch() {
      if (!linkBatch) return;
      const actionIds = ["apply-link-import", "cancel-link-import", "upload-link-template"];
      actionIds.forEach(id => { byId(id).disabled = true; });
      try {
        const result = await bulkLinks(linkBatch);
        if (result.error) throw result.error;
        clearLinkPreview();
        await boot();
        showNotice(result.data + " Produkte wurden aktualisiert.");
      } catch (error) {
        showNotice(error.message, "error");
      } finally {
        actionIds.forEach(id => { byId(id).disabled = false; });
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
