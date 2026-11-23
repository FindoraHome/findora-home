migrate(app => {
    const admins = app.findCollectionByNameOrId("findora_admins");
    admins.authToken.duration = 7 * 24 * 60 * 60;
    app.save(admins);
}, app => {
    const admins = app.findCollectionByNameOrId("findora_admins");
    admins.authToken.duration = 3600;
    app.save(admins);
});
