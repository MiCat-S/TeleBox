#!/bin/bash
# Run only as a systemd oneshot with ExecStopPost restoring the original PM2 app.
set -euo pipefail
umask 077
export PM2_HOME=/root/.pm2
export PATH=/usr/bin:/bin
root=${1:?Private validation directory required}
case "$root" in /root/telebox-v2-validation/*) ;; *) exit 2 ;; esac
[[ -n ${INVOCATION_ID:-} && -d "$root/candidate" && ! -e "$root/backup.tar" ]]
cd "$root"
[[ -d /root/telebox/node_modules ]]
if [[ -L candidate/node_modules ]]; then
  [[ $(readlink candidate/node_modules) == /root/telebox/node_modules ]]
else
  [[ ! -e candidate/node_modules ]]
  ln -s /root/telebox/node_modules candidate/node_modules
fi
/usr/bin/node candidate/scripts/server-v2-check.cjs --preflight "$root"
/usr/bin/node candidate/scripts/server-v2-check.cjs --capture "$root"
/usr/bin/pm2 stop telebox > stop.private.log 2>&1
/usr/bin/node candidate/scripts/server-v2-check.cjs --guard "$root"
date --iso-8601=seconds > stopped-at.txt
find /root/telebox -print0 | LC_ALL=C sort -z > paths-before.private.bin
tar -cf backup.tar -C /root telebox
tar -df backup.tar -C /root > backup-verify.private.log 2>&1
sha256sum backup.tar > backup.sha256
mkdir -m 700 work
cp -p /root/telebox/config.json work/config.json
if [[ -f /root/telebox/.env ]]; then cp -p /root/telebox/.env work/.env; fi
cp -a /root/telebox/assets work/assets
chmod 600 work/config.json
if [[ -f work/.env ]]; then chmod 600 work/.env; fi
printf '%s\n' '{"stage":"consistent-backup","result":"ok"}'
cd work
set +e
timeout --signal=TERM --kill-after=5s 360s /usr/bin/node "$root/candidate/scripts/server-v2-check.cjs" --execute "$root" > "$root/live.private.log" 2>&1
result=$?
set -e
printf '%s\n' "$result" > "$root/live-exit-code.txt"
# Check the entire original tree before PM2 resumes writing to it.
tar -df "$root/backup.tar" -C /root > "$root/production-compare.private.log" 2>&1
find /root/telebox -print0 | LC_ALL=C sort -z > "$root/paths-after.private.bin"
cmp "$root/paths-before.private.bin" "$root/paths-after.private.bin"
printf '%s\n' '{"stage":"production-tree-unchanged","result":"ok"}'
date --iso-8601=seconds > "$root/test-ended-at.txt"
exit "$result"
