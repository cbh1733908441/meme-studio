// Isolated browser verification server. Never used by the production launcher.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server.mjs";
import { result } from "./fixtures.mjs";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-ui-test-"));
const previewIds = (process.env.PREVIEW_RUN_IDS || "")
  .split(",")
  .filter(Boolean);
for (const id of previewIds) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("无效的验收任务 ID");
  const source = path.resolve("data-smoke", id),
    record = JSON.parse(fs.readFileSync(path.join(source, "run.json"), "utf8"));
  if (record.status !== "completed") throw Error("只允许预览已完成的验收结果");
  fs.cpSync(source, path.join(dataDir, id), { recursive: true });
}
const { server, manager } = createApp({
  dataDir,
  info: {
    available: !previewIds.length,
    loggedIn: !previewIds.length,
    version: previewIds.length ? "真实验收结果只读预览" : "UI fixture",
  },
  runner: async (args) => {
    args.onStart?.();
    await delay(400);
    const data = result(args);
    if (args.stage === "analysis") {
      const wav = Buffer.alloc(44 + 16000 * 2 * 3);
      wav.write("RIFF");
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(wav.length - 44, 40);
      fs.writeFileSync(path.join(args.dir, "sample.wav"), wav);
      const video = spawnSync(path.resolve("runtime/bin/ffmpeg"), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:d=8",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(args.dir, "sample.mp4"),
      ]);
      if (video.status !== 0) throw Error("无法创建视频验收文件");
      data.branches[0].media = [
        {
          path: "sample.wav",
          caption: "3 秒静音测试文件",
          source_url: null,
          start_s: null,
          end_s: null,
        },
        {
          path: "sample.mp4",
          caption: "8 秒蓝屏测试视频",
          source_url: null,
          start_s: null,
          end_s: null,
        },
      ];
      data.summary = "仅用于界面验收的模拟输出。";
      data.branches[0].title = "海绵宝宝想象力 · 界面验收样本";
      data.branches[0].gaps = ["模拟数据，不代表真实研究"];
    }
    if (args.stage === "adaptation")
      data.candidates.forEach((c) => (c.title = "模拟选题 " + c.id));
    return data;
  },
});
server.listen(4318, "127.0.0.1", () =>
  console.log("UI test only http://127.0.0.1:4318"),
);
async function stop() {
  server.close();
  await manager.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
