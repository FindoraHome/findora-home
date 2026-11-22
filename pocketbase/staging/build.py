import argparse
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
STAGING = Path(__file__).resolve().parent


def replace(text, pattern, replacement, label, flags=0):
    result, matches = re.subn(pattern, lambda _: replacement, text, flags=flags)
    if matches != 1:
        raise ValueError(f"Expected one {label} in the live template, got {matches}.")
    return result


def shared_template(html, page):
    html = re.sub(r'<script src="https://cdn\.jsdelivr\.net/[^"\n]+"></script>\s*', "", html)
    html = replace(html, r"<html(?=\s)", f'<html data-staging-page="{page}"', "HTML element")
    html = replace(html, r"</head>", '<link rel="stylesheet" href="staging-preview.css">\n'
                    '<script src="staging-catalog.js"></script>\n'
                    '<script src="polls.js"></script>\n<script src="site.js"></script>\n</head>', "document head")
    return replace(html, r"<body[^>]*>", '<body>\n<div class="staging-notice">'
                   'Katalogvorschau aus PocketBase · Bestellungen auf der Live-Seite'
                   ' <a href="admin.html">Verwaltung</a></div>', "document body")


def home(html):
    html = re.sub(r"<script>\s*if \(false\) \{.*?</script>", "", html, count=1, flags=re.S)
    html = replace(html, r"^  const client = window\.supabase\.createClient\([^\n]+\);\n",
                   "  const client = window.FindoraStagingSite.public;\n", "homepage client", re.M)
    for name in ("loadActivePoll", "submitPublicPoll"):
        function = template_section(html, rf"^  async function {name}\([^\n]+$", name)
        adapted = function.replace("client.rpc(", "window.FindoraStagingPollRpc(\"staging-polls\", ")
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


def digital(html):
    renderer = re.search(r'^[ \t]+function render\(\)\{.*?(?=^[ \t]+search\.addEventListener)', html, re.M | re.S)
    if not renderer:
        raise ValueError("Digital product renderer was not found.")
    renderer = replace(renderer[0], r"updateProductSchema\(items\); ", "", "digital product schema update")
    renderer = replace(renderer, r'^[ \t]+if\(item\.price != null && Number\(item\.price\) > 0\)[^\n]+$', '''           if (item.price > 0 && !item.staging_only) {
             const buy = document.createElement("a");
             buy.className = "buy";
             buy.href = "https://findorahome.github.io/findora-home/produkte.html#produkt-" + encodeURIComponent(item.id);
             buy.textContent = "Auf der Live-Seite ansehen →";
             body.appendChild(buy);
           }''', "digital product checkout controls", re.M)
    script = '''<script>
    (() => {
      const box = document.getElementById("products"), search = document.getElementById("search");
      const euro = value => Number(value).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
      let products = [];
''' + renderer + '''      search.addEventListener("input", render);
      window.FindoraStagingCatalog.digital().then(items => {
        products = items;
        render();
        document.documentElement.dataset.catalogSource = "pocketbase";
      }).catch(error => {
        console.error(error);
        box.textContent = "Findora-Produkte konnten nicht aus PocketBase geladen werden.";
      });
    })();
  </script>'''
    return replace(html, r"<script>\s*\(function\(\)\{.*?</script>", script, "digital product startup", re.S)


def links(html, homepage):
    html = re.sub(r'<script src="https://cdn\.jsdelivr\.net/[^"\n]+"></script>\s*', "", html)
    html = html.replace('href="index.html#admin-panel"', 'href="admin.html"')
    scripts = '<script src="polls.js"></script><script src="site.js"></script>\n'
    optimize = template_section(homepage, r"^  async function optimizeImage\([^\n]+$", "image optimization")
    adapter = (STAGING / "links.js").read_text(encoding="utf-8")
    html = replace(html, r'^    const client = window\.supabase\.createClient\([^\n]+$',
                   "\n".join(("    const client = window.FindoraStagingSite.admin;", optimize, adapter)), "link management client", re.M)
    for name in ("uploadImage", "saveProductRow", "deleteProduct", "replaceAll", "boot"):
        html = replace(html, rf"^    async function {name}\([^\n]+client\.[^\n]+$", "", name, re.M)
    html = html.replace('client.rpc("bulk_update_affiliate_links", { p_updates: updates })', 'bulkLinks(updates)')
    html = html.replace('async () => { await client.auth.signOut(); location.replace("index.html"); }', 'logout')
    return replace(html, r"</head>", scripts + "</head>", "link management head")


def template_section(html, pattern, label):
    sections = re.findall(pattern, html, re.M | re.S)
    if len(sections) != 1:
        raise ValueError(f"Expected one {label} in the live template, got {len(sections)}.")
    return sections[0]


def build_admin(source, destination):
    sections = {
        "styles": "\n".join(re.findall(r"^<style>.*?^</style>", source.split("</head>", 1)[0], re.M | re.S)),
        "header": template_section(source, r"^<header>.*?^</header>", "header"),
        "panel": template_section(source, r'^<section id="admin-panel".*?^</section>', "admin panel"),
        "login": template_section(source, r'^<div id="login-backdrop".*?^</div>', "login dialog"),
    }
    template = (STAGING / "admin.html").read_text(encoding="utf-8")
    page = re.sub(r"<!-- (styles|header|panel|login) -->", lambda match: sections[match[1]], template)
    (destination / "admin.html").write_text(page, encoding="utf-8")

    # Compile the live view functions together with the PocketBase adapter. No live
    # bootstrap, Supabase client, or Supabase mutation code runs on this page.
    shared_functions = (
        "notice", "clearNotice", "resetProductForm", "resetOwnProductForm", "optimizeImage",
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


def build_admin_app(source, destination):
    install = template_section(source, r'<script>\s*(\(\(\) => \{\s*let installPrompt.*?^\}\)\(\);)\s*</script>', "admin app install")
    install = replace(install, r'^  if \(document\.body\.classList\.contains\("admin-mode"\)\) window\.__findoraEnableApp\(\);$',
                      "", "automatic app setup", re.M)
    (destination / "staging-install.js").write_text(install, encoding="utf-8")
    manifest = (ROOT / "manifest.webmanifest").read_text(encoding="utf-8")
    manifest = manifest.replace("./?app=1#admin-panel", "./admin.html").replace("./?customer=1", "./index.html")
    manifest = manifest.replace('"name": "Findora Home Verwaltung"', '"name": "Findora Home Vorschauverwaltung"')
    (destination / "manifest.webmanifest").write_text(manifest, encoding="utf-8")
    service_worker = (ROOT / "service-worker.js").read_text(encoding="utf-8")
    service_worker = replace(service_worker, r'^const CACHE = [^\n]+$', 'const CACHE = "findora-staging-app-v1";', "staging app cache", re.M)
    service_worker = service_worker.replace('"./links.html"', '"./links.html", "./admin.html", "./admin.css", "./admin.js", '
                                            '"./polls.js", "./site.js", "./staging-install.js", "./staging-catalog.js", "./staging-preview.css"')
    service_worker = replace(service_worker, r'^  if \(url.origin !== self.location.origin\) return;$',
                             '  if (url.origin !== self.location.origin || !SHELL.some(path => new URL(path, self.location.href).href === url.href)) return;',
                             "staging app cache URLs", re.M)
    service_worker = replace(service_worker, r'^  event\.respondWith\(caches\.match\(event.request\)[^\n]+$',
                             '  event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; }).catch(() => caches.match(event.request)));',
                             "staging app asset retrieval", re.M)
    (destination / "service-worker.js").write_text(service_worker, encoding="utf-8")


def build(destination):
    destination.mkdir(parents=True, exist_ok=True)
    for name, adapt in (("index", home), ("disney", disney), ("produkte", digital)):
        source = (ROOT / f"{name}.html").read_text(encoding="utf-8")
        (destination / f"{name}.html").write_text(adapt(shared_template(source, name)), encoding="utf-8")
    shutil.copyfile(STAGING / "catalog.js", destination / "staging-catalog.js")
    shutil.copyfile(STAGING / "preview.css", destination / "staging-preview.css")
    homepage = (ROOT / "index.html").read_text(encoding="utf-8")
    build_admin(homepage, destination)
    build_admin_app(homepage, destination)
    shutil.copyfile(STAGING / "admin.css", destination / "admin.css")
    shutil.copyfile(STAGING / "polls.js", destination / "polls.js")
    shutil.copyfile(STAGING / "site.js", destination / "site.js")
    (destination / "links.html").write_text(links((ROOT / "links.html").read_text(encoding="utf-8"),
                                                homepage), encoding="utf-8")
    for name in ("findora-logo.png", "hero-banner.png", "app-icon-192.png", "app-icon-512.png"):
        shutil.copyfile(ROOT / name, destination / name)
    shutil.copytree(ROOT / "assets" / "disney-decor", destination / "assets" / "disney-decor", dirs_exist_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the private Findora catalog preview from the live templates.")
    parser.add_argument("destination", type=Path)
    build(parser.parse_args().destination)
