# Running the reviewer agent locally

This document covers advanced local setup options for the reviewer agent container. For the basic build and run steps, see the [Reproduce this yourself](../README.md#5-build-and-run-the-reviewer-agent-container) section of README.md.

## Sourcing `GH_TOKEN`

### Option A — Personal GitHub token (simplest, for local testing)

```sh
export GH_TOKEN=$(gh auth token)
```

Reviews are posted under your GitHub identity rather than the reviewer-agent bot. This is fine for validating review logic locally; in CI the review is attributed to the reviewer-agent App.

### Option B — Reviewer-agent installation token (matches CI exactly)

If you need the review to appear as coming from the `reviewer-agent` bot, mint a short-lived installation token from the App's private key. You need the **numeric App ID** (visible on the App's settings page at `https://github.com/settings/apps/<app-name>` — it is a plain integer, not the `Iv23.xxx` Client ID) and the private key downloaded in setup step 1 (the `.pem` file).

> **Note on App ID vs. Client ID:** The CI workflow uses `.github/actions/agent-token`, which calls `actions/create-github-app-token` via the `client-id` input — it expects the `Iv23.xxx` Client ID. If your `REVIEWER_APP_ID` repository secret contains the Client ID (valid for that action), it **will not work** as `APP_ID` here — the GitHub JWT API requires the numeric App ID in the `iss` claim. To find the numeric ID, open the App's settings page and look for the plain-integer "App ID" field; it is distinct from the Client ID shown further down the page.

> **Tip:** The guards in this snippet use `exit 1` for error reporting. If you paste it directly into an interactive shell session, a failure will close that session. To avoid this, paste the snippet into a script file and run it, or wrap the whole block in a subshell — but note that a subshell will not export `GH_TOKEN` to the parent shell, so you would need to re-export it after (`export GH_TOKEN="$(...)"` form).

```sh
# Requires: openssl, curl, jq
APP_ID="123456"                            # numeric GitHub App ID (not the Iv23.xxx Client ID)
OWNER="your-org-or-user"
REPO="your-repo"
KEY_FILE="$HOME/.config/agentic-agents/reviewer-agent.pem"

[ -f "$KEY_FILE" ] && [ -r "$KEY_FILE" ] || \
  { echo "KEY_FILE not found or not readable: $KEY_FILE"; exit 1; }

_b64url() { openssl enc -base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
jwt_header=$(printf '{"alg":"RS256","typ":"JWT"}' | _b64url)
jwt_payload=$(printf '{"iat":%s,"exp":%s,"iss":%s}' \
  "$((now - 60))" "$((now + 600))" "$APP_ID" | _b64url)
jwt_sig=$(printf '%s.%s' "$jwt_header" "$jwt_payload" \
  | openssl dgst -sha256 -sign "$KEY_FILE" | _b64url)
JWT="${jwt_header}.${jwt_payload}.${jwt_sig}"

# Fetch the installation for the specific repo (avoids picking the wrong
# installation when the App is installed on multiple accounts/repos)
installation_id=$(curl -sf \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${OWNER}/${REPO}/installation" \
  | jq -r '.id')

[ -n "$installation_id" ] && [ "$installation_id" != "null" ] || \
  { echo "No installation found for ${OWNER}/${REPO} — check APP_ID and that the App is installed on the repo."; exit 1; }

_token=$(curl -sf -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${installation_id}/access_tokens" \
  | jq -r '.token')

[ -n "$_token" ] && [ "$_token" != "null" ] || \
  { echo "Failed to mint installation token — check that the App is installed and the JWT is valid."; exit 1; }

export GH_TOKEN="$_token"
```

The token expires in one hour and carries the same scopes as the CI installation token.

## Using a persistent credentials file

For a reusable setup, write secrets to a permissions-restricted file outside the repo and use `--env-file`:

```sh
# Create once; never commit this file.
# umask 077 ensures the file is created with 600 permissions from the start;
# read -rsp prompts for each secret without echoing it, so values never
# appear in command text or shell history.
(
  umask 077
  read -rsp "ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY && echo
  read -rsp "GH_TOKEN: " GH_TOKEN && echo
  printf 'ANTHROPIC_API_KEY=%s\nGH_TOKEN=%s\n' "$ANTHROPIC_API_KEY" "$GH_TOKEN" \
    > ~/.reviewer-env
)
```

```sh
docker run --rm \
  --env-file ~/.reviewer-env \
  -e GITHUB_REPO="owner/repo" \
  -e GITHUB_PR_NUMBER="42" \
  agent-reviewer
```
