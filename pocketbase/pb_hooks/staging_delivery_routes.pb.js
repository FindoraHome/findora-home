routerAdd("POST", "/api/findora/staging-admin/delivery/{action}", (e) => {
    return require(`${__hooks}/staging_delivery.js`).admin(e);
}, $apis.requireAuth("findora_admins"), $apis.bodyLimit(16000));

cronAdd("findora-staging-notifications", "* * * * *", () => {
    require(`${__hooks}/staging_polls.js`).queueResults($app);
    require(`${__hooks}/staging_delivery.js`).flush($app);
});
