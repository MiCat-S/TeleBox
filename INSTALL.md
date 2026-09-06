# MiBot V2 安装

## 环境

在线服务目前支持 Linux。以下命令面向 Debian/Ubuntu 的 root 终端。
先安装 Node.js 24 和 npm，确认 `/usr/bin/node --version` 为 `v24.x`。
不要复制其他机器的 node_modules，原生依赖需要匹配当前平台。

```sh
apt-get update
apt-get install -y git build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev bind9-dnsutils util-linux
```

## 获取与构建

两个仓库都使用 `main` 分支。插件目录名保留 `mibot-plugins`，
这是打包工具默认使用的同级路径。已有目录不得直接覆盖。

```sh
git clone --branch main https://github.com/MiCat-S/Mi-Box.git /root/mibot
git clone --branch main https://github.com/MiCat-S/Mi-Box-Plugins.git /root/mibot-plugins
cd /root/mibot
npm ci
npm run package:v2
npm run check:v2
```

离线检查通过不代表 Telegram 登录或全部插件外部接口已验证。
打包只包含默认模块所需的 `ai`、`gt`，其他扩展在 TG 通过
`.tpm search` 和 `.tpm install 插件名` 安装，不随安装器自动启用。

## 登录与前台验证

准备自己申请的 Telegram `api_id` 和 `api_hash`：

```sh
cd /root/mibot
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

完成登录后，可用一条命令完成构建、离线检查、备份、安装服务、
开机自启和启动就绪检查：

```sh
cd /root/mibot
npm run service:install
```

运行前须停止同账号的其他实例（包括其他机器上的实例）。此脚本用于
首次安装，发现本机账号进程、已启用的服务或安装并发时会拒绝执行。
不会重新登录或覆盖 config.json。失败时恢复程序和服务定义并停服，
保留账号数据；备份路径会在终端打印。成功后仍需在 TG 验证 `.help`
和 `.ping`。已有服务升级请使用运维说明，不要重复运行安装器。

### 手动安装

模板使用 `/root/mibot` 和 `/usr/bin/node`，以 root 运行。
插件和 `.exec` 将拥有该账户权限，只安装可信代码。非 root 部署需要
另行调整目录、所有权及 `.restart` 的服务管理授权，不能直接套用。

```sh
cd /root/mibot
systemd-analyze verify deploy/systemd/mibot.service
install -m 644 deploy/systemd/mibot.service /etc/systemd/system/mibot.service
systemctl daemon-reload
systemctl enable --now mibot
systemctl status mibot --no-pager
journalctl -u mibot -n 50 --no-pager
```

服务名为 `mibot`，与 `.restart` 一致；直接执行 Node。
升级、备份、回滚见 [运维说明](deploy/systemd/README.md)。

已有 `/root/telebox` 和 `telebox-v2.service` 的部署不能直接套用新路径：
先备份并停止旧服务，再迁移目录、插件及账号数据，安装 `mibot.service`。
确认新服务正常后禁用旧服务，禁止两个实例同时运行。GitHub 仓库地址
不受本地目录名影响，继续使用上面的 Mi-Box 和 Mi-Box-Plugins 地址。
