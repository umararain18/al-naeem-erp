#!/usr/bin/env bash
# ============================================================
# ANC ERP — production deploy script.
#
# Safe-by-design: this script never resets, seeds, or pushes the
# database schema, never deletes data, never touches .env, and never
# prints a secret value. It deliberately does NOT run
# `prisma migrate deploy` automatically — see the MIGRATION GATE
# below and docs/PRODUCTION_DEPLOYMENT.md for why.
#
# Intended to be run manually on the VPS, inside the project
# directory, by whoever has deploy access:
#
#   bash scripts/deploy.sh
#
# Not invoked by anything in this repository automatically.
# ============================================================

set -euo pipefail

echo "=== ANC ERP deploy: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

if [ ! -f package.json ] || [ ! -f prisma/schema.prisma ]; then
  echo "ERROR: run this from the project root (package.json / prisma/schema.prisma not found here)." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "ERROR: .env not found. This script never creates or overwrites .env — provide it manually first (see .env.example)." >&2
  exit 1
fi

echo "--- 1. Install dependencies (npm ci: exact, lockfile-pinned install) ---"
npm ci

echo "--- 2. Generate Prisma Client for this platform ---"
npx prisma generate

echo "--- 3. MIGRATION GATE (read-only check, never auto-applies) ---"
echo "This repository's committed migration history is known to be"
echo "incomplete relative to the current schema.prisma (see"
echo "docs/PRODUCTION_DEPLOYMENT.md, 'Migration status' section) —"
echo "several tables exist in the development database only because"
echo "they were pushed directly with 'prisma db push', never captured"
echo "in a migration file. Running 'prisma migrate deploy' blind"
echo "against production could leave it with an incomplete schema."
echo ""
echo "Showing migration status only — NOT applying anything:"
set +e
npx prisma migrate status
MIGRATE_STATUS_EXIT=$?
set -e

if [ $MIGRATE_STATUS_EXIT -ne 0 ]; then
  echo ""
  echo "STOPPING: 'prisma migrate status' did not report a clean,"
  echo "up-to-date state (see output above). Resolve this manually"
  echo "(review docs/PRODUCTION_DEPLOYMENT.md's Migration Status"
  echo "section) before continuing — this script will not guess."
  exit 1
fi

echo ""
read -r -p "Migration status looked clean above. Continue with build + restart? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted by operator. No build or restart performed."
  exit 1
fi

echo "--- 4. Build ---"
npm run build

echo "--- 5. Restart via PM2 (reload = zero-downtime if already running) ---"
if pm2 describe anc-erp > /dev/null 2>&1; then
  pm2 reload ecosystem.config.js --env production
else
  pm2 start ecosystem.config.js --env production
fi

pm2 save

echo "--- Done. Check status with: pm2 status / pm2 logs anc-erp ---"
