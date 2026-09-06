#!/bin/bash
# First-time installation for an already configured account.
set -euo pipefail
umask 077

if [[ "${1:-}" == "--help" && $# == 1 ]]; then
  printf '%s\n' 'Usage: bash scripts/install-service.sh' \
    'Requires Linux/systemd, root, Node 24 at /usr/bin/node, config.json,' \
    '/root/mibot and sibling /root/mibot-plugins.' \
    'Installs and starts mibot. Refuses active or enabled services.'
  exit 0
fi
[[ $# == 0 ]] || { echo "Unsupported arguments" >&2; exit 2; }
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo "Run on Linux as root" >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ "$root" == /root/mibot ]] || { echo "Install the core repository at /root/mibot" >&2; exit 1; }
cd "$root"
for executable in /usr/bin/node /usr/bin/systemctl /usr/bin/systemd-analyze /usr/bin/flock /usr/bin/journalctl /usr/bin/dig; do
  [[ -x "$executable" ]] || { echo "Missing executable: $executable" >&2; exit 1; }
done
[[ $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo "Node 24 required at /usr/bin/node" >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo "systemd must be running" >&2; exit 1; }
[[ -d /root/mibot-plugins && -d node_modules ]] || { echo "Install dependencies and the sibling plugin repository first" >&2; exit 1; }
[[ -f config.json && ! -L config.json ]] || { echo "Run npm run login first; config.json must be a regular file" >&2; exit 1; }
/usr/bin/node - <<'NODE'
const fs = require('fs');
try {
  const c = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  if (!Number.isSafeInteger(c.api_id) || c.api_id <= 0 ||
      typeof c.api_hash !== 'string' || !c.api_hash.trim() ||
      typeof c.session !== 'string' || !c.session.trim()) throw new Error();
} catch {console.error('Invalid account configuration; contents were not printed'); process.exit(1);}
NODE

exec 9>/run/lock/mibot-install.lock
/usr/bin/flock -n 9 || { echo "Another installer is running" >&2; exit 1; }
state=$(/usr/bin/systemctl show mibot -p ActiveState --value)
previous=$(/usr/bin/systemctl show telebox-v2 -p ActiveState --value)
case "$previous" in inactive|failed|"") ;; *) echo "Existing account service is running; stop it before installation" >&2; exit 1 ;; esac
case "$state" in inactive|failed|"") ;; *) echo "MiBot service is $state; do not install over a running instance" >&2; exit 1 ;; esac
enabled=$(/usr/bin/systemctl is-enabled mibot 2>/dev/null || true)
case "$enabled" in disabled|not-found|"") ;; *) echo "Existing service is $enabled; use the upgrade procedure" >&2; exit 1 ;; esac
# Check process command lines without printing potential credentials.
/usr/bin/node - <<'NODE'
const fs = require('fs');
for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (/(?:dist\/v2\/index\.js|scripts\/run-tsx\.cjs|src\/index\.ts)/.test(cmd)) {
      console.error('An account runtime is already running; stop it before installation');
      process.exit(1);
    }
  } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;}
}
NODE

unit=/etc/systemd/system/mibot.service
[[ ! -L "$unit" ]] || { echo "Refusing a symlink service unit" >&2; exit 1; }
/usr/bin/systemd-analyze verify deploy/systemd/mibot.service
backup=$(mktemp -d /root/mibot-install.XXXXXX)
printf 'Backup: %s\n' "$backup"
for entry in dist/v2 dist/v2-plugins-active; do
  [[ ! -L "$entry" ]] || { echo "Refusing symlink artifact: $entry" >&2; exit 1; }
  if [[ -d "$entry" ]]; then cp -a "$entry" "$backup/$(basename "$entry")"; fi
done
if [[ -f "$unit" ]]; then cp -p "$unit" "$backup/service.before"; fi
data=(config.json)
if [[ -d assets ]]; then data+=(assets); fi
if [[ -f .env ]]; then data+=(.env); fi
tar -cf "$backup/account.tar" "${data[@]}"
changed=false
restore() {
  result=$?
  trap - EXIT
  if [[ $result != 0 && "$changed" == true ]]; then
    echo "Installation failed; restoring program and service definition" >&2
    /usr/bin/systemctl disable --now mibot || true
    for name in v2 v2-plugins-active; do
      if [[ -e "dist/$name" ]]; then mv "dist/$name" "$backup/failed-$name"; fi
      if [[ -d "$backup/$name" ]]; then cp -a "$backup/$name" "dist/$name"; fi
    done
    if [[ -f "$backup/service.before" ]]; then cp -p "$backup/service.before" "$unit"; else rm -f "$unit"; fi
    /usr/bin/systemctl daemon-reload
    echo "Account data retained. Service left stopped. Backup: $backup" >&2
  fi
  exit "$result"
}
trap restore EXIT
changed=true
printf '%s\n' 'Building MiBot and plugins...'
/usr/bin/node scripts/package-v2-daily.cjs > "$backup/build.log" 2>&1
/usr/bin/node dist/v2/index.js --check > "$backup/check.log" 2>&1
install -m 644 deploy/systemd/mibot.service "$unit"
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl reset-failed mibot || true
/usr/bin/systemctl enable --now mibot
invocation=$(/usr/bin/systemctl show mibot -p InvocationID --value)
[[ "$invocation" =~ ^[0-9a-f]{32}$ ]]
ready=false
for ((attempt=0; attempt<30; attempt++)); do
  /usr/bin/journalctl "_SYSTEMD_INVOCATION_ID=$invocation" -o cat --no-pager > "$backup/startup.log"
  if grep -q '"event":"runtime.ready"' "$backup/startup.log"; then ready=true; break; fi
  /usr/bin/systemctl is-active --quiet mibot || break
  sleep 2
done
[[ "$ready" == true ]] || { echo "Startup not ready; inspect $backup/startup.log" >&2; exit 1; }
sleep 5
/usr/bin/systemctl is-active --quiet mibot
[[ $(/usr/bin/systemctl show mibot -p InvocationID --value) == "$invocation" ]]
changed=false
printf '%s\n' 'MiBot is ready and enabled at boot.' \
  'Verify .help and .ping in Telegram.' \
  'Logs: journalctl -u mibot -f'
