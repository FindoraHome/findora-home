routerAdd("GET", "/api/findora/staging-admin/catalog", (e) => {
    return require(`${__hooks}/staging_admin.js`).catalog(e);
}, $apis.requireAuth("findora_admins"));

routerAdd("GET", "/api/findora/staging-admin/products/{collection}/{id}", (e) => {
    return require(`${__hooks}/staging_admin.js`).details(e);
}, $apis.requireAuth("findora_admins"));

routerAdd("POST", "/api/findora/staging-admin/products/{collection}/{id}", (e) => {
    return require(`${__hooks}/staging_admin.js`).save(e);
}, $apis.requireAuth("findora_admins"), $apis.bodyLimit(64 * 1024 * 1024));

routerAdd("DELETE", "/api/findora/staging-admin/products/{collection}/{id}", (e) => {
    return require(`${__hooks}/staging_admin.js`).remove(e);
}, $apis.requireAuth("findora_admins"));

routerAdd("POST", "/api/findora/staging-admin/duplicate/{id}", (e) => {
    return require(`${__hooks}/staging_admin.js`).duplicate(e);
}, $apis.requireAuth("findora_admins"));

routerAdd("POST", "/api/findora/staging-admin/taxonomy/{collection}", (e) => {
    return require(`${__hooks}/staging_admin.js`).taxonomy(e);
}, $apis.requireAuth("findora_admins"));

routerAdd("GET", "/api/findora/staging-admin/links", (e) => {
    return require(`${__hooks}/staging_admin.js`).links(e);
}, $apis.requireAuth("findora_admins"));

routerAdd("POST", "/api/findora/staging-admin/links", (e) => {
    return require(`${__hooks}/staging_admin.js`).bulkLinks(e);
}, $apis.requireAuth("findora_admins"));
