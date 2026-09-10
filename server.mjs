import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Manager, AppError } from "./lib/manager.mjs";
import { runCodex, cliInfo } from "./lib/runner.mjs";
import { SKILL_VERSION } from "./lib/prompts.mjs";
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};
function send(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new AppError("需要 JSON 请求", 415);
  let bytes = 0,
    chunks = [];
  for await (const c of req) {
    bytes += c.length;
    if (bytes > 64000) throw new AppError("输入内容过长", 413);
    chunks.push(c);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw Error();
    return value;
  } catch {
    throw new AppError("需要有效的 JSON 对象");
  }
}
export function markdown(r, base = "http://127.0.0.1:4317") {
  if (r.workflowVersion === 3) {
    const lines = [
      `# ${r.meme}：${r.result.candidates.length} 个选题`,
      `Skill ${r.skillVersion}`,
      r.result.summary,
    ];
    for (const c of r.result.candidates) {
      lines.push(
        `## ${c.id} · ${c.title}`,
        ...(Object.hasOwn(c, "gameplay")
          ? ["### 玩法与简单规则", c.gameplay]
          : ["### 一句话玩法", c.hook, "### 必要规则", c.rules, "### 玩家操控方式", c.controls]),
        "### 素材使用",
      );
      for (const u of c.media_usage) {
        const a = r.assets.find((a) => a.id === u.asset_id);
        lines.push(
          [
            u.status === "used"
              ? "使用"
              : u.status === "missing"
                ? "待补"
                : "不使用",
            u.where,
            u.interaction,
            u.note,
          ]
            .filter(Boolean)
            .join("："),
        );
        if (a)
          lines.push(
            `[${a.caption || a.id}](${base}/api/runs/${r.id}/media?assetId=${encodeURIComponent(a.id)})`,
          );
      }
      lines.push(
        "### 梗的趣味",
        c.meme_interest,
        ...(Object.hasOwn(c, "gameplay") ? [] : ["### 最小实现", c.minimum_implementation]),
        "### 参考",
      );
      for (const ref of c.references) {
        const m = r.research.mechanisms.find((m) => m.id === ref.mechanism_id);
        lines.push(
          `${m.game}：借用 ${ref.borrowed}；改动 ${ref.changes}；原创 ${ref.original}`,
          ...m.sources.map((s) => `[${s.title}](${s.url}) — ${s.support}`),
        );
      }
    }
    if (r.research.timeLimited) lines.push("研究达到时限，使用已有结果");
    if (r.result.shortfall_reason) lines.push(r.result.shortfall_reason);
    return lines.join("\n\n");
  }

  const lines = [
    `# ${r.meme}：${r.result.candidates.filter((c) => c.status === "candidate").length} 个候选（上限 ${r.count}）`,
    "",
    `Skill ${r.skillVersion || r.skillCommit}`,
    "",
    `已确认分支：${r.confirmed.branch.title}`,
    "",
    r.result.summary,
    "",
  ];
  for (const c of r.result.candidates.filter((c) => c.status === "candidate")) {
    lines.push(
      `## ${c.id} · ${c.title}`,
      `状态：${c.status}`,
      "",
      c.hook,
      "",
      `操作：${c.player_action}`,
      "",
      `亲手体验的变化：${c.experience_change || "历史版本未记录"}`,
      `如何保住趣味：${c.interest_connection || c.meme_relation}`,
      `来源支持：${c.source_support}`,
      `母体编号：${c.mother_ids.join("、")}`,
      `保留条件：${c.retained_conditions.join("；")}`,
      `删除条件：${c.removed_conditions.join("；")}`,
      `新增假设：${c.new_assumptions.join("；")}`,
      `再次操作：${c.replay_reason}`,
      `简化：${c.simplification}`,
      `风险：${c.production_risk}`,
      `最小验证：${c.minimum_test}`,
      `撤下条件：${c.reject_if}`,
      "",
    );
  }
  lines.push(
    "## 未采用方向",
    ...(r.result.rejected || []).map((x) => `${x.id} ${x.title}：${x.reason}`),
  );
  const b = r.confirmed.branch;
  if (b.interesting_moment)
    lines.push(
      "## 素材理解",
      b.interesting_moment,
      `依据：${b.basis}`,
      `不能随便改：${b.must_keep.join("；")}`,
    );
  lines.push(
    "## 研究与边界",
    r.result.quality_notes.join("\n\n"),
    r.result.shortfall_reason,
    "",
    "## 母体操作过程",
  );
  for (const m of r.research.mothers)
    lines.push(
      `### ${m.game}`,
      m.url,
      m.experience_signal,
      JSON.stringify(m.walkthrough, null, 2),
      "",
    );
  return lines.join("\n\n");
}
export function createApp({
  dataDir = path.join(ROOT, "data"),
  runner = runCodex,
  info = cliInfo(),
  python = process.env.MEME_PYTHON || "python3",
} = {}) {
  const manager = new Manager({
    dataDir,
    vendor: path.join(ROOT, "vendor", "skills"),
    runner,
    limit: 3,
    python,
  });
  let gitCommit = "unknown";
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {}
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
        throw new AppError("仅允许本地访问", 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        throw new AppError("不允许跨站请求", 403);
      const url = new URL(req.url, `http://${host}`),
        p = url.pathname;
      if (req.method === "GET" && p === "/api/meta")
        return send(res, 200, {
          token,
          cli: info,
          pool: manager.pool.stats,
          skillVersion: SKILL_VERSION,
          adaptationVersion: "3.0.0",
          understandingVersion: "1.1.0",
          workflowVersion: 3,
          gitCommit,
        });
      if (req.method === "GET" && p === "/api/runs")
        return send(res, 200, {
          runs: manager.list(),
          pool: manager.pool.stats,
        });
      if (!["GET", "HEAD"].includes(req.method)) {
        if (req.headers["x-meme-token"] !== token)
          throw new AppError("页面会话已过期，请刷新", 403);
      }
      if (req.method === "POST" && p === "/api/runs") {
        if (!info.available || !info.loggedIn)
          throw new AppError(info.login || "Codex CLI 不可用", 503);
        return send(res, 201, manager.create(await body(req)));
      }
      const match = p.match(
        /^\/api\/runs\/([a-f0-9-]{36})(?:\/(confirm|revise|cancel|retry|readapt|export|media))?$/,
      );
      if (match) {
        const [, id, action] = match,
          r = manager.get(id);
        if (req.method === "GET" && !action)
          return send(res, 200, { run: r, pool: manager.pool.stats });
        if (
          req.method === "POST" &&
          ["confirm", "revise", "cancel", "retry", "readapt"].includes(action)
        ) {
          if (!info.available || !info.loggedIn)
            throw new AppError("Codex CLI 不可用，请检查登录", 503);
          return send(res, 200, manager[action](id, await body(req)));
        }
        if (req.method === "GET" && action === "export") {
          if (!r.result) throw new AppError("结果尚未生成", 409);
          const isJson = url.searchParams.get("format") === "json";
          res.writeHead(200, {
            "Content-Type": isJson
              ? "application/json"
              : "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="meme-${id}.${isJson ? "json" : "md"}"`,
          });
          return res.end(
            isJson ? JSON.stringify(r, null, 2) : markdown(r, `http://${host}`),
          );
        }
        if (req.method === "GET" && action === "media") {
          const assetId = url.searchParams.get("assetId");
          const asset = assetId
            ? (r.assets || []).find((a) => a.id === assetId)
            : null;
          if (assetId && !asset) throw new AppError("素材不存在", 404);
          const rel = asset
            ? path.join(asset.jobId, asset.relativePath)
            : url.searchParams.get("path") || "";
          const work = path.join(manager.folder(r), "work");
          const target = path.resolve(work, rel);
          if (
            !target.startsWith(work + path.sep) ||
            !Object.keys(mime)
              .filter((e) => ![".html", ".js", ".css"].includes(e))
              .includes(path.extname(target).toLowerCase())
          )
            throw new AppError("文件不可访问", 403);
          const real = fs.realpathSync(target);
          if (
            !real.startsWith(fs.realpathSync(work) + path.sep) ||
            real.includes(`${path.sep}.agents${path.sep}`)
          )
            throw new AppError("文件不可访问", 403);
          const size = fs.statSync(real).size;
          const headers = {
            "Content-Type": mime[path.extname(real).toLowerCase()],
            "Accept-Ranges": "bytes",
          };
          if (req.headers.range) {
            const m = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
            if (!m) throw new AppError("无效范围", 416);
            const start = Number(m[1]),
              end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
            if (start > end || start >= size)
              throw new AppError("无效范围", 416);
            res.writeHead(206, {
              ...headers,
              "Content-Range": `bytes ${start}-${end}/${size}`,
              "Content-Length": end - start + 1,
            });
            return fs.createReadStream(real, { start, end }).pipe(res);
          }
          res.writeHead(200, { ...headers, "Content-Length": size });
          return fs.createReadStream(real).pipe(res);
        }
      }
      const staticFiles = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
      };
      if (req.method === "GET" && staticFiles[p]) {
        const file = path.join(ROOT, "public", staticFiles[p]);
        res.writeHead(200, {
          "Content-Type": mime[path.extname(file)],
          "Cache-Control": "no-cache",
        });
        return fs.createReadStream(file).pipe(res);
      }
      throw new AppError("页面不存在", 404);
    } catch (e) {
      if (!res.headersSent)
        send(res, e.status || (e.code === "ENOENT" ? 404 : 500), {
          error: e.code === "ENOENT" ? "文件不存在" : e.message,
        });
      else res.end();
    }
  });
  return { server, manager };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 4317);
  const { server, manager } = createApp();
  server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? `端口 ${port} 已占用，请设置 PORT 后重试。`
        : e.message,
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Meme Studio · http://127.0.0.1:${port} · CLI 并发上限 3`),
  );
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    server.close();
    await manager.stop();
    process.exit(0);
  }
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
