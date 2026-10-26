# Web 部署手册（Linux + Nginx + /account-monitor）

这份文档说明怎么把 `web/` 部署到 Linux 服务器。

- 构建产物是 standalone 的：服务器只需要 **Node.js 24**，不需要 pnpm、不需要 `node_modules`、不需要源码。
- 部署时**不保留 `.output` 这一层**：把 `.output` 里面的 `server/`、`public/`、`nitro.json` 直接放到站点目录。
- `.env` 就放在站点目录，Node 用 `--env-file=.env` 加载；**PM2 配置里不需要写 env**。
- 页面、静态资源、server function 全部在 `/account-monitor` 前缀下。

## 1. 构建（在开发机 / CI 上）

```bash
cd web
pnpm install
pnpm build
```

生成的是本地构建目录：

```text
web/.output/
├── server/index.mjs
├── public/
└── nitro.json
```

大约 1.7 MB，没有 `node_modules`。

## 2. 服务器目录

把 `.output` 里面的内容平铺到站点目录，最终是：

```text
/opt/changan-monitor/web/
├── server/
│   └── index.mjs
├── public/
├── nitro.json
├── ecosystem.config.cjs     # 用 PM2 时需要
└── .env
```

不是：

```text
/opt/changan-monitor/web/.output/server/index.mjs   # 不需要这一层
```

两种复制方式任选。

### 2.1 tar（推荐，平铺）

```bash
# 开发机
tar -czf web-build.tgz -C web/.output .
scp web-build.tgz web/ecosystem.config.cjs user@server:/opt/changan-monitor/web/

# 服务器
cd /opt/changan-monitor/web
tar -xzf web-build.tgz
```

### 2.2 rsync（按目录同步）

```bash
rsync -av --delete web/.output/server/ user@server:/opt/changan-monitor/web/server/
rsync -av --delete web/.output/public/ user@server:/opt/changan-monitor/web/public/
scp web/.output/nitro.json web/ecosystem.config.cjs user@server:/opt/changan-monitor/web/
```

`--delete` 只作用于 `server/`、`public/`，不会动 `.env`、`ecosystem.config.cjs`。

## 3. `.env`

`/opt/changan-monitor/web/.env`：

```dotenv
DATABASE_URL=postgres://用户:密码@主机:5432/changan_monitor
PUBLIC_ORIGIN=https://your-domain.com

# 建议写；Nginx 默认代理 3001
PORT=3001
HOST=127.0.0.1
NODE_ENV=production
```

说明：

- `DATABASE_URL`：Web 读数据库；账号管理会写 `accounts`。
- `PUBLIC_ORIGIN`：浏览器实际访问的 scheme + host，不能带 `/account-monitor` 路径。
  多个地址用英文逗号分隔，例如 `https://your-domain.com,http://1.2.3.4`。
- `PORT` / `HOST`：建议写 `3001` / `127.0.0.1`，和 Nginx upstream 保持一致。
- `NODE_ENV=production` 建议写上。
- `TIKHUB_API_KEY`、`MONITOR_*` 是爬虫用的，Web 不需要；如果在同一份 `.env` 里，放着也没关系。

Nitro 的入口就是 `server/index.mjs`，不需要额外的 `start.mjs`。
启动时用 Node 的 `--env-file` 参数把 `.env` 读进 `process.env`：

```bash
cd /opt/changan-monitor/web
node --env-file=.env server/index.mjs
```

这样 `PUBLIC_ORIGIN`、`DATABASE_URL` 在应用模块加载前就已经在 `process.env` 里。
PM2 配置里不需要写 `env`。

## 4. PM2（推荐）

配置在 [`web/ecosystem.config.cjs`](../web/ecosystem.config.cjs)，核心只有：

```js
{
  name: "changan-monitor-web",
  cwd: __dirname,
  script: path.join(__dirname, "server/index.mjs"),
  node_args: "--env-file=.env",
  interpreter: "node",
  instances: 1,
  exec_mode: "fork",
  watch: false
}
```

没有 `env` 块，环境变量由 Node 的 `--env-file=.env` 从 `.env` 加载。

启动：

```bash
cd /opt/changan-monitor/web
pm2 start ecosystem.config.cjs
pm2 save
```

开机自启（只执行一次，按输出命令执行）：

```bash
pm2 startup
```

查看：

```bash
pm2 status
pm2 logs changan-monitor-web --lines 100
pm2 describe changan-monitor-web
```

更新：

```bash
# 只更新了构建产物
pm2 restart changan-monitor-web

# 改了 .env：restart 会重新执行 Node，重新读 .env
pm2 restart changan-monitor-web

# 改了 ecosystem.config.cjs
pm2 restart ecosystem.config.cjs
pm2 save
```

停止 / 删除：

```bash
pm2 stop changan-monitor-web
pm2 delete changan-monitor-web
```

注意：

- 不要开 `cluster`，保持 `instances: 1` / `fork`。
- 不要开 `watch`。
- PM2 和 systemd 二选一，不要同时占 3001。
- 升级 Node 后建议 `pm2 update`，避免 PM2 还指向旧 Node。
- 日志默认在 `~/.pm2/logs/changan-monitor-web-*.log`。

## 5. systemd（可选，和 PM2 二选一）

unit 文件：[`deploy/changan-monitor-web.service`](../deploy/changan-monitor-web.service)。

```ini
[Service]
WorkingDirectory=/opt/changan-monitor/web
ExecStart=/usr/bin/node --env-file=.env server/index.mjs
```

`--env-file=.env` 自己加载 `.env`，所以 unit 里不需要 `EnvironmentFile`；`PORT`/`HOST` 写在 `.env` 里（建议 `3001` / `127.0.0.1`）。

```bash
sudo cp deploy/changan-monitor-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now changan-monitor-web
sudo systemctl status changan-monitor-web
sudo journalctl -u changan-monitor-web -f
```

## 6. Nginx

配置：[`deploy/nginx-account-monitor.conf`](../deploy/nginx-account-monitor.conf)。

```nginx
upstream changan_monitor_web {
    server 127.0.0.1:3001;
    keepalive 32;
}

location = /account-monitor {
    return 301 /account-monitor/;
}

location /account-monitor/ {
    proxy_pass http://changan_monitor_web;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**关键：`proxy_pass` 后面不要带 URI。**
不要写成 `proxy_pass http://127.0.0.1:3001/;`，那会把 `/account-monitor/` 前缀剥掉。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

路径：

```text
https://your-domain.com/account-monitor/                  页面
https://your-domain.com/account-monitor/manage/accounts   账号管理
https://your-domain.com/account-monitor/_serverFn/...     server function
https://your-domain.com/account-monitor/assets/...        静态资源
```

## 7. 验证

```bash
# 本机
curl -I http://127.0.0.1:3001/account-monitor/

# 经过 Nginx
curl -I https://your-domain.com/account-monitor/
```

浏览器再确认：

1. 账号总览、账号管理能打开；
2. 点一次“停用/启用”或“添加账号”，POST 成功（不是 403）；
3. 静态资源全是 200，不是 404。

POST 403 时检查 `.env` 的 `PUBLIC_ORIGIN`，它必须等于浏览器地址栏的 scheme + host，不能带路径。
改完 `.env` 后重启：

- PM2：`pm2 restart changan-monitor-web`
- systemd：`sudo systemctl restart changan-monitor-web`

## 8. 更新版本

```bash
# 开发机
cd web
pnpm build

# 服务器：只替换 server/ 和 public/，保留 .env、ecosystem.config.cjs
rsync -av --delete web/.output/server/ user@server:/opt/changan-monitor/web/server/
rsync -av --delete web/.output/public/ user@server:/opt/changan-monitor/web/public/
scp web/.output/nitro.json user@server:/opt/changan-monitor/web/
```

然后：

```bash
pm2 restart changan-monitor-web
# 或
sudo systemctl restart changan-monitor-web
```

回滚保留上一份 `server/`、`public/` 即可。

## 9. 常见问题

### 502 Bad Gateway

- PM2：`pm2 status`、`pm2 logs changan-monitor-web`
- systemd：`systemctl status changan-monitor-web`、`journalctl -u ...`
- `curl http://127.0.0.1:3001/account-monitor/` 是否 200
- Nginx upstream 端口是否一致

### 启动报找不到 `server/index.mjs`

说明部署目录不对。正确结构是：

```text
/opt/changan-monitor/web/server/index.mjs
/opt/changan-monitor/web/.env
```

不是 `web/.output/server/index.mjs`。
如果你保留了 `.output` 目录，也可以直接运行 `node --env-file=.env .output/server/index.mjs`，
但推荐上面的平铺结构。

### 页面 404 / 静态资源 404

- Nginx `proxy_pass` 是否多写了结尾 `/`，导致前缀被剥掉；
- 访问地址是否带 `/account-monitor/`；
- `public/` 是否复制到了站点目录。

### 点“停用/添加”报 403

- `.env` 的 `PUBLIC_ORIGIN` 不对或没有；
- 用浏览器开发者工具看请求头 `Origin`，把 scheme + host 填进去；
- 改完重启进程。

### 500 / 数据库连接失败

- `.env` 的 `DATABASE_URL` 是否正确；
- 服务器到数据库的网络/白名单；
- PM2 日志或 `journalctl` 看具体报错。

### `node: command not found`

- systemd 的 PATH 很短，`ExecStart` 写 Node 绝对路径；
- `--env-file` 需要 Node 20.6+；服务器必须 Node 24；
- PM2 用的是 PM2 自己的 Node，`pm2 describe changan-monitor-web` 看 interpreter，必要时 `pm2 update`。

### 服务器需要装什么

只需要：

- Node.js 24
- PM2 或 systemd
- Nginx

不需要 pnpm、不需要 `node_modules`、不需要源码。
