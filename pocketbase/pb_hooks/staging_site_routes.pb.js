routerAdd("POST", "/api/findora/staging-site/{action}", (e) => {
    return require(`${__hooks}/staging_site.js`).visitor(e);
}, $apis.bodyLimit(32 * 1024));

routerAdd("POST", "/api/findora/staging-admin/site/{action}", (e) => {
    return require(`${__hooks}/staging_site.js`).admin(e);
}, $apis.requireAuth("findora_admins"), $apis.bodyLimit(2 * 1024 * 1024));
