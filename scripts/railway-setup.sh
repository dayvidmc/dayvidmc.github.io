#!/usr/bin/env bash
#
# One-shot Railway setup for tokessy-ops.
#
# Written against Railway CLI 5.30.3 — every flag used here was checked against
# that version's `--help`. If your CLI is much newer and a step fails on an
# unknown flag, `railway <command> --help` is the authority, not this file.
#
# Safe to re-run. Each step checks whether it has already been done and skips
# rather than duplicating. If a step fails, do that one step in the Railway
# dashboard (docs/DEPLOY.md has the click-path) and run this again — it will
# pick up where it stopped.
#
# Usage:
#   railway login          # once, opens a browser
#   ./scripts/railway-setup.sh
#
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-tokessy-ops}"
SERVICE_NAME="${SERVICE_NAME:-tokessy-ops}"
REPO="${REPO:-dayvidmc/dayvidmc.github.io}"
BRANCH="${BRANCH:-claude/tokessy-tournament-ops-3uz5t4}"
# The demo flag shows each tile's PIN on the sign-in screen. Fine for a
# throwaway deployment, wrong the moment this holds a real schedule.
DEMO_MODE="${DEMO_MODE:-true}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
die()  { printf '\033[31m!!! %s\033[0m\n' "$1" >&2; exit 1; }

# --- 0. Preflight -----------------------------------------------------------

command -v railway >/dev/null 2>&1 || die "Railway CLI not found. Install it: npm i -g @railway/cli"

step "Checking Railway sign-in"
if ! railway whoami >/dev/null 2>&1; then
  die "Not signed in. Run 'railway login' first, then re-run this script."
fi
railway whoami

# --- 1. Project -------------------------------------------------------------
#
# A separate project from Pawl, deliberately. Separate projects get separate
# databases, variables and usage — which matters here because this one is idle
# for 51 weeks and then very much alive for three days, and that spike should
# not share a plan with something you rely on year-round.

step "Project"
if railway status --json >/dev/null 2>&1; then
  echo "    Directory is already linked to a project — reusing it."
else
  railway init --name "$PROJECT_NAME"
fi
railway status

# --- 2. Postgres ------------------------------------------------------------

step "Postgres"
if railway status --json 2>/dev/null | grep -qi '"name": *"Postgres"'; then
  echo "    Postgres service already exists — skipping."
else
  railway add --database postgres
fi

# Railway names the database service "Postgres". The app service does NOT get
# DATABASE_URL for free — it needs a reference variable pointing at the database
# service, which is what step 4 sets. Confirm the name here so a rename upstream
# fails loudly instead of producing a service that boots without a database.
PG_SERVICE="$(railway status --json 2>/dev/null \
  | grep -oiE '"name": *"(Postgres[^"]*)"' | head -1 \
  | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$PG_SERVICE" ] || die "Could not find the Postgres service. Add it in the dashboard, then re-run."
echo "    Database service: $PG_SERVICE"

# --- 3. App service ---------------------------------------------------------
#
# Linked to the GitHub repo so pushes to $BRANCH redeploy automatically. This
# needs the Railway GitHub App to have access to $REPO. If it does not, the
# command below fails — install it at https://github.com/apps/railway-app, or
# fall back to `railway up` (uploads this directory once, no auto-deploy).

step "App service ($SERVICE_NAME) from $REPO@$BRANCH"
if railway status --json 2>/dev/null | grep -q "\"name\": *\"$SERVICE_NAME\""; then
  echo "    Service already exists — skipping creation."
else
  railway add --service "$SERVICE_NAME" --repo "$REPO" --branch "$BRANCH" \
    || die "Could not create the service from GitHub. Either grant the Railway GitHub App access to $REPO and re-run, or deploy this directory once with: railway up --service $SERVICE_NAME"
fi

# --- 4. Variables -----------------------------------------------------------
#
# --skip-deploys on every set so the service is not redeployed three times with
# a half-built environment. The deploy is triggered once, in step 5.

step "Environment variables"

# Single quotes matter: ${{...}} is Railway reference syntax and must reach the
# API literally, not be expanded by bash.
railway variable set "DATABASE_URL=\${{$PG_SERVICE.DATABASE_URL}}" \
  --service "$SERVICE_NAME" --skip-deploys >/dev/null
echo "    DATABASE_URL -> reference to $PG_SERVICE"

# Rotating SESSION_SECRET signs every staff PIN session out and invalidates
# every outstanding team and volunteer magic link. Set once, then leave it.
if railway variable list --service "$SERVICE_NAME" --kv 2>/dev/null | grep -q '^SESSION_SECRET='; then
  echo "    SESSION_SECRET already set — leaving it alone (rotating it breaks live links)."
else
  openssl rand -base64 48 \
    | railway variable set SESSION_SECRET --stdin \
        --service "$SERVICE_NAME" --skip-deploys >/dev/null
  echo "    SESSION_SECRET generated (48 random bytes, never printed)"
fi

railway variable set "DEMO_MODE=$DEMO_MODE" \
  --service "$SERVICE_NAME" --skip-deploys >/dev/null
echo "    DEMO_MODE=$DEMO_MODE"

# Twilio, Anthropic and Square are all optional — the app boots without them.
# See .env.example and docs/DEPLOY.md for what each one switches on.

# --- 5. Domain and deploy ---------------------------------------------------

step "Public domain"
railway domain --service "$SERVICE_NAME" || warn "Could not create a domain — add one in the dashboard under Settings > Networking."

step "Deploying"
# railway.json already sets the build and start commands and points the health
# check at /api/health, so there is nothing to configure here. Migrations run on
# boot: `npm start` is `npm run migrate && next start`, and the runner takes a
# Postgres advisory lock so two instances starting together cannot race.
railway up --service "$SERVICE_NAME" --ci \
  || die "Deploy failed. 'railway logs --service $SERVICE_NAME' has the build output."

# --- 6. Verify --------------------------------------------------------------

step "Verifying"
URL="$(railway domain --service "$SERVICE_NAME" 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)"
if [ -z "$URL" ]; then
  warn "No domain found to check. Look for it in the dashboard and hit /api/health yourself."
else
  echo "    $URL/api/health"
  for attempt in $(seq 1 30); do
    BODY="$(curl -fsS --max-time 10 "$URL/api/health" 2>/dev/null || true)"
    case "$BODY" in
      *'"ok":true'*)
        echo "    $BODY"
        printf '\n\033[32mUp.\033[0m %s\n' "$URL"
        echo
        echo "Next:"
        echo "  1. railway ssh --service $SERVICE_NAME 'npm run demo'   # load demo data"
        echo "  2. Turn on Postgres backups — dashboard only, and losing Saturday's scores loses the tournament."
        echo "  3. Read the 'Before it holds anything real' section of docs/DEPLOY.md."
        exit 0
        ;;
    esac
    printf '    waiting for health check (%s/30)\r' "$attempt"
    sleep 10
  done
  echo
  warn "Health check never came back ok. 'railway logs --service $SERVICE_NAME' will say why."
  warn "The usual cause is DATABASE_URL not resolving — check it under the service's Variables tab."
  exit 1
fi
