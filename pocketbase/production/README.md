# PocketBase production cutover

The storefront stays at `https://findorahome.github.io/findora-home/`. Caddy serves the PocketBase API and webhook routes at `https://findorahome.duckdns.org`. The production database and integration worker run on separate loopback ports, `8091` and `8192`, with their own service account and data directory.

The production storefront displays products, images, and prices from PocketBase. Online checkout is paused and PDF files stay private. The production site and API require no PayPal credentials.

## Build the release

Use the GitHub Pages website URL and the DuckDNS API origin. The generated Caddy site block replaces the existing DuckDNS health-only block when ready to activate.

```sh
public_url=https://findorahome.github.io/findora-home
public_origin=https://findorahome.github.io
api_origin=https://findorahome.duckdns.org
python3 pocketbase/staging/build.py _site --public-origin "$public_url" \
  --api-origin "$api_origin" --caddy-output /tmp/findora-api.Caddyfile
caddy validate --config /tmp/findora-api.Caddyfile --adapter caddyfile
```

Build the bot worker from the same Telegram and Instagram sources used for staging.

```sh
python3 pocketbase/integrations/build.py /tmp/findora-worker-src
worker_vars=$(sed -n 's/^\(FINDORA_STAGING_[A-Z_]*\)=.*$/\1/p' \
  pocketbase/integrations/staging.env.example | paste -sd, -)
deno compile --no-check --no-config \
  --allow-env="FINDORA_SITE_MODE,FINDORA_STAGING_WORKER_KEY,$worker_vars" \
  --allow-net=127.0.0.1:8192,127.0.0.1:8091,api.telegram.org,api.openai.com,trends.google.com,trends.google.de,www.google.com,findorahome.github.io,graph.facebook.com,graph.instagram.com \
  -o /tmp/findora-integrations-production /tmp/findora-worker-src/worker.ts
```

## Prepare the isolated database

Create the `findoraprod` service user and group. Install the checked-in units and the compiled worker at `/opt/findora-integrations/findora-integrations-production`. Copy `pb_hooks/` and `pb_migrations/` under `/etc/findora-pocketbase-production/` as `hooks/` and `migrations/`, and put `production/configure.pb.js` and `link_checks.py` in the hooks directory. Create `/var/lib/findora-pocketbase-production` with mode `0750`, owned by `findoraprod`.

Create `/etc/findora-pocketbase-production/site.env` with mode `0600` and ownership `root:root`. Set `FINDORA_PUBLIC_ORIGIN=https://findorahome.github.io` for browser CORS. Generate `FINDORA_PRODUCTION_SETTINGS_KEY` with `openssl rand -hex 16` and `FINDORA_STAGING_WORKER_KEY` with `openssl rand -hex 32`, and retain them securely with backup access. Use the variable names in `integrations/staging.env.example` for the production integration credentials. Configure SMTP in PocketBase through an SSH tunnel to port `8091`, and set `FINDORA_STAGING_CONTACT_TO_EMAIL` in `site.env`. Set `FINDORA_STAGING_INSTAGRAM_REPLY_URL` to the GitHub Pages storefront and `FINDORA_STAGING_DOLLY_WEBHOOK_URL` to `https://findorahome.duckdns.org/integrations/dolly`. Keep real bot credentials out of rehearsals so they cannot send notifications or replace live webhooks.

Rehearse with a disposable data directory. At cutover, pause live edits and use a **fresh verified Supabase backup** containing the database archive and Storage manifest and files. Start from a fresh production data directory. The importer preserves records already present on reruns, so a rehearsal database is unsuitable for the final sync. Keep the existing staging database separate.

```sh
python3 pocketbase/prepare_snapshot.py /private/recent-supabase-backup /private/findora-cutover --production

# Give findoraprod access to this private snapshot and its parent directory first.
pb() {
  systemd-run --quiet --wait --pipe --collect \
    -p User=findoraprod -p Group=findoraprod -p Environment=FINDORA_SITE_MODE=production \
    -p EnvironmentFile=/etc/findora-pocketbase-production/site.env \
    /opt/findora-pocketbase/0.40.6/pocketbase "$@" \
    --dir=/var/lib/findora-pocketbase-production/pb_data \
    --migrationsDir=/etc/findora-pocketbase-production/migrations \
    --hooksDir=/etc/findora-pocketbase-production/hooks --encryptionEnv=FINDORA_PRODUCTION_SETTINGS_KEY
}
pb migrate up
pb configure-findora-production "$api_origin"
pb import-findora /private/findora-cutover
```

Verify import counts against the final backup. The production import keeps prior poll selections under hashed visitor IDs and carries forward Telegram summary markers. Older completed polls retain their results without replaying old Telegram notifications. Retain the Supabase archive for historical records and keep the imported PDF collection private.

## Activate and verify

1. Verify the DuckDNS `A` and `AAAA` records point to the VPS. Start production PocketBase, check its loopback health endpoint, and validate and reload Caddy with the production API block. Verify a CORS preflight from `https://findorahome.github.io` and confirm that anonymous requests cannot reach admin writes, the PocketBase dashboard, private PDFs, or the worker bridge.
2. Once the production API is ready and the PR is merged, choose GitHub Actions as the Pages source in repository settings. Run the **Publish Findora Home** workflow on `main`. The workflow is manual, so merging the source alone leaves the current storefront in place.
3. Verify the published Pages site against the production API. Check admin sign-in and catalog editing, affiliate links, images, polls, inbox, visits, and the checkout pause notice on the product page. Confirm the browser makes no Supabase or PayPal requests.
4. Once notification delivery is ready, disable the old scheduled Telegram and poll notifications in Supabase and start the configured production integration worker. Register the production Telegram and Instagram callback URLs on DuckDNS and verify delivery. Keep the Supabase jobs and callbacks documented for rollback.
5. Take a production PocketBase backup and retain it off the VPS. Keep the final source backup and previous Caddy configuration available during the rollout.

If a check fails, set the Pages source back to the `main` branch root, restore the Caddy configuration, and point the bot callbacks and scheduled jobs back to Supabase if they moved. Retain the PocketBase database to reconcile edits, votes, or messages recorded after the cutover.
