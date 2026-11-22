routerAdd("POST", "/api/findora/staging-admin/polls/{action}", (e) => {
    return require(`${__hooks}/staging_polls.js`).admin(e);
}, $apis.requireAuth("findora_admins"), $apis.bodyLimit(64 * 1024));

routerAdd("POST", "/api/findora/staging-polls/{action}", (e) => {
    return require(`${__hooks}/staging_polls.js`).visitor(e);
}, $apis.bodyLimit(16 * 1024));
