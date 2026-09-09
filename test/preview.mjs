// Isolated browser verification server. Never used by the production launcher.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server.mjs";
import { result } from "./fixtures.mjs";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-ui-test-"));
const { server, manager } = createApp({
  dataDir,
  info: { available: true, loggedIn: true, version: "UI fixture" },
  runner: async (args) => {
    await delay(400);
    const data = result(args);
    if (args.stage === "analysis") {
      data.summary = "仅用于界面验收的模拟输出。";
      data.branches[0].title = "海绵宝宝想象力 · 界面验收样本";
      data.branches[0].gaps = ["模拟数据，不代表真实研究"];
    }
    if (args.stage === "audit")
      data.candidates.forEach((c) => {
        c.title = "模拟选题 " + c.id;
        c.trace_a = "拖动到左侧 → 彩虹向左展开。";
        c.trace_b = "拖动到右侧 → 彩虹向右展开。";
      });
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
