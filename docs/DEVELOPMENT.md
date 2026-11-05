# 张哥工作台 · 开发手册

面向二次开发者的完整说明：架构、数据契约、本地开发、测试、部署与扩展指南。
产品说明（功能/用法）见 [README.md](../README.md)，版本历史见 [CHANGELOG.md](../CHANGELOG.md)。

## 1. 项目结构

```
gongzuotai/
├── public/
│   └── index.html          # 前端单页（原生 JS，无框架、无构建步骤）
├── functions/
│   └── api/[[route]].js    # Cloudflare Pages Functions：全部 API（单文件 catch-all 路由）
├── wrangler.toml           # Pages 项目配置：项目名、D1 绑定、兼容日期
├── docs/
│   ├── DEVELOPMENT.md      # 本手册
│   └── screenshots/        # README 截图
└── .github/workflows/pages.yml  # GitHub Pages 前端镜像部署（public/ 为站点根）
```

| 文件 | 职责 |
|---|---|
| `public/index.html` | 登录门、统计卡、每日时间线、待办、14 天柱状图；`localStorage` 存口令与可选 API 地址 |
| `functions/api/[[route]].js` | 路由分发、口令鉴权、CORS、D1 读写（logs/todos/stats） |
| `wrangler.toml` | `pages_build_output_dir = "public"`；D1 绑定名 `DB` → 库 `gongzuotai-db` |

## 2. 技术栈与运行环境

| 层 | 技术 | 版本要求 |
|---|---|---|
| 前端 | 原生 HTML/CSS/JS（ES2020，fetch/localStorage） | 现代浏览器均可 |
| API | Cloudflare Pages Functions（Workers 运行时） | compatibility_date ≥ 2026-10-31 |
| 数据库 | Cloudflare D1（SQLite） | 免费版 10 库上限 |
| 部署工具 | wrangler CLI | ≥ 4.x；`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 环境变量 |

前端**零依赖、零构建**：改完 `public/index.html` 直接部署即可，无需 npm install。

## 3. 本地开发

```bash
# 本地整栈跑（D1 本地模拟 + Functions）
npm exec wrangler pages dev public --port 8790
# 浏览器打开 http://127.0.0.1:8790 （本地 D1 是空库，需先建表，见 §5）

# 只改前端时：任意静态服务器即可（API 会跨域调用线上主站）
python -m http.server 8791 --directory public
```

> 注意：`wrangler pages dev` 需要在 `wrangler.toml` 所在目录执行；
> 本地 D1 与线上 D1 是两份数据，互不相通。

## 4. 架构与关键实现

### 4.1 请求链路

```
浏览器 SPA
  │  fetch(API + /api/xxx, headers: { X-Passcode })
  ▼
functions/api/[[route]].js  ── OPTIONS 预检 → 200（CORS 全开放）
  │  ① path === "ping" → 免鉴权探活
  │  ② X-Passcode !== env.PASSCODE → 401
  ▼
env.DB（D1 绑定）→ logs / todos 表
```

- **鉴权**：单口令。前端登录 = `GET /api/ping` 不需要口令，其余接口校验 `X-Passcode`
  与 Pages 环境变量 `PASSCODE`（secret）一致。口令错误由前端清除 localStorage 回登录页。
- **CORS 全开**是有意设计：前端可部署在任意镜像域（pages.dev / jiuyeke.cn / here.now），
  安全性完全由口令承担，不依赖同源策略。
- **日期口径**：服务器运行在 UTC，`dateNow()` 用 `+8h` 折算北京时间；
  正常情况下前端**显式传 `day`**（本地日历日），只有非法/缺失才走服务端兜底。

### 4.2 关键实现细节

| 实现点 | 位置 | 说明 |
|---|---|---|
| 单文件路由 | `onRequest` 内 `path` 剥前缀后 if-chain | 新增端点 = 加一个 `path === "xxx"` 分支 |
| 口令比较 | `request.headers.get("x-passcode")` | 非 HTTPS 环境不要部署（口令明文头部） |
| 内容上限 | `content.length > 2000` → 400 | 防滥用；改上限同步改前端提示 |
| 真实日期校验 | 正则 + `!isNaN(Date.parse(day))` | 只查正则会放过 `2026-13-99` |
| 统计时区 | `date('now','+8 hours', ...)` | 曾因 UTC 口径把北京"今天"排除（v1.0.1 修复） |
| todosDone 桶 | `date(done_at,'+8 hours')` | done_at 为 UTC datetime |

## 5. 数据契约

### 5.1 D1 表结构

```sql
CREATE TABLE logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,              -- YYYY-MM-DD（北京时间）
  content    TEXT NOT NULL,              -- ≤ 2000 字
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))  -- UTC
);
CREATE TABLE todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  day        TEXT,                       -- 计划日（北京时间）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  done_at    TEXT                        -- 完成时刻（UTC），统计时 +8h 归桶
);
```

### 5.2 API 一览（除 ping 外全部要求 `X-Passcode` 头）

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/api/ping` | — | `{ok:true,name}` |
| GET | `/api/logs?day=YYYY-MM-DD` | day 可选 | `{ok, items:[log]}` |
| GET | `/api/logs?recent=14` | recent≤120 | `{ok, counts:[{day,n}], items:[log]}` |
| POST | `/api/logs` | `{content≤2000, day?}` | `{ok, item}`；非法 day 归今天 |
| DELETE | `/api/logs/{id}` | — | `{ok}` |
| GET | `/api/todos` | — | `{ok, items}`（未完成在前） |
| POST | `/api/todos` | `{content, day?}` | `{ok, item}` |
| PATCH | `/api/todos/{id}` | `{done:bool}` | `{ok}`；done=true 写 `done_at` |
| DELETE | `/api/todos/{id}` | — | `{ok}` |
| GET | `/api/stats?days=14` | days≤60 | `{ok, logs, todosDone, openTodos, days}` |

统一错误形状：`{"error":"中文原因"}` + 400/401/404/500。

### 5.3 前端 localStorage

| 键 | 值 | 说明 |
|---|---|---|
| `gz_pc` | 口令明文 | 登录成功后写入；401 时清除 |
| `gz_api` | API 主站地址 | 镜像部署时设为 `https://gongzuotai-86d.pages.dev`；留空=同源 |

`api()` 的自动判断：hostname 含 `pages.dev`/`jiuyeke.cn` → 同源；否则（镜像域）→ 回退主站常量。
**改主站地址时**：`functions/api/[[route]].js` 无需动，前端回退常量 + `wrangler.toml` 项目名即可。

## 6. 测试与验收

```bash
# API 端到端（写/读/勾选/统计/清理，含重试容错）——
# 用 python requests 直打线上 API（参考交付时的验证脚本）：
python - <<'EOF'
import requests
B="https://gongzuotai-86d.pages.dev/api"; H={"X-Passcode":"<口令>"}
r=requests.post(B+"/logs",headers=H,json={"content":"验收","day":"2026-11-06"}).json()
print(r); requests.delete(f"{B}/logs/{r['item']['id']}",headers=H)
EOF
# 边界用例清单（历史轮次验证过）：XSS 原样存储(前端转义渲染)、2001字→400、
# 非法 day 归今天、emoji/中英混排、无口令 401、清空后 stats 归零。
```

前端冒烟：登录→记一条→勾选待办→切「近两周」看柱状图；镜像部署时在「设置」填主站地址。

## 7. 构建与部署

```bash
# ① 部署（frontend + functions + D1 绑定 一起上）
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
wrangler pages deploy --project-name gongzuotai --branch main --commit-dirty=true

# ② 改口令（改完必须重新 deploy 一次才生效——secret 只对新部署生效！）
echo "新口令" | wrangler pages secret put PASSCODE --project-name gongzuotai
wrangler pages deploy --project-name gongzuotai --branch main --commit-dirty=true

# ③ 自定义域（here.jiuyeke.cn）
#    Pages 侧：POST /accounts/{acc}/pages/projects/gongzuotai/domains {"name":"here.jiuyeke.cn"}
#    DNS 侧：CNAME here → gongzuotai-86d.pages.dev（proxied）
```

- **GitHub Pages 镜像**：push 到 main 自动触发 `.github/workflows/pages.yml`（仅 `public/`）。
- **here.now 镜像**：发布 `public/` 目录（带 `HERENOW_API_KEY` 才是永久站，匿名 24h 过期）。
- ⚠️ 主站地址变更（如换 Pages 项目）要同步改：前端回退常量 + DNS CNAME + README。

## 8. 二次开发指南

### a. 新增数据维度（如「心情/课程标签」）
改三处：① D1 `ALTER TABLE logs ADD COLUMN mood TEXT`；
② `functions/api/[[route]].js` 的 POST `/logs` INSERT 列与 GET 返回；
③ `public/index.html` 录入行 + `renderLogs()` 展示。注意：D1 无迁移框架，用
`wrangler d1 execute gongzuotai-db --command "ALTER ..."` 且老数据该列恒为 NULL。

### b. 多用户/班级隔离
现模型单口令单用户。扩展方向：加 `users` 表 + 口令→用户映射，`logs/todos` 加 `uid` 列，
所有查询按 `X-Passcode` 解析出的 uid 过滤。**不要**改成纯前端区分——口令即一切凭证。

### c. 数据导出/备份
加 `GET /api/export`：`SELECT * FROM logs ORDER BY day` 与 todos 两个表打成 JSON 附件
（`Content-Disposition: attachment`）。前端加按钮 `location.href=...`。D1 免费库 5GB 上限，
此应用场景基本不会触顶，但仍建议季度导出一次存 Z 盘。

### d. 周报生成
`GET /api/stats?days=7` 已有原始桶。前端加「生成本周小结」：把 7 天 logs 按日拼接 +
完成待办数，`navigator.clipboard.writeText()` 复制成 Markdown，即可贴进教案/周报。
若要 AI 小结，建议在本地跑（别把工作内容明文发第三方接口）。

### e. 通知提醒（明日待办）
Workers Cron Triggers 在 Pages 上不可用；可行做法：本地 Windows 任务计划 +
`requests` 打 `/api/todos` 拉未完成数，超阈值用 Windows 通知（`win10toast`/消息弹窗）提醒。

## 9. 常见坑（真实踩过）

1. **Pages secret 只对新部署生效**——`wrangler pages secret put` 之后必须再 `deploy` 一次。
2. **pages.dev 免费版国内访问间歇超时**（TLS 握手 25s 超时复现过）——所以有 jiuyeke.cn
   自定义域 + GitHub Pages/here.now 双镜像；前端改 API 地址在「设置」即可。
3. **D1 的 `datetime('now','localtime')` 是 UTC**（容器无时区）——涉及时区一律显式 `'+8 hours'`，
   且**业务日期由前端传**，不要信服务器时钟。
4. **D1 免费版 10 库硬上限**——建新库前先删废库（曾为此清掉 2026-05 的测试库）。
5. ** Pages 项目名全局占用**——`gongzuotai` 被占后实际是 `gongzuotai-86d.pages.dev`，
   引用主站地址时别写想当然的 `gongzuotai.pages.dev`。
6. **CORS 全开 + 口令明文头**——必须 HTTPS 部署；口令泄露 = 数据全泄，口令要定期换。

## 10. 维护与发布清单

1. 改 `functions/` 或 `public/` → 本地 `wrangler pages dev` 冒烟
2. 跑 §6 API 验收（含清空断言）
3. `git commit`（本地仓库与远端同名分支）
4. `wrangler pages deploy`（**有 secret 变更时记得这是生效步骤**）
5. `git push` → GitHub Pages 镜像自动重建
6. here.now 镜像：前端有变才需要重发（`scripts/herenow_publish.py`）
7. 线上验证：`/api/ping`、登录、记一条、看统计
8. 出问题回滚：`wrangler pages deployment list` → 上一个部署 `rollback`

---

维护人：智策ZCagent · 许可以 MIT 见 [LICENSE](../LICENSE)
