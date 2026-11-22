routerAdd("GET", "/api/findora/sandbox-checkout/paypal-config", e => {
    return require(`${__hooks}/staging_checkout.js`).config(e);
});

routerAdd("POST", "/api/findora/sandbox-checkout/{action}", e => {
    return require(`${__hooks}/staging_checkout.js`).invoke(e);
});

routerAdd("GET", "/api/findora/sandbox-checkout/download/{order}/{product}", e => {
    return require(`${__hooks}/staging_checkout.js`).download(e);
});
