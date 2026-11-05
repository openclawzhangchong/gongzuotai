# 📋 张哥工作台（每日工作台）

一个部署在 **Cloudflare Pages + D1** 的个人工作台：**记录每天做了什么、还要做什么**。

- 线上地址（主站）：**https://gongzuotai.pages.dev**
- 快速入口（自定义域）：**https://here.jiuyeke.cn**
- 前端镜像（主站慢时的备用入口，数据同源）：见 [here.now 镜像](#镜像)

## 功能

- **每日记录**：一句话记一条「今天做了什么」，按日期时间线展示，回车快速录入
- **待办清单**：添加/勾选/删除，完成时间自动记录，「清空已完成」一键收纳
- **近 14 天统计**：每日记录条数柱状图 + 今日完成数 + 未办总数
- **口令登录**：单口令保护（环境变量 `PASSCODE`），适合个人使用
- **移动端适配**：手机上顺手记

## 架构

```
public/index.html        ← 前端单页（原生 JS，无框架）
functions/api/[[route]].js ← Pages Functions（API：logs/todos/stats，D1 绑定）
wrangler.toml            ← 项目与 D1 配置
```

- 数据库：Cloudflare D1（SQLite）`gongzuotai-db`，两张表 `logs` / `todos`
- 鉴权：所有接口校验请求头 `X-Passcode` == 环境变量 `PASSCODE`
- CORS：全开，前端可从任意镜像域调用主站 API（口令仍是唯一凭证）

## 镜像

主站（*.pages.dev）在国内访问可能偏慢，本仓库前端是**纯静态**的，
可以部署到任意静态托管作镜像，登录后在「设置」里把 API 主站指向
`https://gongzuotai.pages.dev` 即可共用同一份数据。

## 自己部署

```bash
# 1. 创建 D1 数据库并建表（logs/todos，schema 见 functions/api/[[route]].js 注释）
wrangler d1 create gongzuotai-db

# 2. 创建 Pages 项目并部署
wrangler pages project create gongzuotai --production-branch main
wrangler pages deploy            # 读取 wrangler.toml，上传 public/ + functions/

# 3. 设置口令
wrangler pages secret put PASSCODE --project-name gongzuotai

# 4. （可选）绑定自定义域名
wrangler pages project   # 或在 Dashboard 中添加 Custom Domain，并加 CNAME 到 <project>.pages.dev
```

## 数据口径

- 「今天」按北京时间（UTC+8）计算，日期由前端显式传给 API，避免服务器时区歧义
- 所有数据可随时在 D1 控制台导出，**可自由迁移**

## License

MIT © 2026 智策ZCagent
