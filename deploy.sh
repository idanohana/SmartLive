#!/usr/bin/env bash
#
# Update SmartLive on the hosting account.
#
#   cd ~/smartlive && ./deploy.sh
#
# Pulls the latest code, installs anything new, and restarts the app through
# Passenger's restart file - no panel clicking needed.

set -euo pipefail
cd "$(dirname "$0")"

echo "==> משיכת הקוד העדכני"
git pull --ff-only

# Only reinstall when the dependency list actually moved; npm install on a
# shared host is slow and there is no reason to pay for it every time.
if ! git diff --quiet HEAD@{1} HEAD -- package-lock.json 2>/dev/null; then
  echo "==> התלויות השתנו, מתקין"
  npm install --omit=dev
else
  echo "==> אין שינוי בתלויות, מדלג על ההתקנה"
fi

echo "==> הפעלה מחדש"
mkdir -p tmp
touch tmp/restart.txt

echo "==> מוכן. הבקשה הבאה תיטען מהקוד החדש."
