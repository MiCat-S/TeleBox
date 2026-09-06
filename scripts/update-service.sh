#!/bin/bash
set -euo pipefail
umask 077

root=${1:-/root/mibot}
[[ -d "$root/.git" ]] || exit 2

result_file="$root/temp/update-result.json"
status="failed"
reason="更新服务异常退出"
mkdir -p "$root/temp"

if ! mkdir -p /run/lock; then
  reason="无法创建 /run/lock，可能缺少 systemd 服务权限"
  /usr/bin/node -e '
const fs = require("fs");
const [status, reason, target] = process.argv.slice(1);
fs.writeFileSync(target, JSON.stringify({status, reason}), "utf8");
fs.chmodSync(target, 0o600);
' "$status" "$reason" "$result_file"
  exit 1
fi

write_result() {
  /usr/bin/node -e '
const fs = require("fs");
const [status, reason, target] = process.argv.slice(1);
fs.writeFileSync(target, JSON.stringify({status, reason}), "utf8");
' "$1" "$2" "$result_file"
  chmod 600 "$result_file"
}

run_step() {
  local step="$1"
  shift
  local output
  if ! output=$("$@" 2>&1); then
    local code=$?
    status="failed"
    reason="${step}失败（退出码 ${code}）：${output}"
    write_result "$status" "$reason"
    exit "$code"
  fi
}

trap 'if [[ "$status" != "success" ]]; then
  write_result "$status" "$reason"
fi' EXIT

exec 9>/run/lock/mibot-update.lock
if ! /usr/bin/flock -n 9; then
  status="failed"
  reason="已有更新任务正在执行，请等待其结束后重试"
  exit 3
fi

cd "$root"

before=$(/usr/bin/git rev-parse HEAD)
run_step "拉取代码" /usr/bin/git pull --ff-only origin main
after=$(/usr/bin/git rev-parse HEAD)

if [[ "$before" != "$after" || ! -d node_modules ]]; then
  run_step "安装依赖" /usr/bin/npm ci
fi

run_step "构建主程序" /usr/bin/npm run build:v2
run_step "打包插件与运行时" /usr/bin/npm run package:v2
run_step "运行运行时自检" /usr/bin/npm run check:v2
run_step "重启主服务" /usr/bin/systemctl restart mibot.service

status="success"
reason=""
write_result "success" ""
