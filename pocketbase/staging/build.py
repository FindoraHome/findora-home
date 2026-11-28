import argparse
import json
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
STAGING = Path(__file__).resolve().parent
PRODUCTION = STAGING.parent / "production"
LEGACY_SITE = "https://findorahome.github.io/findora-home"


def replace(text, pattern, replacement, label, flags=0):
    result, matches = re.subn(pattern, lambda _: replacement, text, flags=flags)
    if matches != 1:
        raise ValueError(f"Expected one {label} in the live template, got {matches}.")
    return result


def shared_template(html, page, origin=None):
    html = re.sub(r'<script src="https://cdn\.jsdelivr\.net/[^"\n]+"></script>\s*', "", html)
    if origin:
        html = html.replace(LEGACY_SITE, origin)
        return replace(html, r"</head>", '<script src="staging-catalog.js"></script>\n'
                       '<script src="site.js"></script>\n</head>', "document head")
    html = replace(html, r"<html(?=\s)", f'<html data-staging-page="{page}"', "HTML element")
    html = replace(html, r"</head>", '<link rel="stylesheet" href="staging-preview.css">\n'
                    '<script src="staging-catalog.js"></script>\n'
                    '<script src="site.js"></script>\n</head>', "document head")
    notice = "Katalogvorschau aus PocketBase · PayPal Sandbox" if page == "produkte" else "Katalogvorschau aus PocketBase"
    return replace(html, r"<body[^>]*>", '<body>\n<div class="staging-notice">'
                   + notice +
                   ' <a href="admin.html">Verwaltung</a></div>', "document body")


def home(html):
    html = re.sub(r"<script>\s*if \(false\) \{.*?</script>", "", html, count=1, flags=re.S)
    html = replace(html, r"^  const client = window\.supabase\.createClient\([^\n]+\);\n",
                   "  const client = window.FindoraStagingSite.public;\n", "homepage client", re.M)
    # Admin has its own generated page and the public catalog uses PocketBase.
    html = re.sub(r"^  const (?:publicImage|storagePath|PUBLIC_PRODUCT_COLUMNS) = [^\n]+\n", "", html, flags=re.M)
    old_actions = ("loadCatalog", "loadAdminData", "saveOwnProduct", "removeOwnProductImage", "deleteOwnProduct",
                   "uploadImage", "uploadOwnFile", "saveProduct", "removeProductImage", "deleteProduct", "login", "logout")
    html = re.sub(rf"^  async function (?:{'|'.join(old_actions)})\([^\n]+\n", "", html, flags=re.M)
    for name in ("loadActivePoll", "submitPublicPoll"):
        function = template_section(html, rf"^  async function {name}\([^\n]+$", name)
        adapted = function.replace("client.rpc(", "window.FindoraStagingSite.polls(")
        adapted = adapted.replace("p_poll_id: Number(pollId)", "p_poll_id: pollId")
        if name == "submitPublicPoll":
            adapted = adapted.replace("if (!checked.length)", 'const field = form.querySelector("textarea"); const response = field?.value.trim(); if (!checked.length && !response)')
            adapted = adapted.replace('"Bitte wähle mindestens eine Antwort aus."',
                                      'field ? "Bitte schreibe eine Antwort." : "Bitte wähle mindestens eine Antwort aus."')
            adapted = adapted.replace('"Deine Auswahl wird gespeichert…"', '"Deine Antwort wird gespeichert…"')
            adapted = adapted.replace("p_option_ids: optionIds,", "p_option_ids: optionIds, p_response: response,")
        html = replace(html, rf"^  async function {name}\([^\n]+$", adapted, name, re.M)
    html = html.replace('kicker.textContent = "Deine Meinung zählt · Mehrfachauswahl möglich"',
                        'kicker.textContent = poll.free_text ? "Deine Meinung zählt · Freitextfrage" : "Deine Meinung zählt · Mehrfachauswahl möglich"')
    html = html.replace("label.append(input, text); optionsBox.appendChild(label);",
                        r'''if (option.image_url && /^(https:\/\/|data:image\/jpeg;base64,)/i.test(option.image_url)) {
        const image = document.createElement("img");
        image.src = option.image_url;
        image.alt = "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.className = "poll-option-image";
        label.append(image);
      } label.append(input, text); optionsBox.appendChild(label);''')
    html = html.replace('submit.className = "poll-submit";', '''if (poll.free_text && !poll.has_voted) {
      const answer = document.createElement("textarea");
      answer.required = true;
      answer.maxLength = 1000;
      answer.rows = 3;
      answer.setAttribute("aria-label", "Deine Antwort");
      answer.placeholder = "Deine Antwort";
      answer.className = "poll-text-answer";
      optionsBox.append(answer);
    } submit.className = "poll-submit";''')
    html = html.replace('submit.textContent = "Auswahl abstimmen"',
                        'submit.textContent = poll.free_text ? "Antwort absenden" : "Auswahl abstimmen"')
    html = html.replace('"Danke für deine Stimme. Die Ergebnisse sind nur für Findora Home sichtbar."',
                        '"Danke für deine Teilnahme. Die Ergebnisse sind nur für Findora Home sichtbar."')
    html = replace(html, r"</head>", '''<style>
      .poll-option-image{width:72px;height:72px;max-width:100%;object-fit:contain;border-radius:6px}
      .poll-text-answer{box-sizing:border-box;width:100%;grid-column:1/-1;padding:10px;border:1px solid #b7a798;
        border-radius:8px;font:inherit;color:inherit;background:#fff;resize:vertical}
    </style>
    </head>''', "poll image and answer styles")
    contact = template_section(html, r"^  async function submitContact\([^\n]+$", "contact form")
    contact = replace(contact, r'await notifyTelegram\(\{ type: "contact", \.\.\.payload \}\); const mail = .*?; form\.reset\(\); if \(mail\.error\)',
                      "form.reset(); if (!result.data?.mail_sent)", "contact delivery status")
    html = replace(html, r"^  async function submitContact\([^\n]+$", contact, "contact form", re.M)
    boot = '''  el("search").addEventListener("input", event => { recordSearchQuery(event.target.value); renderPublic(); });
  el("sort-select").addEventListener("change", renderPublic);
  el("admin-login-button").onclick = () => { location.href = "admin.html"; };
  el("contact-form").onsubmit = submitContact;
  el("partner-filter").addEventListener("change", event => {
    window.__findoraPartner = event.target.value;
    renderPublic();
  });
  el("category-menu-button").onclick = () => {
    window.__findoraCategoryOpen = !window.__findoraCategoryOpen;
    el("category-menu-button").setAttribute("aria-expanded", String(window.__findoraCategoryOpen));
    renderPublic();
  };
  Promise.all([window.FindoraStagingCatalog.home(), client.rpc("public_counts")]).then(([catalog, counts]) => {
    Object.assign(admin, catalog);
    if (!counts.error) {
      admin.likeCounts = counts.data.likes;
      const productsById = new Map(admin.products.map(product => [String(product.id), product]));
      admin.popular = counts.data.popular.map(id => productsById.get(id)).filter(Boolean);
    }
    renderPublic();
    document.documentElement.dataset.catalogSource = "pocketbase";
  }).catch(error => {
    console.error(error);
    el("products").textContent = "Katalog konnte nicht aus PocketBase geladen werden.";
    el("results-count").textContent = "Nicht verfügbar";
  });
  void loadActivePoll();
  void loadVacationNotice();
  void loadContactSettings();
  void recordVisit();
})();'''
    return replace(html, r'^  document\.getElementById\("search"\)\.addEventListener\("input", event => \{ recordSearchQuery.*?^\}\)\(\);',
                   boot, "homepage bootstrap", re.M | re.S)


def disney(html):
    html = replace(html, r"^    const client=window\.supabase\.createClient\([^\n]+\);\n",
                   "    const client = window.FindoraStagingSite.public;\n", "Disney client", re.M)
    boot = '''    async function load() {
      try {
        const [catalog, counts] = await Promise.all([window.FindoraStagingCatalog.disney(), client.rpc("public_counts")]);
        products = catalog;
        if (!counts.error) likeCounts = counts.data.likes;
        renderHero();
        render();
        document.documentElement.dataset.catalogSource = "pocketbase";
      } catch (error) {
        console.error(error);
        box.textContent = "Disney-Katalog konnte nicht aus PocketBase geladen werden.";
        count.textContent = "Nicht verfügbar";
      }
    }'''
    return replace(html, r"^    async function load\([^\n]+$", boot, "Disney catalog loader", re.M)


def digital_page(html):
    html = replace(html, r'^    <section id="own-admin-manage"[^\n]+\n', "", "product admin markup", re.M)
    html = html.replace('href="index.html#admin-panel"', 'href="admin.html"')
    return replace(html, r'<button id="products-admin-logout"[^<]+</button>', "", "sign-out button")


def digital_catalog(html):
    html = digital_page(html)
    html = replace(html, r'^    <section id="cart"[^\n]+$', '    <p>Der Online-Kauf ist derzeit pausiert.</p>', "cart", re.M)
    schema = template_section(html, r'^      function updateProductSchema\([^\n]+$', "product schema")
    schema = replace(schema, r'if\(item\.price != null && Number\(item\.price\) > 0\) product\.offers = \{[^}]+\}; ',
                     "", "product purchase offer")
    render = template_section(html, r'^      function render\(\)\{.*?(?=^      search\.addEventListener)', "product renderer")
    render = replace(render, r'^          if\(item\.price != null && Number\(item\.price\) > 0\)[^\n]+\n', "", "buy button", re.M)
    script = '''<script>
    (() => {
      const box = document.getElementById("products"), search = document.getElementById("search");
      const euro = value => Number(value).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
      let products = [];
''' + schema + "\n" + render + '''      search.addEventListener("input", render);
      window.FindoraStagingCatalog.digital().then(items => {
        products = items;
        render();
        document.documentElement.dataset.catalogSource = "pocketbase";
      }).catch(error => {
        console.error(error);
        box.innerHTML = '<div class="error">Die eigenen Produkte konnten gerade nicht geladen werden.</div>';
      });
    })();
  </script>'''
    return replace(html, r"<script>\s*\(function\(\)\{.*?</script>", script, "product catalog script", re.S)


def digital_checkout(html):
    html = digital_page(html)
    html = replace(html, r'^      const adminLogin = .*?(?=^      async function loadPublicProducts\()', "",
                   "Supabase product admin script", re.M | re.S)
    client_pattern = r'^      const client = window\.supabase\.createClient\([^\n]+\);$'
    html = replace(html, r"</head>", '<script src="checkout.js"></script>\n</head>', "sandbox script")
    html = replace(html, r'^      const SUPABASE_URL = [^\n]+\n', "", "Supabase URL", re.M)
    html = replace(html, client_pattern, "      const client = window.FindoraSandboxCheckout;", "sandbox client", re.M)
    html = replace(html, r'^      async function renderPaypal\(.*?(?=^      async function openRecordedDownload)',
                   "", "unused product checkout", re.M | re.S)
    html = replace(html, r'fetch\(SUPABASE_URL \+ "/functions/v1/paypal-config"\)\.then\(response => response\.ok \? response\.json\(\) : null\)',
                   "client.config()", "sandbox configuration")
    html = replace(html, r'if\(!config\?\.configured\) return false;',
                   'if(!config?.configured || config.environment !== "sandbox") return false;', "sandbox guard")
    html = replace(html, r'let products = \[\];', "let products = [], sandboxReady = false;", "sandbox state")
    html = replace(html, r'if\(item\.price != null && Number\(item\.price\) > 0\)\{ const add',
                   "if(sandboxReady && Number(item.price) > 0){ const add", "sandbox checkout availability")
    html = replace(html, r'status\.textContent = "Preis folgt";',
                   'status.textContent = item.price > 0 ? "PayPal Sandbox ist noch nicht eingerichtet." : "Preis folgt";',
                   "sandbox checkout status")
    html = replace(html, r'window\.open\(result\.data\.download_url, "_blank", "noopener"\);',
                   'const link = document.createElement("a"); link.href = result.data.download_url; '
                   'link.download = result.data.file_name; link.click();', "private sandbox download")
    # A receipt replaces the cart; restore the original cart for a new purchase.
    html = replace(html, r'^      const cart = new Map\(\);$',
                   '      const cart = new Map(), cartMarkup = document.getElementById("cart").innerHTML;',
                   "cart markup", re.M)
    html = replace(html, r'cart\.set\(item\.id, item\);',
                   'if(!document.getElementById("cart-items")) document.getElementById("cart").innerHTML = cartMarkup; '
                   'cart.set(item.id, item);', "restore cart after payment")
    html = replace(html, r'document\.getElementById\("cart-clear"\)\.addEventListener\("click", \(\) => \{ cart\.clear\(\); void renderCart\(\); \}\);',
                   'document.getElementById("cart").addEventListener("click", event => { '
                   'if(event.target.id === "cart-clear"){ cart.clear(); void renderCart(); } });', "cart clear event")
    loader = '''      async function loadPublicProducts(){
    try {
      const [catalog, config] = await Promise.all([window.FindoraStagingCatalog.digital(), client.config()]);
      products = catalog;
      sandboxReady = config?.configured === true && config.environment === "sandbox";
      render();
      document.documentElement.dataset.catalogSource = "pocketbase";
    } catch (error) {
      console.error(error);
      box.innerHTML = '<div class="error">Die eigenen Produkte konnten gerade nicht geladen werden.</div>';
    }
  }'''
    return replace(html, r'^      async function loadPublicProducts\([^\n]+$', loader, "digital checkout catalog", re.M)


def links(html):
    html = re.sub(r'<script src="https://cdn\.jsdelivr\.net/[^"\n]+"></script>\s*', "", html)
    html = html.replace('href="index.html#admin-panel"', 'href="admin.html"')
    for name in ("csvCell", "downloadLinkTemplate", "importLinkTemplate"):
        html = replace(html, rf"^    (?:async )?function {name}\([^\n]+$", "", name, re.M)
    html = replace(html, r'<div><h2>Alle Affiliate-Links schnell wechseln</h2>[^\n]+</div>',
                   '<div><h2>Produktlinks mit Excel ändern</h2>'
                   '<p class="hint">Trage die Ersatzlinks in „Neuer Affiliate-Link“ oder „Neuer Original-Link“ ein. '
                   'Leere Felder werden übersprungen. Lade die Datei hoch und prüfe die Änderungen vor dem Speichern.</p></div>',
                   "Excel link instructions")
    html = html.replace("CSV-Vorlage herunterladen", "Excel-Vorlage herunterladen").replace('accept=".csv,.txt"', 'accept=".xlsx,.csv,.txt"')
    html = replace(html, r'(<input id="link-template-file" type="file" accept="\.xlsx,\.csv,\.txt" hidden></div>)',
                   '<input id="link-template-file" type="file" accept=".xlsx,.csv,.txt" hidden></div>'
                   '<div id="link-import-preview" hidden style="grid-column:1/-1">'
                   '<details><summary id="link-import-count"></summary>'
                   '<ul id="link-import-changes" style="overflow-wrap:anywhere;max-height:16rem;overflow:auto"></ul></details>'
                   '<button id="apply-link-import" class="btn green" type="button">Änderungen speichern</button> '
                   '<button id="cancel-link-import" class="btn" type="button">Abbrechen</button></div>',
                   "Excel link preview")
    adapter = (STAGING / "links.js").read_text(encoding="utf-8")
    html = replace(html, r'^    const client = window\.supabase\.createClient\([^\n]+$',
                   "    const client = window.FindoraStagingSite.admin;\n" + adapter, "link management client", re.M)
    for name in ("uploadImage", "saveProductRow", "deleteProduct", "replaceAll", "boot"):
        html = replace(html, rf"^    async function {name}\([^\n]+client\.[^\n]+$", "", name, re.M)
    html = html.replace('byId("logout").onclick', 'byId("apply-link-import").onclick = saveLinkBatch; '
                        'byId("cancel-link-import").onclick = clearLinkPreview; byId("logout").onclick')
    html = html.replace('async () => { await client.auth.signOut(); location.replace("index.html"); }', 'logout')
    return replace(html, r"</head>", '<script src="site.js"></script>\n'
                   '<script defer src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js" '
                   'integrity="sha384-NG/W3xvO3ynQEcDQYIOcZTXRtwUs83cLv1FIl9PuqWPDuNhsMRF6wutlNLFwlb71" crossorigin="anonymous"></script>\n'
                   '</head>', "link management head")


def template_section(html, pattern, label):
    sections = re.findall(pattern, html, re.M | re.S)
    if len(sections) != 1:
        raise ValueError(f"Expected one {label} in the live template, got {len(sections)}.")
    return sections[0]


def build_admin(source, destination, origin=None):
    sections = {
        "styles": "\n".join(re.findall(r"^<style>.*?^</style>", source.split("</head>", 1)[0], re.M | re.S)),
        "header": template_section(source, r"^<header>.*?^</header>", "header"),
        "panel": template_section(source, r'^<section id="admin-panel".*?^</section>', "admin panel"),
        "login": template_section(source, r'^<div id="login-backdrop".*?^</div>', "login dialog"),
    }
    template = (STAGING / "admin.html").read_text(encoding="utf-8")
    page = re.sub(r"<!-- (styles|header|panel|login) -->", lambda match: sections[match[1]], template)
    customer_link = '<a class="admin-btn" href="?customer=1">Kundenansicht</a>'
    page = replace(page, re.escape(customer_link),
                   customer_link + '<a id="admin-poll-workspace-link" class="admin-btn" href="admin.html?bereich=abstimmungen">Abstimmungen und Fragen</a>'
                   '<a class="admin-btn" href="admin.html?bereich=abstimmungen#abstimmungsergebnisse">Abstimmungsergebnisse</a>'
                   '<a id="admin-search-shortcut" class="admin-btn" href="#admin-search-stats">Suchverlauf</a>', "admin shortcuts")
    page = replace(page, r'<h3>Gespeicherte Abstimmungen und Ergebnisse</h3>',
                   '<div class="link-check-head"><h3 id="abstimmungsergebnisse" tabindex="-1">Gespeicherte Abstimmungen und Ergebnisse</h3>'
                   '<button id="refresh-admin-poll-results" class="admin-btn" type="button">Ergebnisse aktualisieren</button></div>',
                   "poll results controls")
    page = page.replace('<h3>Abstimmung erstellen</h3>', '<h3>Neue Abstimmung oder Frage</h3>')
    page = page.replace('<div class="admin-field"><label>Antworten *</label>',
        '<label class="setting-toggle"><input id="poll-free-text" type="checkbox"> Offene Frage mit Freitextantwort</label>'
        '<div id="poll-choice-fields" class="admin-field"><label>Antwortmöglichkeiten mit optionalen Bildern</label>')
    page = replace(page, r'<form id="admin-poll-form" class="admin-form">',
                   '<div class="poll-template-tools"><label for="poll-template-import">Vorlage öffnen</label>'
                   '<input id="poll-template-import" type="file" accept=".json,application/json"></div>'
                   '<form id="admin-poll-form" class="admin-form">'
                   '<p id="poll-edit-notice" class="admin-note" hidden>Du bearbeitest die laufende Abstimmung. '
                   'Die bisherigen Stimmen bleiben ihren Antwortmöglichkeiten zugeordnet.</p>', "poll template import")
    page = replace(page, r'Abstimmung veröffentlichen</button></form>',
                   'Veröffentlichen</button><button id="poll-edit-cancel" class="admin-btn" type="button" hidden>Bearbeiten abbrechen</button>'
                   '<button id="poll-template-download" class="admin-btn" type="button">'
                   'Entwurf als Vorlage herunterladen</button></form>', "poll template export")
    page = replace(page, r'id="admin-poll-results" class="click-stats-list"><span class="admin-note">Noch keine Abstimmungen vorhanden\.</span></div>',
                   'id="admin-poll-results" class="click-stats-list"><span class="admin-note">Abstimmungen werden geladen …</span></div>'
                   '<div class="admin-actions"><button id="polls-newer" class="admin-btn" type="button" hidden>Neuere Einträge</button>'
                   '<button id="polls-older" class="admin-btn" type="button" hidden>Ältere Einträge</button></div>', "poll results navigation")
    page = replace(page, r'<h3>Suchverlauf</h3>',
                   '<div class="link-check-head"><h3>Suchverlauf</h3>'
                   '<button id="reset-search-history" class="admin-btn danger" type="button">Suchverlauf löschen</button></div>'
                   '<p id="search-history-status" class="admin-note" role="status" hidden></p>', "search history controls")
    page = replace(page, r'id="stats-last30">0</span><span class="admin-stat-label">Letzte 30 Tage',
                   'id="stats-month">0</span><span class="admin-stat-label">Dieser Monat', "monthly visit label")
    if origin:
        page = page.replace('<html lang="de">', '<html lang="de" data-findora-mode="production">')
        page = page.replace("Findora Home · Vorschauverwaltung", "Findora Home · Verwaltung")
        page = page.replace("Produkte, die du selbst herstellst und direkt verkaufen möchtest. Mit einem Preis wird automatisch ein sicherer PayPal-Button angezeigt.",
                            "Verwalte eigene Produkte mit Bildern, Preisen und privaten PDF-Dateien.")
        page = page.replace("Wird nach erfolgreicher PayPal-Zahlung 1 Stunde zum Download freigegeben.", "Die PDF-Datei bleibt privat.")
    (destination / "admin.html").write_text(page, encoding="utf-8")

    # Compile the live view functions together with the PocketBase adapter. No live
    # bootstrap, Supabase client, or Supabase mutation code runs on this page.
    shared_functions = (
        "notice", "clearNotice", "resetProductForm", "resetOwnProductForm",
        "renderAffiliateQuickSearch", "addAdminPollOption", "resetAdminPollForm", "fillCategorySelect",
        "fillPartnerSelect", "adminProductsView", "renderAdminProducts", "decorateProductVisibility",
        "renderAdminOwnProducts", "renderAdminCategories", "renderAdminPartners", "editProduct", "editOwnProduct",
        "resetCategoryForm", "editCategory", "resetPartnerForm", "editPartner",
    )
    poll_functions = (
        "reuseAdminPoll", "renderAdminPolls", "addPollParticipantButtons",
        "closeAdminPoll", "changeAdminPollDuration", "changeAdminPollParticipantGoal", "deleteAdminPoll",
    )
    site_functions = (
        "decorateProductLikeCounts", "loadVisitorStats", "loadStatsResetAt", "renderRecentClickStats", "loadLikeStatsAdmin",
        "loadSearchStatsAdmin", "applyContactEnabled", "loadContactSettingsAdmin", "toggleContactEnabled", "loadContactMessagesAdmin",
        "markContactMessage", "deleteContactMessage", "vacationIsActive", "renderVacationStatus", "loadVacationSettings",
        "saveVacationSettings", "reportFingerprint", "findReportColumn", "amazonWorkbookFromFile", "parseAmazonReport",
        "possibleProductsForReport", "loadAmazonOrders", "importAmazonReport", "sendTelegramTest", "loadTelegramChatIds", "setupDollyWebhook",
    )
    edits = {
        "renderAdminProducts": {
            r"feature\.onclick = \(\) => toggleFeaturedProduct\(product\);":
                "feature.disabled = product.active === false; feature.onclick = () => toggleFeaturedProduct(product);",
        },
        "renderAdminOwnProducts": {
            r"visibility\.onclick = async \(\) => \{.*?; \};":
                'visibility.onclick = () => toggleProductVisibility(product, "own_products");',
        },
        "loadVisitorStats": {
            r'admin\.stats = stats;': 'admin.stats = stats; scheduleVisitorStatsRefresh();',
            r'el\("stats-last30"\)\.textContent = Number\(stats\.last30': 'el("stats-month").textContent = Number(stats.month',
        },
    }
    functions = []
    for name in shared_functions + poll_functions + site_functions:
        function = template_section(source, rf"^  (?:async )?function {name}\([^\n]+$", name)
        for pattern, replacement in edits.get(name, {}).items():
            function = replace(function, pattern, replacement, name)
        if name in ("editProduct", "editOwnProduct"):
            function = replace(function, rf"function {name}\(", f"function fill{name[0].upper() + name[1:]}(", name)
            function = replace(function, r' el\("admin-(?:own-)?name"\)\.focus\(\); window\.scrollTo\([^\n]+?\);', "", name)
        if name in poll_functions:
            function = function.replace("client.rpc(", "pollRpc(")
            function = function.replace("Promise.all([loadAdminPolls(), loadActivePoll()])", "loadAdminPolls()")
        if name == "addAdminPollOption":
            function = function.replace('value = ""', 'value = "", imageUrl = ""')
            function = function.replace('row.className = "admin-poll-option-row";',
                'if (el("admin-poll-options").children.length >= 50) { notice("Bis zu 50 Antworten sind möglich.", "error"); return; } '
                'row.className = "admin-poll-option-row"; input.dataset.pollLabel = ""; input.setAttribute("aria-label", "Antwortmöglichkeit");')
            function = function.replace('remove.type = "button";', 'remove.type = "button"; remove.dataset.removePollOption = "";')
            function = function.replace("row.append(input, remove);",
                'const image = document.createElement("input"); image.type = "url"; image.maxLength = 1000; '
                'image.placeholder = "HTTPS-Bildlink (optional)"; image.setAttribute("aria-label", image.placeholder); '
                'image.dataset.pollImage = ""; image.value = imageUrl; row.append(input, remove, image); addPollImageUpload(row, image);')
        if name == "resetAdminPollForm":
            function = function.replace('.reset();', '.reset(); editingPoll = null; syncPollMode(); el("admin-poll-save").textContent = "Veröffentlichen";')
        if name == "reuseAdminPoll":
            function = function.replace('function reuseAdminPoll(poll) {', 'function reuseAdminPoll(poll) { editingPoll = null;')
            function = function.replace('addAdminPollOption(option.label || "")', 'addAdminPollOption(option.label || "", option.image_url || "")')
            function = function.replace('String(originalDays)', 'String(Number.isInteger(poll.duration_days) && poll.duration_days >= 1 && poll.duration_days <= 365 ? poll.duration_days : originalDays)')
            function = function.replace('el("admin-poll-save").textContent', 'el("poll-free-text").checked = poll.free_text === true; syncPollMode(); el("admin-poll-save").textContent')
        if name == "renderAdminPolls":
            function = function.replace('actions.append(reuse, duration, close, remove);',
                'actions.append(reuse, duration, close, remove); addPollActions(poll, actions); renderPollResponses(poll, options);')
            function = function.replace('" Stimmen";', '" Teilnahmen";')
            function = function.replace('"Erneut verwenden"', '"Als Vorlage bearbeiten"')
        if name == "saveVacationSettings":
            function = function.replace(" await loadVacationNotice();", "")
            function = function.replace("Urlaubsmodus gespeichert. Dolly fasst deinen Tag um 22 Uhr zusammen.", "Urlaubsmodus gespeichert.")
        functions.append(function)
    for variable in ("reportKey", "reportNumber", "reportDate"):
        functions.append(template_section(source, rf"^  const {variable} = [^\n]+$", variable))
    for handler in ("__findoraCheckLinks", "__findoraResetStats", "__findoraResetClicks", "__findoraDownloadCategories",
                    "__findoraRefreshStats", "__findoraDownloadBackup"):
        functions.append(template_section(source, rf"^  window\.{handler} = [^\n]+$", handler))
    for pattern in (r'^  window\.__findoraDownloadStats = [^\n]+\bsection\s*= [^\n]+$',
                    r'^  document\.querySelectorAll\("\.admin-history-toggle"\)[^\n]+$',
                    r'^  document\.querySelectorAll\("\.admin-history-tab"\)[^\n]+$',
                    r'^  const refreshStatsButton = [^\n]+$'):
        function = template_section(source, pattern, "stats controls")
        if function.startswith("  window.__findoraDownloadStats = "):
            function = replace(function, r'"Letzte 30 Tage: " \+ Number\(stats\.last30',
                               '"Dieser Monat: " + Number(stats.month', "monthly visit PDF label")
        functions.append(function)
    adapter = (STAGING / "admin.js").read_text(encoding="utf-8")
    (destination / "admin.js").write_text("(() => {\n" + adapter + "\n" + "\n".join(functions) + "\n  startAdmin();\n})();\n",
                                          encoding="utf-8")


def build_admin_app(source, destination, origin=None):
    install = template_section(source, r'<script>\s*(\(\(\) => \{\s*let installPrompt.*?^\}\)\(\);)\s*</script>', "admin app install")
    install = replace(install, r'^  if \(document\.body\.classList\.contains\("admin-mode"\)\) window\.__findoraEnableApp\(\);$',
                      "", "automatic app setup", re.M)
    (destination / "staging-install.js").write_text(install, encoding="utf-8")
    manifest = (ROOT / "manifest.webmanifest").read_text(encoding="utf-8")
    manifest = manifest.replace("./?app=1#admin-panel", "./admin.html").replace("./?customer=1", "./index.html")
    if not origin:
        manifest = manifest.replace('"name": "Findora Home Verwaltung"', '"name": "Findora Home Vorschauverwaltung"')
    (destination / "manifest.webmanifest").write_text(manifest, encoding="utf-8")
    service_worker = (ROOT / "service-worker.js").read_text(encoding="utf-8")
    cache = "findora-production-app-v9" if origin else "findora-staging-app-v10"
    service_worker = replace(service_worker, r'^const CACHE = [^\n]+$', f'const CACHE = "{cache}";', "app cache", re.M)
    service_worker = service_worker.replace('"./links.html"', '"./links.html", "./admin.html", "./admin.css", "./admin.js", '
                                            '"./site.js", "./staging-install.js", "./staging-catalog.js", "./staging-preview.css"')
    service_worker = replace(service_worker, r'^  if \(url.origin !== self.location.origin\) return;$',
                             '  if (url.origin !== self.location.origin || !SHELL.some(path => new URL(path, self.location.href).href === url.href)) return;',
                             "staging app cache URLs", re.M)
    service_worker = replace(service_worker, r'^  event\.respondWith\(caches\.match\(event.request\)[^\n]+$',
                             '  event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; }).catch(() => caches.match(event.request)));',
                             "staging app asset retrieval", re.M)
    (destination / "service-worker.js").write_text(service_worker, encoding="utf-8")


def build(destination, origin=None, api_origin=""):
    destination.mkdir(parents=True, exist_ok=True)
    for name, adapt in (("index", home), ("disney", disney), ("produkte", digital_catalog if origin else digital_checkout)):
        source = (ROOT / f"{name}.html").read_text(encoding="utf-8")
        (destination / f"{name}.html").write_text(adapt(shared_template(source, name, origin)), encoding="utf-8")
    shutil.copyfile(STAGING / "catalog.js", destination / "staging-catalog.js")
    shutil.copyfile(STAGING / "preview.css", destination / "staging-preview.css")
    if not origin:
        shutil.copyfile(STAGING / "checkout.js", destination / "checkout.js")
    homepage = (ROOT / "index.html").read_text(encoding="utf-8")
    build_admin(homepage, destination, origin)
    build_admin_app(homepage, destination, origin)
    shutil.copyfile(STAGING / "admin.css", destination / "admin.css")
    optimize = template_section(homepage, r"^  async function optimizeImage\([^\n]+$", "image optimization")
    site = (STAGING / "site.js").read_text(encoding="utf-8").replace("    /* product image optimization */", optimize)
    site = replace(site, r'^    const apiOrigin = "";$', "    const apiOrigin = " + json.dumps(api_origin) + ";", "API origin", re.M)
    (destination / "site.js").write_text(site, encoding="utf-8")
    (destination / "links.html").write_text(links((ROOT / "links.html").read_text(encoding="utf-8")), encoding="utf-8")
    for name in ("findora-logo.png", "hero-banner.png", "app-icon-192.png", "app-icon-512.png"):
        shutil.copyfile(ROOT / name, destination / name)
    shutil.copytree(ROOT / "assets" / "disney-decor", destination / "assets" / "disney-decor", dirs_exist_ok=True)


def production_caddy(destination, host, api_only=False):
    staging = (STAGING / "Caddyfile").read_text(encoding="utf-8")
    staging = re.sub(r"\n\s*# Sandbox checkout routes\n.*?\n\s*# End sandbox checkout routes\n", "\n", staging, flags=re.S)
    routes = template_section(staging, r"(^\s*@catalog \{.*?^\s*handle /api/\* \{\s*respond 404\s*\})",
                              "PocketBase proxy routes").strip("\n")
    if api_only:
        routes = re.sub(r"^(\s*method [^\n]+)$", r"\1 OPTIONS", routes, flags=re.M)
        routes = routes.replace("path /api/collections/products/records", "path /api/health /api/collections/products/records", 1)
    template = (PRODUCTION / "Caddyfile").read_text(encoding="utf-8")
    template = template.replace("PUBLIC_HOSTNAME", host)
    if api_only:
        template = template.replace("\t\troot * /srv/findora-home/current\n\t\tfile_server", "\t\trespond 404")
    destination.write_text(template.replace("# POCKETBASE_ROUTES", routes.replace("127.0.0.1:8090", "127.0.0.1:8091")), encoding="utf-8")


def legacy_redirects(destination, origin):
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("index", "disney", "produkte", "admin", "links", "404"):
        path = "/" if name in ("index", "404") else f"/{name}.html"
        target = origin + path
        redirect = json.dumps(target)
        if name == "index":
            redirect = f'(location.hash === "#admin-panel" ? {json.dumps(origin + "/admin.html")} : {redirect})'
        html = f'''<!doctype html>
<html lang="de"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex"><title>Findora Home</title>
<a href="{target}">Weiter zu Findora Home</a>
<script>location.replace({redirect} + location.search + location.hash);</script></html>
'''
        (destination / f"{name}.html").write_text(html, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build Findora from the existing templates for PocketBase staging or production.")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--public-origin", help="production HTTPS website URL, including any base path")
    parser.add_argument("--api-origin", help="separate production HTTPS API origin, without a path")
    parser.add_argument("--caddy-output", type=Path, help="production Caddy site config, outside the website directory")
    parser.add_argument("--legacy-output", type=Path, help="optional redirects for the old GitHub Pages URL")
    args = parser.parse_args()
    if bool(args.public_origin) != bool(args.caddy_output):
        parser.error("--public-origin and --caddy-output must be supplied together")
    if (args.api_origin or args.legacy_output) and not args.public_origin:
        parser.error("--api-origin and --legacy-output require --public-origin")
    if args.public_origin:
        label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
        https_host = rf"https://({label}(?:\.{label})+)"
        public = re.fullmatch(https_host + r"((?:/[a-zA-Z0-9_-]+)*)/?", args.public_origin)
        api = re.fullmatch(https_host + "/?", args.api_origin) if args.api_origin else None
        if not public or (args.api_origin and not api) or (public[2] and not api):
            parser.error("use HTTPS URLs and provide a separate --api-origin for a website with a base path")
        if args.caddy_output.resolve().is_relative_to(args.destination.resolve()):
            parser.error("the Caddy config must be outside the website directory")
        if args.legacy_output and (args.legacy_output.resolve().is_relative_to(args.destination.resolve()) or
                                   args.destination.resolve().is_relative_to(args.legacy_output.resolve()) or
                                   args.caddy_output.resolve().is_relative_to(args.legacy_output.resolve())):
            parser.error("legacy redirects, website files and Caddy config must have separate destinations")
        production_caddy(args.caddy_output, api[1] if api else public[1], api_only=bool(api))
    origin = args.public_origin.rstrip("/") if args.public_origin else None
    build(args.destination, origin, args.api_origin.rstrip("/") if args.api_origin else "")
    if args.legacy_output:
        legacy_redirects(args.legacy_output, origin)
