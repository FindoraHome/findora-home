migrate((app) => {
    app.save(new Collection({
        type: "auth",
        name: "findora_admins",
        authRule: "",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        manageRule: null,
        passwordAuth: { enabled: true, identityFields: ["email"] },
    }));
});
