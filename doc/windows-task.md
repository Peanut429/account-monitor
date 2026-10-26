# Windows 定时任务手册

这个文档只解决一件事：**在 Windows 上启动 / 停止 / 查看每小时监控任务**。
以后忘了命令，直接看这一页。

- 任务名：`ChanganMonitor`
- 启动脚本：`scripts\run-monitor.bat`
- 默认频率：每小时一次，从 `00:05` 开始
- 日志：`logs\monitor.log`
- macOS 的 `deploy\com.changan.monitor.plist` 在 Windows 上**不能用**，也不需要。

---

## 1. 一次性准备

先确认这几件事都做过了，再做定时任务。

### 1.1 装环境

- Node.js 24（要支持 `--experimental-strip-types`）
- pnpm
- Google Chrome

在 cmd 里检查：

```bat
node -v
pnpm -v
```

`node -v` 应该是 `v24.x`。

### 1.2 装依赖

```bat
cd /d C:\path\to\changan-monitor
pnpm install
```

如果也要跑 Web 页面：

```bat
cd web
pnpm install
cd ..
```

### 1.3 配 `.env`

从 `.env.example` 复制一份 `.env`，至少确认：

```dotenv
DATABASE_URL=postgres://用户:密码@主机:5432/changan_monitor
SOURCE_DB_NAME=changan_social_data
TIKHUB_API_KEY=你的_key
MONITOR_CHROME_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe
MONITOR_USER_DATA_DIR=work/playwright-profile
MONITOR_HEADLESS=0
```

`MONITOR_CHROME_EXECUTABLE` 必须是 Windows 的 Chrome 路径。
X / YouTube / Instagram / TikTok 走 TikHub，不需要 Chrome；只有 Facebook / LinkedIn 会打开浏览器。

### 1.4 初始化数据库

```bat
cd /d C:\path\to\changan-monitor
pnpm run db:init
pnpm run db:sync-accounts
```

### 1.5 登录 Facebook / LinkedIn

必须在**运行定时任务的同一个 Windows 用户**下登录：

```bat
cd /d C:\path\to\changan-monitor
pnpm run login --platform all
```

会依次打开 Facebook、LinkedIn，登录完在终端按 Enter。
登录态保存在 `work\playwright-profile`。

### 1.6 手动跑一轮确认

```bat
cd /d C:\path\to\changan-monitor
pnpm run monitor
```

或者直接运行批量脚本：

```bat
scripts\run-monitor.bat
```

想直接看输出、跑完不立刻关窗口，用：

```bat
scripts\run-monitor-debug.bat
```

确认 `logs\monitor.log` 里有结果，再注册定时任务。

---

## 2. 注册每小时任务

**在项目根目录**打开 cmd 或 PowerShell，执行：

```bat
schtasks /Create /TN "ChanganMonitor" /TR "C:\account-monitor\scripts\run-monitor.bat" /SC HOURLY /MO 1 /ST 00:05 /RL LIMITED /IT /F
```

说明：

| 参数 | 作用 |
|---|---|
| `/TN "ChanganMonitor"` | 任务名 |
| `/TR "C:\account-monitor\scripts\run-monitor.bat"` | 要执行的脚本，写完整路径 |
| `/SC HOURLY /MO 1` | 每小时一次 |
| `/ST 00:05` | 从 00:05 开始（可改） |
| `/RL LIMITED` | 普通权限运行 |
| `/IT` | 只在当前用户登录时运行；Facebook / LinkedIn 需要可见浏览器，必须保留 |
| `/F` | 同名任务已存在时直接覆盖 |

> 如果你在 **PowerShell** 里执行，不要用 `%CD%`：PowerShell 不会展开它，任务里会变成字面量 `%CD%\scripts\run-monitor.bat`，到点执行会失败（Last Result = 1）。PowerShell 里请直接写完整路径，或者用 `$PWD` 拼接。
>
> 如果项目路径里有 `&` 等特殊字符，建议把项目放到简单路径，例如 `C:\changan-monitor`。

---

## 3. 立即跑一次

不用等到下一个整点：

```bat
schtasks /Run /TN "ChanganMonitor"
```

---

## 4. 查看任务状态

```bat
schtasks /Query /TN "ChanganMonitor" /V /FO LIST
```

重点看：

- `Status`：Ready / Running / Disabled
- `Last Run Time`：上次运行时间
- `Last Result`：`0` 表示成功，非 0 表示失败
- `Next Run Time`：下次运行时间

也可以打开图形界面：

```bat
taskschd.msc
```

左侧进入 **Task Scheduler Library**，找到 `ChanganMonitor`：

- 右键 **Run**：立即运行
- 右键 **End**：结束正在运行的那一次
- 右键 **Disable / Enable**：暂停 / 恢复定时
- 右键 **Delete**：删除任务

---

## 5. 关闭 / 暂停 / 恢复 / 删除

### 5.1 暂停定时（保留任务）

```bat
schtasks /Change /TN "ChanganMonitor" /DISABLE
```

### 5.2 恢复定时

```bat
schtasks /Change /TN "ChanganMonitor" /ENABLE
```

### 5.3 结束正在运行的那一次

```bat
schtasks /End /TN "ChanganMonitor"
```

注意：`/End` 只是让任务计划程序结束它启动的进程；Playwright 启动的 Chrome 如果没被关掉，可能还会残留，必要时在任务管理器里结束 Chrome。

### 5.4 彻底删除任务

```bat
schtasks /Delete /TN "ChanganMonitor" /F
```

删除任务不会删除数据库、日志和浏览器 profile。

---

## 6. 改执行时间

最稳的方式是删除后重建。例如改成每小时的第 15 分钟：

```bat
schtasks /Delete /TN "ChanganMonitor" /F
schtasks /Create /TN "ChanganMonitor" /TR "C:\account-monitor\scripts\run-monitor.bat" /SC HOURLY /MO 1 /ST 00:15 /RL LIMITED /IT /F
```

也可以在 `taskschd.msc` 里：

1. 右键任务 → **Properties**
2. **Triggers** → 编辑
3. 改开始时间
4. 确定

---

## 7. 看日志

### 7.1 监控日志

```bat
type logs\monitor.log
```

只看最后 100 行：

```powershell
Get-Content .\logs\monitor.log -Tail 100 -Encoding UTF8
```

持续跟踪：

```powershell
Get-Content .\logs\monitor.log -Tail 50 -Wait -Encoding UTF8
```

### 7.2 任务计划程序自己的结果

```bat
schtasks /Query /TN "ChanganMonitor" /V /FO LIST
```

或者 `taskschd.msc` 里看 **Last Run Result**。

Windows 上没有 macOS 的 `launchd.out.log` / `launchd.err.log`；监控的输出都进 `logs\monitor.log`。

---

## 8. 常见问题

### 8.1 任务跑到一半失败，日志里 `pnpm not found`

任务计划程序的 PATH 可能比你的终端少。两种改法：

**改 `scripts\run-monitor.bat`，把 pnpm 所在目录加进去：**

```bat
set "PATH=C:\Users\你的用户名\AppData\Roaming\npm;C:\Program Files\nodejs;%PATH%"
```

**或者直接把 `call pnpm` 改成完整路径：**

```bat
call "C:\Users\你的用户名\AppData\Roaming\npm\pnpm.cmd" run monitor >> logs\monitor.log 2>&1
```

先用 `where pnpm` 确认 pnpm 到底在哪。

### 8.2 浏览器没打开 / Facebook、LinkedIn 失败

- 任务必须用 `/IT` 创建，或者 GUI 里选 **Run only when user is logged on**。
- 不要选“不管用户是否登录都要运行”，那种方式在后台会话里，Playwright 打不开可见浏览器。
- 确认 `.env` 的 `MONITOR_CHROME_EXECUTABLE` 是 Windows Chrome 路径。
- 确认登录是在同一个 Windows 用户下做的：`pnpm run login --platform all`。

### 8.3 `Last Result` 是 `1`

表示脚本退出码非 0。看日志：

```powershell
Get-Content .\logs\monitor.log -Tail 200 -Encoding UTF8
```

常见原因：

- Facebook / LinkedIn 登录失效 → 重新 `pnpm run login --platform all`
- TikHub key 失效 / 额度不足 → 看日志里的 401/402/429
- 数据库连不上 → 检查 `.env` 的 `DATABASE_URL`
- Chrome 路径不对 → 检查 `MONITOR_CHROME_EXECUTABLE`

### 8.4 任务没有按小时跑

- `taskschd.msc` → 任务 → **Conditions**，取消勾选 **Start the task only if the computer is on AC power**（笔记本电池模式下默认可能不跑）。
- Windows 休眠/睡眠会漏跑；要严格每小时，关闭休眠或放服务器。
- 看 **Triggers** 里开始时间是不是未来时间；可以点 **Run** 先手动触发。

### 8.5 同时跑了两个监控

监控进程内部有 PostgreSQL advisory lock：上一轮没结束时，下一轮会跳过并记录。
但为了避免两个 Chrome 抢同一个 profile，尽量不要手动跑的同时让定时任务也跑。

### 8.6 想确认当前用的是哪个 Node

```bat
where node
node -v
```

任务计划程序里用的也是这个用户环境；如果用了 nvm-windows，切换版本后最好重新登录一次，确保任务拿到新 PATH。

---

## 9. 只手动跑，不注册定时

### 9.1 双击 bat 会怎样

**双击 `scripts\run-monitor.bat`：**

- 会打开一个黑色 cmd 窗口；
- 窗口里基本看不到输出，因为脚本把 stdout/stderr 都重定向到了 `logs\monitor.log`；
- 它会跑**完整一轮** 41 个账号（不是只跑一个平台）；
- Facebook / LinkedIn 会打开 Chrome 窗口，这是正常的；
- 跑完窗口会自动关闭；
- 如果中途报错，窗口也会很快关闭，需要去 `logs\monitor.log` 看原因；
- 它只是一次性手动执行，不会注册/修改定时任务；
- 如果此时定时任务也正好在跑，监控内部的 PostgreSQL 锁会让其中一轮跳过，不会同时跑两轮。

**双击 `scripts\run-monitor-debug.bat`：**

- 输出直接显示在窗口里，不写入 `logs\monitor.log`；
- 跑完会停住并显示 `Exit code`，按任意键才关闭；
- 适合第一次配置、排查登录/接口问题时用。

> 不要把 `run-monitor-debug.bat` 配到任务计划程序里：它最后有 `pause`，定时任务会一直卡在等待按键。

如果只是临时看一次：

```bat
cd /d C:\path\to\changan-monitor
pnpm run monitor
```

只跑某个平台：

```bat
pnpm run monitor --platform x
pnpm run monitor --platform x,youtube,instagram,tiktok
pnpm run monitor --platform facebook --limit 1
```

只跑某个账号：

```bat
pnpm run monitor --platform youtube --account "BYD Europe"
```

---

## 10. Web 页面（不属于定时任务）

Web 是常驻进程，和每小时监控分开：

```bat
cd /d C:\path\to\changan-monitor
pnpm run web:dev
```

打开 <http://127.0.0.1:3000/account-monitor/>。

如果想让 Web 开机常驻，可以再用任务计划程序或 NSSM 托管 `pnpm run web:dev`；这不影响监控任务。

---

## 11. 最短命令卡

```bat
:: 进入项目
cd /d C:\path\to\changan-monitor

:: 注册每小时任务（00:05 开始）
schtasks /Create /TN "ChanganMonitor" /TR "C:\account-monitor\scripts\run-monitor.bat" /SC HOURLY /MO 1 /ST 00:05 /RL LIMITED /IT /F

:: 立即跑一次
schtasks /Run /TN "ChanganMonitor"

:: 查看状态
schtasks /Query /TN "ChanganMonitor" /V /FO LIST

:: 暂停 / 恢复
schtasks /Change /TN "ChanganMonitor" /DISABLE
schtasks /Change /TN "ChanganMonitor" /ENABLE

:: 结束当前运行
schtasks /End /TN "ChanganMonitor"

:: 彻底删除
schtasks /Delete /TN "ChanganMonitor" /F

:: 看日志
type logs\monitor.log

:: 手动跑
pnpm run monitor
```

图形界面：`taskschd.msc` → Task Scheduler Library → `ChanganMonitor`。
