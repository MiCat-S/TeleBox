# Mi Box

Telegram UserBot，基于 Node.js 24、TypeScript 和 Teleproto。
V2 预编译后由 Node 直接运行，生产服务使用 systemd。

## 安装

请按 [安装指南](INSTALL.md) 完成双仓库检出、依赖安装、插件打包、
首次登录和服务配置。当前 V2 分支为 `codex/telebox-runtime-v2`；
克隆时必须显式指定分支，默认分支目前不是 V2。

```sh
npm ci
npm run package:v2
npm run check:v2
npm run login
npm start
```

在核心仓库执行；插件仓库须按安装指南放在同级目录。
`npm start` 用于前台验证，长期运行使用 systemd。

## 功能

默认插件：ai、da、dc、dme、gt、ids、ip、nodeseek、rate、sum、
yvlu、aban、dig、pangu、subinfo。

常用命令：`.help`、`.ai`、`.gt`、`.memory`、`.sysinfo`、`.restart`。
参数以 `.help 命令` 为准。旧版插件仍在迁移，不能把任意旧版 `.ts`
直接作为 V2 插件安装。subinfo 文件导出等功能尚未迁移。

## 开发

- SDK：`src/v2/sdk.ts`
- 核心入口：`src/v2/index.ts`
- 插件入口：插件目录内的 `v2.ts`
- 打包：`npm run package:v2`
- 测试：`npm run test:v2`，需要 Node 24 和同级插件仓库
- 离线检查：`npm run check:v2`，不会登录 Telegram

`config.json`、`.env`、`assets/` 含账号和插件数据，不得公开上传。
服务管理见 [运维说明](deploy/systemd/README.md)，许可证见 [LICENSE](LICENSE)。
