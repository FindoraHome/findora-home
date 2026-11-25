  const el = id => document.getElementById(id);
  const admin = { products: [], ownProducts: [], categories: [], partners: [], polls: [], likeCounts: {}, clickCounts: {}, isAdmin: false };
  const api = window.FindoraStagingSite;
  const production = document.documentElement.dataset.findoraMode === "production";
  const { admin: client, adminRequest: request, adminPolls: pollRpc, productPath, saveProduct: writeProduct } = api;
  let linkCheckPromise = null;
  let visitorStatsTimer;
  const loginForm = el("login-form");
  const panel = el("admin-panel");
  const affiliate = {
    collection: "products", form: el("admin-product-form"), button: el("admin-save"),
    fill: fillEditProduct, reset: resetProductForm, input: name => el(`admin-${name}`),
  };
  const digital = {
    collection: "own_products", form: el("admin-own-product-form"), button: el("admin-own-save"),
    fill: fillEditOwnProduct, reset: resetOwnProductForm, input: name => el(`admin-own-${name}`),
  };
  function showLogin(message = "", forgetSession = true) {
    clearTimeout(visitorStatsTimer);
    admin.isAdmin = false;
    if (forgetSession) api.clearSession();
    panel.classList.remove("open");
    el("admin-logout-button").hidden = true;
    el("admin-login-button").hidden = false;
    el("app-install-button").hidden = true;
    if (forgetSession) void window.__findoraDisableApp?.();
    el("login-backdrop").classList.add("open");
    const alert = el("login-notice");
    alert.textContent = message;
    alert.className = message ? "admin-notice show error" : "admin-notice";
    admin.products = [];
    admin.ownProducts = [];
    admin.polls = [];
    admin.stats = null;
    admin.likeCounts = {};
    admin.clickCounts = {};
    for (const id of ["contact-messages-list", "amazon-orders-list", "click-stats-list", "recent-clicks-list", "visit-times-list",
      "search-stats-list", "recent-searches-list", "like-stats-list", "broken-link-list"]) el(id).replaceChildren();
    renderAdminPolls();
    resetAdminPollForm();
    el("admin-products").replaceChildren();
    el("admin-own-products").replaceChildren();
    el("affiliate-quick-input").value = "";
    renderAffiliateQuickSearch();
    clearEditor(affiliate);
    clearEditor(digital);
    loginForm.reset();
    el("login-email").focus();
  }

  function viewProduct(product, collection) {
    return { ...product, image_url: api.fileUrl(collection, product), price: product.price_cents == null ? null : product.price_cents / 100,
      file_name: product.download_name, file_path: product.has_download || Boolean(product.download_name) };
  }

  function renderProducts() {
    renderAdminProducts();
    decorateProductVisibility();
    decorateProductLikeCounts();
  }

  async function loadAdminData() {
    const email = api.sessionEmail();
    const data = await request("catalog");
    if (!api.token() || email !== api.sessionEmail()) return;
    const products = data.products.map(product => viewProduct(product, product.collection));
    admin.products = products.filter(product => product.collection === "products");
    admin.ownProducts = products.filter(product => product.collection === "own_products")
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    admin.categories = data.categories;
    admin.partners = data.partners;
    renderProducts();
    renderAdminOwnProducts();
    renderAffiliateQuickSearch();
    renderAdminCategories();
    renderAdminPartners();
    fillCategorySelect();
    fillPartnerSelect();
    el("admin-email").textContent = api.sessionEmail();
    el("login-backdrop").classList.remove("open");
    el("admin-login-button").hidden = true;
    el("admin-logout-button").hidden = false;
    const signedIn = panel.classList.contains("open");
    admin.isAdmin = true;
    panel.classList.add("open");
    if (!signedIn) {
      el("app-install-button").hidden = false;
      void window.__findoraEnableApp?.();
      void loadAdminPolls();
      void refreshSiteAdmin();
    }
  }

  async function refreshSiteAdmin() {
    try {
      await Promise.all([loadContactMessagesAdmin(), loadContactSettingsAdmin(), loadVacationSettings(), loadAmazonOrders(),
        loadVisitorStats().then(() => Promise.all([loadLikeStatsAdmin(), loadSearchStatsAdmin()])).then(renderProducts)]);
    } catch (error) {
      if (admin.isAdmin) notice(error.message, "error");
    }
  }

  function scheduleVisitorStatsRefresh(delay = admin.stats?.next_day_in_ms) {
    clearTimeout(visitorStatsTimer);
    if (!admin.isAdmin || !Number.isFinite(delay)) return;
    visitorStatsTimer = setTimeout(async () => {
      try {
        await loadVisitorStats();
      } catch {
        scheduleVisitorStatsRefresh(60000);
      }
    }, Math.max(1000, delay));
  }

  async function resetSearchHistory(event) {
    if (!confirm("Alle gespeicherten Suchanfragen und den Suchverlauf löschen?")) return;
    const button = event.currentTarget;
    const status = el("search-history-status");
    button.disabled = true;
    status.hidden = true;
    try {
      const result = await client.rpc("reset_search_history");
      if (result.error) throw result.error;
      await loadSearchStatsAdmin();
      status.textContent = "Der Suchverlauf wurde gelöscht.";
    } catch (error) {
      status.textContent = `Suchverlauf konnte nicht gelöscht werden. ${error.message}`;
    } finally {
      status.hidden = false;
      button.disabled = false;
    }
  }

  function updateImagePreview(editor) {
    const file = editor.input("image").files[0];
    if (editor.previewUrl) URL.revokeObjectURL(editor.previewUrl);
    editor.previewUrl = file ? URL.createObjectURL(file) : "";
    const src = editor.previewUrl || (editor.product ? api.fileUrl(editor.collection, editor.product) : "");
    const preview = editor.input("preview");
    if (src) preview.src = src;
    else preview.removeAttribute("src");
    preview.hidden = !src;
    const remove = editor.input("remove-image");
    remove.textContent = file ? "Auswahl entfernen" : "Bild löschen";
    remove.hidden = !src;
  }

  function clearEditor(editor) {
    editor.product = null;
    editor.selection = {};
    editor.reset();
    updateImagePreview(editor);
    editor.button.disabled = false;
  }

  function showProduct(editor, product) {
    editor.product = product;
    editor.fill(viewProduct(product, editor.collection));
    updateImagePreview(editor);
    if (editor === affiliate) el("admin-normal-link").value = product.normal_link || "";
    else el("admin-own-file-name").textContent = "Noch keine Datei ausgewählt.";
    editor.button.disabled = false;
  }

  async function openProduct(editor, id) {
    const selection = {};
    editor.selection = selection;
    clearNotice();
    try {
      const product = await request(productPath(editor.collection, id));
      if (editor.selection !== selection) return;
      showProduct(editor, product);
      editor.form.scrollIntoView({ behavior: "smooth", block: "start" });
      editor.input("name").focus({ preventScroll: true });
    } catch (error) {
      if (editor.selection === selection) notice(error.message, "error");
    }
  }

  function editProduct(product) { return openProduct(affiliate, product.id); }
  function editOwnProduct(product) { return openProduct(digital, product.id); }

  async function updateProduct(product, collection, changes, message) {
    clearNotice();
    try {
      const current = await request(productPath(collection, product.id));
      await writeProduct(collection, current, changes(current));
      await loadAdminData();
      notice(message, "success");
    } catch (error) {
      notice(error.message, "error");
    }
  }

  function toggleProductVisibility(product, collection = "products") {
    return updateProduct(product, collection, current => ({ active: !current.active }),
      product.active ? "Produkt ausgeblendet." : "Produkt eingeblendet.");
  }

  function toggleFeaturedProduct(product) {
    return updateProduct(product, "products", current => ({ featured: !current.featured }),
      product.featured ? "Das Produkt wird nicht mehr zuerst angezeigt." : "Das Produkt wird jetzt auf der Startseite zuerst angezeigt.");
  }

  async function catalogAction(action, message) {
    try {
      await action();
      await loadAdminData();
      notice(message, "success");
    } catch (error) {
      notice(error.message, "error");
    }
  }

  function duplicateProduct(product) {
    return catalogAction(() => request(`duplicate/${product.id}`, { method: "POST" }), "Produkt wurde dupliziert.");
  }

  function deleteProduct(product, editor = affiliate) {
    if (!confirm(`Produkt „${product.name}“ wirklich vollständig löschen?`)) return;
    return catalogAction(async () => {
      await request(productPath(editor.collection, product.id), { method: "DELETE" });
      if (editor.product?.id === product.id) clearEditor(editor);
    }, "Produkt wurde gelöscht.");
  }

  function deleteOwnProduct(product) { return deleteProduct(product, digital); }

  function taxonomy(collection, data) {
    return request(`taxonomy/${collection}`, api.json(data));
  }

  function deleteTaxonomy(collection, item) {
    if (!confirm(`„${item.name}“ wirklich löschen?`)) return;
    return catalogAction(() => taxonomy(collection, { id: item.id, delete: true }), "Eintrag wurde gelöscht.");
  }

  function deleteCategory(item) { return deleteTaxonomy("categories", item); }
  function deletePartner(item) { return deleteTaxonomy("partners", item); }

  async function saveEditor(event, editor) {
    event.preventDefault();
    const product = editor.product || { id: "new", active: true };
    if (editor.button.disabled) return;
    const selection = editor.selection;
    const input = editor.input;
    editor.button.disabled = true;
    clearNotice();
    try {
      const changes = { name: input("name").value, description: input("description").value };
      let documentFile;
      if (editor === affiliate) {
        Object.assign(changes, { link: input("link").value, normal_link: input("normal-link").value,
          category: input("category").value, partner: input("partner").value, is_disney: input("disney").checked });
      } else {
        const price = input("price").value;
        changes.price_cents = price === "" ? null : Math.round(Number(price) * 100);
        if (!production) changes.purchase_url = input("paypal").value;
        documentFile = input("file").files[0];
      }
      await writeProduct(editor.collection, product, changes, input("image").files[0], documentFile);
      if (editor.selection === selection) clearEditor(editor);
      await loadAdminData();
      notice(production ? "Änderungen gespeichert." : "Änderungen in der Vorschau gespeichert.", "success");
    } catch (error) {
      notice(error.message, "error");
    } finally {
      if (editor.selection === selection) editor.button.disabled = false;
    }
  }

  function configurePreview() {
    el("app-install-button").hidden = true;
    const head = panel.querySelector(".admin-head");
    const scope = document.createElement("p");
    scope.className = "admin-note staging-scope";
    if (!production) {
      scope.textContent = "PocketBase-Vorschau · Änderungen gelten nur für diese Vorschau.";
      head.after(scope);
    } else {
      el("admin-own-paypal").closest(".admin-field").hidden = true;
      el("admin-own-file-required").hidden = true;
    }
    head.querySelector('a[href="?customer=1"]').href = "index.html";
    const list = el("admin-products");
    list.hidden = false;
    list.previousElementSibling.hidden = false;
    list.closest(".admin-card").id = "affiliate-links";
    const heading = document.createElement("h3");
    heading.className = "admin-own-products-heading";
    heading.textContent = "Eigene Findora-Produkte";
    list.after(heading, el("admin-own-products"));
    el("admin-paypal-transactions-card").hidden = true;
    el("admin-link-check").hidden = false;
    el("admin-telegram-settings").hidden = false;
    el("telegram-test").hidden = false;
    el("telegram-find-chat").onclick = loadTelegramChatIds;
    el("telegram-dolly-setup").onclick = setupDollyWebhook;
    for (const [name, collection, reset] of [["category", "categories", resetCategoryForm], ["partner", "partners", resetPartnerForm]]) {
      el(`admin-${name}-cancel`).onclick = reset;
      el(`admin-${name}-form`).onsubmit = async event => {
        event.preventDefault();
        const button = el(`admin-${name}-save`);
        button.disabled = true;
        try {
          await catalogAction(async () => {
            await taxonomy(collection, { id: el(`admin-${name}-id`).value, name: el(`admin-${name}-name`).value });
            reset();
          }, "Eintrag wurde gespeichert.");
        } finally {
          button.disabled = false;
        }
      };
    }
    el("contact-enabled-toggle").onchange = toggleContactEnabled;
    el("refresh-contact-messages").onclick = loadContactMessagesAdmin;
    el("reset-search-history").onclick = resetSearchHistory;
    el("vacation-form").onsubmit = saveVacationSettings;
    el("amazon-report-button").onclick = () => el("amazon-report-file").click();
    el("amazon-report-file").onchange = event => {
      if (event.target.files[0]) void importAmazonReport(event.target.files[0]);
    };
    el("admin-polls").hidden = false;
    el("refresh-admin-poll-results").onclick = loadAdminPolls;
    el("admin-poll-form").onsubmit = createAdminPoll;
    el("admin-poll-add-option").onclick = () => addAdminPollOption();
    resetAdminPollForm();
    const normalLink = document.createElement("div");
    normalLink.className = "admin-field";
    normalLink.innerHTML = '<label for="admin-normal-link">Original-Link</label><input id="admin-normal-link" type="url" maxlength="4000">';
    el("admin-link").closest(".admin-field").after(normalLink);
    for (const id of ["admin-description", "admin-link", "admin-category"]) el(id).required = false;
    el("admin-description").maxLength = 3000;
    el("admin-own-file").accept = "application/pdf,.pdf";
    el("admin-own-file-button").onclick = () => el("admin-own-file").click();
    el("admin-own-file").onchange = event => {
      el("admin-own-file-name").textContent = event.target.files[0]?.name || "Noch keine Datei ausgewählt.";
    };
    el("admin-notice").setAttribute("role", "status");
    for (const editor of [affiliate, digital]) {
      editor.form.onsubmit = event => saveEditor(event, editor);
      editor.input("image").onchange = () => updateImagePreview(editor);
      editor.input("cancel").onclick = () => clearEditor(editor);
      editor.input("remove-image").onclick = async () => {
        if (editor.input("image").files[0]) {
          editor.input("image").value = "";
          updateImagePreview(editor);
          return;
        }
        if (!editor.product || !confirm("Dieses Produktbild wirklich löschen?")) return;
        const product = editor.product;
        await catalogAction(async () => {
          const saved = await writeProduct(editor.collection, product, { remove_image: true });
          if (editor.product === product) showProduct(editor, saved);
        }, "Produktbild wurde gelöscht.");
      };
      clearEditor(editor);
    }
  }

  async function signIn(event) {
    event.preventDefault();
    const button = el("login-submit");
    const email = el("login-email").value.trim();
    button.disabled = true;
    try {
      await api.signIn(email, el("login-password").value);
      localStorage.setItem("findora-admin-device", "1");
      loginForm.reset();
      await loadAdminData();
    } catch (error) {
      showLogin(error.message, !api.token());
    } finally {
      button.disabled = false;
    }
  }

  async function resumeSession() {
    try {
      await api.refreshSession();
    } catch {
      // The saved token can still be used if refresh is unavailable.
    }
    if (!api.token()) return;
    try {
      await loadAdminData();
    } catch (error) {
      if (api.token()) showLogin(error.message, false);
    }
  }

  function startAdmin() {
    configurePreview();
    window.addEventListener("findora-session-expired", () => showLogin("Bitte melde dich erneut an."));
    loginForm.onsubmit = signIn;
    el("login-close").onclick = () => { location.href = "index.html"; };
    el("admin-login-button").onclick = () => showLogin();
    el("admin-logout-button").onclick = () => { clearNotice(); showLogin(); };
    el("affiliate-quick-input").oninput = renderAffiliateQuickSearch;
    el("admin-product-search").oninput = renderProducts;
    el("admin-product-sort").onchange = renderProducts;
    el("admin-product-visibility").onchange = renderProducts;
    if (api.token()) void resumeSession();
    else showLogin();
  }
