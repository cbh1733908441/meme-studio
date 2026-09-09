import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, "server.mjs"),
  pidfile = path.join(root, ".server.pid");
const port = Number(process.env.PORT || 4317),
  url = `http://127.0.0.1:${port}`;
let saved;
try {
  saved = JSON.parse(fs.readFileSync(pidfile, "utf8"));
} catch {}
function ours(pid) {
  if (!Number.isInteger(pid)) return false;
  const p = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return p.status === 0 && p.stdout.includes(entry);
}
if (process.argv[2] === "stop") {
  if (saved && ours(saved.pid)) {
    process.kill(saved.pid, "SIGTERM");
    for (let i = 0; i < 80 && ours(saved.pid); i++) await delay(100);
    if (ours(saved.pid)) throw Error("服务正在退出，请稍后重试。");
  }
  fs.rmSync(pidfile, { force: true });
  console.log("Meme Studio 已停止。");
} else {
  if (saved && ours(saved.pid)) {
    console.log(`Meme Studio 已在运行：http://127.0.0.1:${saved.port}`);
    process.exit(0);
  }
  try {
    const r = await fetch(url + "/api/meta", {
      signal: AbortSignal.timeout(1000),
    });
    if (r) throw Error(`端口 ${port} 已有其他服务，请使用 PORT 指定新端口。`);
  } catch (e) {
    if (e.message.includes("已有其他服务")) throw e;
  }
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  const log = fs.openSync(path.join(root, "logs", "server.log"), "a");
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex",
    python = path.join(root, ".venv", "bin", "python");
  const env = {
    ...process.env,
    PORT: String(port),
    PATH: [
      path.join(root, "runtime", "bin"),
      path.join(root, ".venv", "bin"),
      process.env.PATH || "",
    ].join(path.delimiter),
  };
  if (!env.CODEX_BIN && fs.existsSync(bundled)) env.CODEX_BIN = bundled;
  if (!env.MEME_PYTHON && fs.existsSync(python)) env.MEME_PYTHON = python;
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, port }));
  for (let i = 0; i < 240; i++) {
    await delay(100);
    try {
      const r = await fetch(url + "/api/meta", {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        const meta = await r.json();
        if (meta.skillVersion) {
          console.log(
            `Meme Studio 已启动：${url}\nCLI：${meta.cli.version || "未检测到"} · 并发上限 3`,
          );
          process.exit(0);
        }
      }
    } catch {}
    if (!ours(child.pid)) break;
  }
  throw Error("服务未能启动，请查看 logs/server.log。");
}
