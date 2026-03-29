#!/bin/bash
# Generate GitHub App installation token from environment variables.
# Required env: GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_APP_PEM_PATH

set -euo pipefail

: "${GITHUB_APP_ID:?GITHUB_APP_ID is required}"
: "${GITHUB_INSTALLATION_ID:?GITHUB_INSTALLATION_ID is required}"
: "${GITHUB_APP_PEM_PATH:?GITHUB_APP_PEM_PATH is required}"

# Generate JWT
now=$(date +%s)
iat=$((now - 60))
exp=$((now + 300))

header=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e | tr -d '=' | tr '/+' '_-' | tr -d '\n')
payload=$(echo -n "{\"iat\":${iat},\"exp\":${exp},\"iss\":\"${GITHUB_APP_ID}\"}" | openssl base64 -e | tr -d '=' | tr '/+' '_-' | tr -d '\n')
signature=$(echo -n "${header}.${payload}" | openssl dgst -sha256 -sign "$GITHUB_APP_PEM_PATH" | openssl base64 -e | tr -d '=' | tr '/+' '_-' | tr -d '\n')
jwt="${header}.${payload}.${signature}"

# Get installation token
curl -s -X POST \
  -H "Authorization: Bearer $jwt" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens" | jq -r '.token'
