#!/usr/bin/env bash
# deploy-site.sh <dev|production> <dir>: deploys the site Worker from a
# verified artifact (<dir>, holding worker.ts and site/ from Deploy's build
# job) with the wrangler CLI pinned in wrangler/package-lock.json, which the
# workflow installs (npm ci --ignore-scripts) before the token is in reach.
#
# The artifact was built from repository code without secrets, so everything
# in it is untrusted. The Worker's code and assets may change freely, but the
# config wrangler deploys is generated here and pins this mode's Worker name,
# account, compatibility flags, assets binding, and custom domains.
. "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "Usage: deploy-site.sh <dev|production> <dir>"
mode=$1
case "$mode" in
  dev)
    worker=psychoscript-dev-site
    expected_account=d8e944f537ceef3f06a5bd3aec1d7a53
    routes='[{"pattern":"dev.psychoscript.com","custom_domain":true}]'
    ;;
  production)
    worker=psychoscript-production-site
    expected_account=15d29c8639fd3733b1b5486a2acfd968
    routes='[{"pattern":"psychoscript.com","custom_domain":true},{"pattern":"www.psychoscript.com","custom_domain":true}]'
    ;;
  *) die "Unknown site mode: $mode" ;;
esac
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
[ "$CLOUDFLARE_ACCOUNT_ID" = "$expected_account" ] ||
  die "CLOUDFLARE_ACCOUNT_ID ($CLOUDFLARE_ACCOUNT_ID) does not match $mode account ($expected_account)."

src=$(cd "$2" && pwd)
release=$(cd "$(dirname "$0")" && pwd)

# Only worker.ts and site/ (plus SHA256SUMS from upload); nothing else is accepted.
unexpected=$(cd "$src" && find . ! -type d ! -type f -o -type f ! -path ./SHA256SUMS \
  ! -path ./worker.ts \
  ! -path './site/*')
[ -z "$unexpected" ] || die "Unexpected files in the site artifact: $unexpected"
[ -f "$src/worker.ts" ] || die "Missing worker.ts in the site artifact"
[ -f "$src/site/index.html" ] || die "Missing site/index.html in the site artifact"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$src/worker.ts" "$work/worker.ts"
cp -R "$src/site" "$work/site"

jq -n \
  --arg name "$worker" \
  --arg account_id "$CLOUDFLARE_ACCOUNT_ID" \
  --argjson routes "$routes" \
  '{
    name: $name,
    account_id: $account_id,
    main: "./worker.ts",
    compatibility_date: "2026-08-05",
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: false,
    preview_urls: false,
    assets: {
      directory: "./site",
      binding: "ASSETS",
      run_worker_first: true
    },
    routes: $routes
  }' > "$work/wrangler.jsonc"

wrangler="$release/wrangler/node_modules/.bin/wrangler"
[ -x "$wrangler" ] || die "Install the pinned wrangler CLI first: npm ci --ignore-scripts in .github/release/wrangler"
cd "$work" || exit 1
WRANGLER_SEND_METRICS=false "$wrangler" deploy --config "$work/wrangler.jsonc"
