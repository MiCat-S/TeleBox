# Mi Box V2 安装

## 环境

在线服务目前支持 Linux。以下命令面向 Debian/Ubuntu 的 root 终端。
先安装 Node.js 24 和 npm，确认 `/usr/bin/node --version` 为 `v24.x`。
不要复制其他机器的 node_modules，原生依赖需要匹配当前平台。

```sh
apt-get update
apt-get install -y git build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev bind9-dnsutils util-linux
```

## 获取与构建

两个仓库都显式选择 V2 分支。插件目录名保留 `TeleBox-Plugins`，
这是打包工具默认使用的同级路径。已有目录不得直接覆盖。

```sh
git clone --branch codex/telebox-runtime-v2 https://github.com/MiCat-S/Mi-Box.git /root/telebox
git clone --branch codex/telebox-runtime-v2 https://github.com/MiCat-S/Mi-Box-Plugins.git /root/TeleBox-Plugins
cd /root/telebox
npm ci
npm run package:v2
npm run check:v2
```

离线检查通过不代表 Telegram 登录或全部插件外部接口已验证。

## 登录与前台验证

准备自己申请的 Telegram `api_id` 和 `api_hash`：

```sh
cd /root/telebox
umask 077
npm run login
```

输入 API 凭据、手机号、验证码及两步验证密码。成功后生成权限为
0600 的 `config.json`，已有文件不会被覆盖。此入口支持手机号登录，
目前不提供二维码登录和代理配置向导。

已有账号迁移须保留原 `config.json`、`.env` 和 `assets/`，无需重复登录。
先停掉同一账号的所有旧实例，再运行：

```sh
npm start
```

看到 `runtime.ready` 后，在 Telegram 验证 `.help`、`.ping`、`.memory`。
按 Ctrl+C 并等待完全退出，再启用 systemd。不能同时运行前台、PM2
和 systemd 中的同一账号。

## systemd

模板使用 `/root/telebox` 和 `/usr/bin/node`，以 root 运行。
插件和 `.exec` 将拥有该账户权限，只安装可信代码。非 root 部署需要
另行调整目录、所有权及 `.restart` 的服务管理授权，不能直接套用。

```sh
cd /root/telebox
systemd-analyze verify deploy/systemd/telebox-v2.service
install -m 644 deploy/systemd/telebox-v2.service /etc/systemd/system/telebox-v2.service
systemctl daemon-reload
systemctl enable --now telebox-v2
systemctl status telebox-v2 --no-pager
journalctl -u telebox-v2 -n 50 --no-pager
```

服务名保留 `telebox-v2`，与 `.restart` 一致；直接执行 Node，不需要 PM2。
升级、备份、回滚见 [运维说明](deploy/systemd/README.md)。
