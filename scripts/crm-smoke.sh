#!/usr/bin/env bash
# Smoke test the tsplus-outreach CRM connection the way the adapter does:
# form-urlencoded login -> bearer token -> GET /api/prospects.
# Reads CRM_API_BASE / CRM_USERNAME / CRM_PASSWORD from .env. Run after creds are set.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${CRM_API_BASE:?CRM_API_BASE missing in .env}"
: "${CRM_USERNAME:?CRM_USERNAME missing in .env}"
: "${CRM_PASSWORD:?CRM_PASSWORD missing in .env}"

echo "1) login -> token"
tok=$(curl -sS -m 10 -X POST "$CRM_API_BASE/api/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode grant_type=password \
  --data-urlencode "username=$CRM_USERNAME" \
  --data-urlencode "password=$CRM_PASSWORD" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
[ -n "$tok" ] || { echo "   FAIL: no access_token (bad creds or 2FA on the account)"; exit 1; }
echo "   ok: token acquired"

echo "2) GET /api/prospects (authorized)"
code=$(curl -sS -m 10 -o /tmp/crm_prospects.json -w "%{http_code}" \
  "$CRM_API_BASE/api/prospects?limit=1" -H "Authorization: Bearer $tok")
echo "   HTTP $code"
[ "$code" = "200" ] || { echo "   FAIL: expected 200"; cat /tmp/crm_prospects.json; exit 1; }
echo "   ok: authorized read works — CRM connection is GREEN"
