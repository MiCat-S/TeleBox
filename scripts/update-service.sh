#!/bin/bash
set -euo pipefail
umask 077
root=${1:-/root/mibot}
[[ "$root" == /root/mibot && -d "$root/.git" ]] || exit 2
exec 9>/run/lock/mibot-update.lock
/usr/bin/flock -n 9 || exit 3
cd "$root"
before=$(/usr/bin/git rev-parse HEAD)
/usr/bin/git pull --ff-only origin main
after=$(/usr/bin/git rev-parse HEAD)
if [[ "$before" != "$after" || ! -d node_modules ]]; then
  /usr/bin/npm ci
fi
/usr/bin/npm run package:v2
/usr/bin/npm run check:v2
/usr/bin/systemctl restart mibot.service
