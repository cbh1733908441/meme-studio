import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
export function cliInfo() {
  const bin = process.env.CODEX_BIN || "codex";
  const version = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  const login =
    version.status === 0
      ? spawnSync(bin, ["login", "status"], {
          encoding: "utf8",
          timeout: 10000,
        })
      : null;
  return {
    available: version.status === 0,
    version: version.stdout?.trim() || "",
    loggedIn: login?.status === 0,
    login:
      login?.status === 0 ? "已登录本地 Codex" : "请先在终端运行 codex login",
  };
}
export function disabledMcpArgs() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {}
  return [...raw.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)].flatMap(
    (m) => ["-c", `mcp_servers.${m[1]}.enabled=false`],
  );
}
export function eventMessage(e) {
  const type = e.item?.type || e.type;
  if (type === "web_search") return "正在检索与核验来源";
  if (type === "command_execution") return "正在读取资料或处理素材";
  if (
    type === "agent_message" &&
    e.item?.text &&
    !e.item.text.trim().startsWith("{")
  )
    return e.item.text.slice(0, 220);
  if (e.type === "turn.started") return "Codex 已开始分析";
  if (e.type === "error" || e.type === "turn.failed") {
    const raw = String(e.message || e.error?.message || "本阶段未完成");
    const attempt = raw.match(/Reconnecting.*?(\d+\/\d+)/i);
    if (attempt) return `Codex 连接中断，正在重连（${attempt[1]}）`;
    return (
      "Codex 执行异常：" +
      raw.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g, "[已隐藏]").slice(0, 220)
    );
  }
}
export function runCodex({
  stage,
  prompt,
  schema,
  dir,
  signal,
  onEvent,
  onStart,
  onSearch,
  timeoutMs = 30 * 60 * 1000,
}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    const schemaFile = path.join(dir, "schema.json"),
      outputFile = path.join(dir, "result.json");
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    fs.writeFileSync(path.join(dir, "prompt.txt"), prompt);
    const args = [
      "--search",
      "-a",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.multi_agent_v2=false",
      ...disabledMcpArgs(),
      "--json",
      "--color",
      "never",
      "-C",
      dir,
      "--output-schema",
      schemaFile,
      "-o",
      outputFile,
      "-",
    ];
    if (process.env.CODEX_MODEL)
      args.splice(args.length - 1, 0, "-m", process.env.CODEX_MODEL);
    const child = spawn(process.env.CODEX_BIN || "codex", args, {
      cwd: dir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let timer;
    child.once("spawn", () => {
      const startedAt = Date.now();
      fs.writeFileSync(
        path.join(dir, "execution-budget.json"),
        JSON.stringify({
          startedAt: new Date(startedAt).toISOString(),
          deadline: new Date(startedAt + timeoutMs).toISOString(),
          timeoutMs,
        }),
      );
      onStart?.();
      timer = setTimeout(
        () => {
          timedOut = true;
          kill();
        },
        Math.max(0, startedAt + timeoutMs - Date.now()),
      );
      timer.unref();
    });
    const searches = [];
    const searchIds = new Set();
    const log = fs.createWriteStream(path.join(dir, "events.jsonl"));
    let buffer = "",
      stderr = "",
      failureMessage = "",
      stopped = false,
      timedOut = false,
      killer;
    const kill = () => {
      if (stopped) return;
      stopped = true;
      try {
        process.platform === "win32"
          ? child.kill("SIGTERM")
          : process.kill(-child.pid, "SIGTERM");
      } catch {}
      killer = setTimeout(() => {
        try {
          process.platform === "win32"
            ? child.kill("SIGKILL")
            : process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2500);
      killer.unref();
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (child.pid && process.platform !== "win32")
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      signal?.removeEventListener("abort", kill);
      log.end();
    };
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      buffer += chunk.toString();
      if (buffer.length > 4e6) {
        buffer = "";
        return;
      }
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const e = JSON.parse(line);
          if (e.type === "turn.failed")
            failureMessage = String(e.error?.message || "CLI 本阶段失败");
          if (
            e.type === "item.completed" &&
            e.item?.type === "web_search" &&
            e.item.action?.type === "search" &&
            !searchIds.has(e.item.id)
          ) {
            searchIds.add(e.item.id);
            const record = {
              time: new Date().toISOString(),
              itemId: e.item.id,
              queries:
                e.item.action.queries || (e.item.query ? [e.item.query] : []),
            };
            searches.push(record);
            fs.writeFileSync(
              path.join(dir, "searches.json"),
              JSON.stringify(searches, null, 2),
            );
            onSearch?.(record);
          }
          const message = eventMessage(e);
          if (message) onEvent?.(message);
        } catch {}
      }
    });
    child.stderr.on("data", (c) => {
      stderr = (stderr + c.toString()).slice(-12000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.on("error", (e) => {
      cleanup();
      reject(new Error("无法启动 Codex CLI：" + e.message));
    });
    child.on("close", (code) => {
      cleanup();
      fs.writeFileSync(path.join(dir, "stderr.log"), stderr);
      if (timedOut)
        return reject(
          Object.assign(
            new Error(`本阶段达到 ${timeoutMs / 1000} 秒时限，已停止进程组。`),
            { code: "STAGE_TIMEOUT" },
          ),
        );
      if (stopped || signal?.aborted) return reject(new Error("已取消"));
      if (code !== 0)
        return reject(
          new Error(
            `Codex CLI 退出（${code}）。${(failureMessage || stderr).replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g, "[已隐藏]").slice(-1600)}`,
          ),
        );
      try {
        const result = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        resolve(result);
      } catch {
        reject(
          new Error("Codex 未返回有效结构化结果，请查看本次运行日志后重试。"),
        );
      }
    });
  });
}
