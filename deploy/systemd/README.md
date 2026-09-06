# MiBot systemd 运维

初次安装见 [INSTALL.md](../../INSTALL.md)。
更新由独立的 `mibot-update.service` 临时任务执行，避免更新任务随着
主服务重启而被终止。查看更新结果：

```sh
systemctl status mibot-update --no-pager
journalctl -u mibot-update -n 100 --no-pager
```
模板对应 `/root/mibot`、`/usr/bin/node`（Node 24）、服务名 `mibot`。

```sh
systemctl status mibot --no-pager
systemctl restart mibot
systemctl stop mibot
journalctl -u mibot -f
```

日志由 journald 管理，按机器容量配置保留策略。卸载 PM2 前确认它没有
管理其他程序。同一账号不能并行运行两个实例。

## 升级

1. 确认两仓库的目标提交配套，记录原提交，不强制重置未提交改动。
2. 在独立候选目录安装依赖，执行 `npm run package:v2`、
   `npm run test:v2` 和 `npm run check:v2`。保留同级插件目录布局，
   不在运行中的 dist 下构建。
3. 停止服务并确认退出；备份旧程序、dist、package.json、锁文件、
   config.json、.env 和 assets。备份含账号密钥，限制访问权限，
   不上传到 GitHub。
4. 整体替换通过验证的 `dist/v2` 与 `dist/v2-plugins-active`；
   依赖有变化时安装匹配版本。保留生产配置、assets 和旧产物，
   不复制候选测试账号的数据。
5. 启动服务，检查 `runtime.ready`、进程稳定性、错误日志，
   并实测 Telegram 关键命令。仅 active 不代表登录就绪。

## 回滚

停止服务后恢复旧程序、插件和匹配依赖，保留升级后写入的数据。
涉及不兼容数据迁移时使用对应恢复步骤，不用旧快照直接覆盖生产数据。
启动后重复就绪和关键命令检查。
