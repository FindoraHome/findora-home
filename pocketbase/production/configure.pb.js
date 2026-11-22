$app.rootCmd.addCommand(new Command({
    use: "configure-findora-production <https-origin>",
    short: "Configure an isolated production PocketBase database behind Caddy",
    run: (_command, args) => {
        if (args.length !== 1 || !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(args[0])) {
            throw new Error("Expected the production HTTPS origin without a path or trailing slash.");
        }
        const settings = $app.settings();
        settings.meta.appName = "Findora Home";
        settings.meta.appURL = args[0];
        settings.trustedProxy.headers = ["X-Forwarded-For"];
        settings.trustedProxy.useLeftmostIP = false;
        settings.rateLimits.enabled = true;
        settings.rateLimits.rules = [
            { label: "*:auth", audience: "", duration: 60, maxRequests: 10 },
            { label: "/api/findora/staging-site/submit_contact", audience: "", duration: 60, maxRequests: 8 },
            { label: "/api/findora/staging-polls/vote_in_poll_multi", audience: "", duration: 60, maxRequests: 30 },
            { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
        ];
        $app.save(settings);
    },
}));
