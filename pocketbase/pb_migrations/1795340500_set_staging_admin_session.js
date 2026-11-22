migrate((app) => {
    const admins = app.findCollectionByNameOrId("findora_admins");
    admins.authAlert.enabled = false;
    admins.authToken.duration = 3600;
    app.save(admins);
});
