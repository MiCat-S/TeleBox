#!/bin/bash
set -euo pipefail
umask 077
export PM2_HOME=/root/.pm2
export PATH=/usr/bin:/bin

root=${1:?Private deployment directory required}
case "$root" in /root/telebox-v2-validation/*) ;; *) exit 2 ;; esac
production=/root/telebox
candidate="$root/candidate"
[[ -n ${INVOCATION_ID:-} && -d "$candidate/dist/v2" && -d "$candidate/plugins" ]]
[[ -d "$production/node_modules" && -f "$production/ecosystem.config.cjs" ]]
[[ ! -e "$root/switch-complete" && ! -e "$root/deployment-backup.tar" ]]

if [[ -L "$candidate/node_modules" ]]; then
  [[ $(readlink "$candidate/node_modules") == "$production/node_modules" ]]
else
  [[ ! -e "$candidate/node_modules" ]]
  ln -s "$production/node_modules" "$candidate/node_modules"
fi

cd "$root"
/usr/bin/node candidate/scripts/server-v2-check.cjs --preflight "$root"
/usr/bin/pm2 jlist > pm2-deploy-before.private.json
/usr/bin/node - <<'NODE'
const entries = require(process.cwd() + '/pm2-deploy-before.private.json').filter(item => item.name === 'telebox');
if (entries.length !== 1 || entries[0].pm2_env.status !== 'online' ||
    entries[0].pm2_env.pm_cwd !== '/root/telebox' ||
    entries[0].pm2_env.pm_exec_path !== '/root/telebox/scripts/run-tsx.cjs') process.exit(1);
NODE

/usr/bin/node candidate/scripts/server-v2-check.cjs --capture "$root"
/usr/bin/pm2 stop telebox > pm2-stop.private.log 2>&1
/usr/bin/node candidate/scripts/server-v2-check.cjs --guard "$root"
tar -cf deployment-backup.tar -C /root telebox
tar -df deployment-backup.tar -C /root > deployment-backup-verify.private.log 2>&1
sha256sum deployment-backup.tar > deployment-backup.sha256
if [[ -f /root/.pm2/dump.pm2 ]]; then cp -p /root/.pm2/dump.pm2 pm2-dump-before.private.json; fi

mkdir -m 700 managed-before
if [[ -e "$production/dist/v2" ]]; then mv "$production/dist/v2" managed-before/v2; touch had-v2; fi
if [[ -e "$production/dist/v2-plugins-active" ]]; then
  mv "$production/dist/v2-plugins-active" managed-before/v2-plugins-active
  touch had-v2-plugins-active
fi
mkdir -p "$production/dist"
cp -a "$candidate/dist/v2" "$production/dist/v2"
mkdir -m 700 "$production/dist/v2-plugins-active"
for id in ai da dc dme gt ids ip nodeseek rate sum yvlu; do
  [[ -d "$candidate/plugins/$id" ]]
  cp -a "$candidate/plugins/$id" "$production/dist/v2-plugins-active/$id"
done

/usr/bin/pm2 delete telebox > pm2-delete.private.log 2>&1
/usr/bin/pm2 start "$production/dist/v2/index.js" --name telebox --cwd "$production" \
  --interpreter /usr/bin/node -- --serve > pm2-start-v2.private.log 2>&1

ready=false
for _ in $(seq 1 20); do
  sleep 2
  /usr/bin/pm2 jlist > pm2-v2.private.json
  if /usr/bin/node - <<'NODE'
const entries = require(process.cwd() + '/pm2-v2.private.json').filter(item => item.name === 'telebox');
if (entries.length !== 1 || entries[0].pm2_env.status !== 'online' || entries[0].pid <= 0 ||
    entries[0].pm2_env.pm_cwd !== '/root/telebox' ||
    entries[0].pm2_env.pm_exec_path !== '/root/telebox/dist/v2/index.js' ||
    !Array.isArray(entries[0].pm2_env.args) || entries[0].pm2_env.args.join(' ') !== '--serve') process.exit(1);
NODE
  then ready=true; break; fi
done
[[ "$ready" == true ]]
sleep 8
/usr/bin/pm2 jlist > pm2-v2-stable.private.json
/usr/bin/node - <<'NODE'
const entries = require(process.cwd() + '/pm2-v2-stable.private.json').filter(item => item.name === 'telebox');
if (entries.length !== 1 || entries[0].pm2_env.status !== 'online' || entries[0].pid <= 0 ||
    entries[0].pm2_env.restart_time !== 0) process.exit(1);
NODE
/usr/bin/pm2 save --force > pm2-save.private.log 2>&1
date --iso-8601=seconds > switch-complete
printf '%s\n' '{"stage":"production-switch","result":"ok"}'
