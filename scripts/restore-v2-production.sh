#!/bin/bash
set -u
umask 077
export PM2_HOME=/root/.pm2
export PATH=/usr/bin:/bin

root=${1:?Private deployment directory required}
case "$root" in /root/telebox-v2-validation/*) ;; *) exit 2 ;; esac
[[ -e "$root/switch-complete" ]] && exit 0
production=/root/telebox
cd "$root" || exit 1

/usr/bin/pm2 delete telebox > rollback-delete.private.log 2>&1 || true
rm -rf "$production/dist/v2" "$production/dist/v2-plugins-active"
if [[ -e had-v2 && -e managed-before/v2 ]]; then mv managed-before/v2 "$production/dist/v2"; fi
if [[ -e had-v2-plugins-active && -e managed-before/v2-plugins-active ]]; then
  mv managed-before/v2-plugins-active "$production/dist/v2-plugins-active"
fi
/usr/bin/pm2 start "$production/ecosystem.config.cjs" --only telebox > rollback-start.private.log 2>&1
/usr/bin/pm2 save --force > rollback-save.private.log 2>&1 || true
date --iso-8601=seconds > rollback-complete
