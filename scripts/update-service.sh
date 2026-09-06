#!/bin/bash
set -euo pipefail
umask 077
root=${1:-/root/mibot}
[[ "$root" == /root/mibot && -d "$root/.git" ]] || exit 2
exec 9>/run/lock/mibot-update.lock
/usr/bin/flock -n 9 || exit 3
cd "$root"
result_file="$root/temp/update-result.json"
write_result() {
  local status="$1"
  local temp="${result_file}.$$"
  printf '{"status":"%s"}\n' "$status" > "$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$result_file"
}
result="failed"
trap 'write_result "$result"' EXIT
before=$(/usr/bin/git rev-parse HEAD)
/usr/bin/git pull --ff-only origin main
after=$(/usr/bin/git rev-parse HEAD)
if [[ "$before" != "$after" || ! -d node_modules ]]; then
  /usr/bin/npm ci
fi
/usr/bin/npm run package:v2
/usr/bin/npm run check:v2
write_result success
/usr/bin/systemctl restart mibot.service
result=success
