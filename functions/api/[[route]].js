// 每日工作台 API（Cloudflare Pages Functions + D1）
// 鉴权：全部接口（除 /api/ping）要求请求头 X-Passcode === 环境变量 PASSCODE
// CORS：允许任意来源（前端可部署在 pages.dev / jiuyeke.cn / here.now 镜像）

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Passcode",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...cors },
    });

  if (path === "ping") return json({ ok: true, name: env.APP_NAME || "gongzuotai" });

  // ---- 鉴权 ----
  if (!env.PASSCODE) return json({ error: "服务端未设置口令（请在 Pages 环境变量配置 PASSCODE）" }, 500);
  const pc = request.headers.get("x-passcode") || "";
  if (pc !== env.PASSCODE) return json({ error: "口令错误" }, 401);

  const db = env.DB;
  const method = request.method;

  try {
    // ---------- 日志（每天做了什么） ----------
    if (path === "logs" && method === "GET") {
      const day = url.searchParams.get("day");
      if (day) {
        const r = await db.prepare("SELECT * FROM logs WHERE day = ? ORDER BY id DESC").bind(day).all();
        return json({ ok: true, items: r.results });
      }
      const days = Math.min(parseInt(url.searchParams.get("recent") || "14", 10) || 14, 120);
      const r = await db
        .prepare(`SELECT day, COUNT(*) AS n FROM logs
                  WHERE day >= date('now','localtime', ?)
                  GROUP BY day ORDER BY day DESC`)
        .bind(`-${days - 1} days`)
        .all();
      const items = await db
        .prepare(`SELECT * FROM logs WHERE day >= date('now','localtime', ?)
                  ORDER BY day DESC, id DESC`)
        .bind(`-${days - 1} days`)
        .all();
      return json({ ok: true, counts: r.results, items: items.results });
    }
    if (path === "logs" && method === "POST") {
      const b = await request.json();
      const content = String(b.content || "").trim();
      if (!content) return json({ error: "内容不能为空" }, 400);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day || "") ? b.day : dateNow();
      const r = await db.prepare("INSERT INTO logs (day, content) VALUES (?, ?) RETURNING *").bind(day, content).run();
      return json({ ok: true, item: r.results[0] });
    }
    if (path.startsWith("logs/") && method === "DELETE") {
      const id = parseInt(path.split("/")[1], 10);
      if (!id) return json({ error: "bad id" }, 400);
      await db.prepare("DELETE FROM logs WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ---------- 待办（还要做什么） ----------
    if (path === "todos" && method === "GET") {
      const r = await db
        .prepare(`SELECT * FROM todos ORDER BY done ASC, id DESC LIMIT 300`)
        .all();
      return json({ ok: true, items: r.results });
    }
    if (path === "todos" && method === "POST") {
      const b = await request.json();
      const content = String(b.content || "").trim();
      if (!content) return json({ error: "内容不能为空" }, 400);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day || "") ? b.day : dateNow();
      const r = await db.prepare("INSERT INTO todos (content, day) VALUES (?, ?) RETURNING *").bind(content, day).run();
      return json({ ok: true, item: r.results[0] });
    }
    if (path.startsWith("todos/") && method === "PATCH") {
      const id = parseInt(path.split("/")[1], 10);
      const b = await request.json();
      const done = b.done ? 1 : 0;
      if (!id) return json({ error: "bad id" }, 400);
      await db
        .prepare(`UPDATE todos SET done = ?, done_at = CASE WHEN ? = 1 THEN datetime('now','localtime') ELSE NULL END WHERE id = ?`)
        .bind(done, done, id)
        .run();
      return json({ ok: true });
    }
    if (path.startsWith("todos/") && method === "DELETE") {
      const id = parseInt(path.split("/")[1], 10);
      if (!id) return json({ error: "bad id" }, 400);
      await db.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ---------- 统计 ----------
    if (path === "stats" && method === "GET") {
      const days = Math.min(parseInt(url.searchParams.get("days") || "14", 10) || 14, 60);
      const logs = await db
        .prepare(`SELECT day, COUNT(*) AS n FROM logs
                  WHERE day BETWEEN date('now','localtime', ?) AND date('now','localtime')
                  GROUP BY day`)
        .bind(`-${days - 1} days`)
        .all();
      const todos = await db
        .prepare(`SELECT date(done_at) AS day, COUNT(*) AS n FROM todos
                  WHERE done = 1 AND done_at IS NOT NULL
                    AND date(done_at) BETWEEN date('now','localtime', ?) AND date('now','localtime')
                  GROUP BY date(done_at)`)
        .bind(`-${days - 1} days`)
        .all();
      const open = await db.prepare("SELECT COUNT(*) AS n FROM todos WHERE done = 0").all();
      return json({
        ok: true,
        logs: logs.results,
        todosDone: todos.results,
        openTodos: open.results[0].n,
        days,
      });
    }

    return json({ error: "not found: " + path }, 404);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}

function dateNow() {
  // Pages Functions 运行在 UTC，用本地时间口径由前端显式传 day；这里兜底 +8h
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
