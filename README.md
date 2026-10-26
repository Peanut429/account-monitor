# changan-monitor

6 个平台（X / YouTube / Instagram / Facebook / LinkedIn / TikTok）账号的主页监控。默认从参考库同步欧洲账号；监控本身不按账号类型过滤，`active = true` 的账号都会抓。

- 每个监控周期抓一次。
- 每次抓取窗口 = 执行时刻往前 72 小时，即 `[now-72h, now)`。
- 窗口内每篇帖子写一条指标快照；同一帖子跨周期会有多条记录。
- 数据写入独立数据库 `changan_monitor`，不碰参考项目的 `changan_social_data`。

## 快速命令

```bash
pnpm install
pnpm run db:init            # 建库 + 建表
pnpm run db:sync-accounts   # 从参考库同步 account_type=欧洲 的账号
pnpm run login --platform all   # 只有 Facebook / LinkedIn 需要登录
pnpm run monitor            # 跑一轮全部账号
pnpm run monitor --platform x --limit 1
```

## Web 页面

```bash
cd web
pnpm install
pnpm dev
# 打开 http://127.0.0.1:3000/account-monitor/
```

或者在项目根目录：

```bash
pnpm run web:dev
```

数据源：X / YouTube / Instagram / TikTok 走 TikHub API；Facebook / LinkedIn 走浏览器。

Windows 上用 `scripts/run-monitor.bat` + 任务计划程序；`deploy/com.changan.monitor.plist` 只适用于 macOS。

**Windows 启动 / 关闭定时任务：见 [doc/windows-task.md](doc/windows-task.md)。**

页面结构：账号列表 → 账号详情（帖子列表）→ 帖子详情（全部抓取记录 + 图表）。

生产部署（Linux + Nginx + 独立产物，不需要在服务器装依赖）：见 [doc/web-deploy.md](doc/web-deploy.md)。
账号管理页可以启用/停用账号、添加新账号。

## 文档

- [运行手册](doc/runbook.md)
- [Web 部署手册（Linux + Nginx + /account-monitor）](doc/web-deploy.md)
