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
        html = replace(html, rf"^  async function {name}\([^\n]+$", adapted, name, re.M)
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
    adapter = (STAGING / "links.js").read_text(encoding="utf-8")
    html = replace(html, r'^    const client = window\.supabase\.createClient\([^\n]+$',
                   "    const client = window.FindoraStagingSite.admin;\n" + adapter, "link management client", re.M)
    for name in ("uploadImage", "saveProductRow", "deleteProduct", "replaceAll", "boot"):
        html = replace(html, rf"^    async function {name}\([^\n]+client\.[^\n]+$", "", name, re.M)
    html = html.replace('client.rpc("bulk_update_affiliate_links", { p_updates: updates })', 'bulkLinks(updates)')
    html = html.replace('async () => { await client.auth.signOut(); location.replace("index.html"); }', 'logout')
    return replace(html, r"</head>", '<script src="site.js"></script>\n</head>', "link management head")


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
        "reuseAdminPoll", "renderAdminPolls", "addPollParticipantButtons", "loadAdminPolls", "createAdminPoll",
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
            function = function.replace("if (!admin.isAdmin) return;", "const session = token; if (!session) return;")
            function = function.replace('await pollRpc("get_admin_polls");',
                                        'await pollRpc("get_admin_polls"); if (session !== token) return;')
            function = function.replace(" void loadVacationSettings();", "")
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
        functions.append(template_section(source, pattern, "stats controls"))
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
    cache = "findora-production-app-v2" if origin else "findora-staging-app-v3"
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
