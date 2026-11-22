# PocketBase production cutover

Merging the PR leaves GitHub Pages serving its current files. The production build uses the same storefront templates, PocketBase schemas, and admin code as staging. The production database and integration worker run on separate loopback ports, `8091` and `8192`, with their own service account and data directory.

The own-products page uses PocketBase for product presentation and the existing Supabase payment APIs for the cart, purchase prices, payment capture, and paid download recovery. A card gets a buy button only when its original product ID has an active Supabase payment price. Keep managing prices, checkout availability, and paid files in Supabase. For a new paid listing, create it in Supabase and import its original ID into PocketBase. Creating a display listing in PocketBase does not publish it for purchase.

## Build the release

Use the chosen HTTPS domain and a new release directory on the VPS. The existing public Caddy configuration should import the generated site block when ready to activate.

```sh
origin=https://shop.example.com
release=/srv/findora-home/releases/COMMIT_SHA
python3 pocketbase/staging/build.py "$release" \
  --public-origin "$origin" --caddy-output /tmp/findora-home.caddy \
  --legacy-output /tmp/findora-github-redirects
caddy validate --config /tmp/findora-home.caddy --adapter caddyfile
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

Create `/etc/findora-pocketbase-production/site.env` with mode `0600` and ownership `root:root`. Set `FINDORA_PUBLIC_ORIGIN` to the build's HTTPS origin. Generate `FINDORA_PRODUCTION_SETTINGS_KEY` with `openssl rand -hex 16` and `FINDORA_STAGING_WORKER_KEY` with `openssl rand -hex 32`, and retain them securely with backup access. Use the variable names in `integrations/staging.env.example` for the production credentials. Configure SMTP in PocketBase through an SSH tunnel to port `8091`, and set `FINDORA_STAGING_CONTACT_TO_EMAIL` in `site.env`. Set `FINDORA_STAGING_INSTAGRAM_REPLY_URL` to the new storefront and `FINDORA_STAGING_DOLLY_WEBHOOK_URL` to its `/integrations/dolly` URL. Keep real bot credentials out of rehearsals so they cannot send notifications or replace live webhooks.

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
pb configure-findora-production "$origin"
pb import-findora /private/findora-cutover
```

Verify import counts against the final backup. The production import keeps prior poll selections under hashed visitor IDs and carries forward Telegram summary markers. A new domain starts new browser storage. Older completed polls retain their results without replaying old Telegram notifications. Order history and purchased files remain in Supabase.

## Activate and verify

1. Point the domain's `A` and `AAAA` records to the VPS. Start the production PocketBase service and verify its loopback health endpoint. Point `/srv/findora-home/current` to the built release, import the generated site block into the VPS's existing Caddy configuration, validate the combined config, and reload Caddy.
2. Verify production admin sign-in and catalog editing, affiliate links, image loading, polls, the inbox, and visits on the new domain. Confirm anonymous requests cannot reach the inbox, admin writes, PocketBase dashboard, private PDF collection, or worker bridge.
3. Verify the payment boundary with a PayPal Sandbox account or a separate payment test project before directing shoppers to the new domain. Check that an active Supabase item opens checkout from the PocketBase catalog and that a known order restores its paid downloads through the existing API.
4. Once notification delivery is ready, disable the old scheduled Telegram and poll notifications in Supabase and start the configured production integration worker. Register the production Telegram and Instagram callback URLs and verify delivery. Keep the Supabase jobs and callbacks documented for rollback. Avoid enabling PocketBase purchase notifications while the payment functions still send them.
5. Publish the separate redirect build at the old GitHub Pages URL. Its redirects preserve the path for known pages, the order query string, and fragments. Test an old receipt link after publishing. Existing and future Supabase receipts still use that GitHub Pages URL, which must remain reachable while those links are in use.
6. Take a production PocketBase backup and retain it off the VPS. Keep the final source backup and previous Caddy configuration available during the rollout.

If a check fails, restore the previous GitHub Pages deployment before routing users back to it, restore the Caddy configuration, and point the bot callbacks and scheduled jobs back to Supabase if they moved. Retain the PocketBase database so edits, votes, or messages recorded after the cutover can be reconciled before retrying.
