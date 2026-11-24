#!/usr/bin/env bash
# Mints a short-lived Cloudflare token for the current job from the token issuer
# (anomalyco/secrets). Run after aws-actions/configure-aws-credentials has assumed
# arn:aws:iam::604439173067:role/github/psychoscript-<mode>, with its credentials
# passed via step outputs (output-env-credentials: false).
set -euo pipefail
set +x

url=${CLOUDFLARE_TOKEN_URL:-https://kjivkui2evldapbok5fhrrl6oy0fctkp.lambda-url.us-east-1.on.aws/}
account=${CLOUDFLARE_ACCOUNT_ID:-15d29c8639fd3733b1b5486a2acfd968}

url_pattern='^https://[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws/$'
if ! [[ "$url" =~ $url_pattern ]]; then
  echo "::error::CLOUDFLARE_TOKEN_URL is not the token issuer's function URL." >&2
  exit 1
fi
case "$account" in
  *[!0-9a-f]*|"")
    echo "::error::CLOUDFLARE_ACCOUNT_ID must be a 32-character lowercase hex id." >&2
    exit 1
    ;;
esac
if [ ${#account} -ne 32 ]; then
  echo "::error::CLOUDFLARE_ACCOUNT_ID must be a 32-character lowercase hex id." >&2
  exit 1
fi
for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  if [ -z "${!name:-}" ]; then
    echo "::error::$name is not set; pass the configure-aws-credentials outputs to this step." >&2
    exit 1
  fi
done

response=$(
  printf 'user = "%s:%s"\nheader = "x-amz-security-token: %s"\n' \
    "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" |
    curl --config - \
      --proto '=https' --proto-redir '=https' \
      --aws-sigv4 "aws:amz:us-east-1:lambda" \
      --request POST --url "$url" \
      --fail-with-body --silent --show-error --max-time 20
)

token=$(printf '%s' "$response" | jq -er 'if (.token | type) == "string" then .token else error("token") end' 2>/dev/null)
expires=$(printf '%s' "$response" | jq -er 'if (.expires_on | type) == "string" then .expires_on else error("expires_on") end' 2>/dev/null)

case "$token" in
  ""|*[[:space:]]*)
    echo "::error::The token issuer returned an invalid token." >&2
    exit 1
    ;;
esac
if [ ${#token} -lt 8 ] || [ ${#token} -gt 512 ]; then
  echo "::error::The token issuer returned an invalid token length." >&2
  exit 1
fi
iso_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
if ! [[ "$expires" =~ $iso_pattern ]]; then
  echo "::error::The token issuer returned an invalid expires_on." >&2
  exit 1
fi

printf '::add-mask::%s\n' "$token"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'token=%s\n' "$token"
    printf 'expires_on=%s\n' "$expires"
  } >> "$GITHUB_OUTPUT"
elif [ -n "${GITHUB_ENV:-}" ]; then
  printf 'CLOUDFLARE_API_TOKEN=%s\n' "$token" >> "$GITHUB_ENV"
fi

verify_url="https://api.cloudflare.com/client/v4/accounts/$account/tokens/verify"
if ! verify=$(printf 'header = "Authorization: Bearer %s"\nurl = "%s"\n' "$token" "$verify_url" |
  curl --config - --proto '=https' --proto-redir '=https' --silent --show-error --fail-with-body --max-time 20); then
  echo "::error::Cloudflare rejected the freshly minted token." >&2
  exit 1
fi

if ! printf '%s' "$verify" | jq -e '.success == true and .result.status == "active"' > /dev/null; then
  echo "::error::Cloudflare did not report the freshly minted token as active." >&2
  exit 1
fi

echo "::notice::Cloudflare token ready; expires $expires"
