#!/bin/sh
# Uploads site/ to the Cloudflare Pages project. The account is pinned so a
# shell signed in to another account fails and does not deploy there.
set -eu
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID before deploying}"
export CLOUDFLARE_ACCOUNT_ID
exec bunx wrangler@latest pages deploy site --project-name psychoscript --branch main --commit-dirty=true "$@"
