// Explicitly invoked integration check. Uses the real CLI and account usage.
import fs from "node:fs";
import path from "node:path";
import { Manager } from "../lib/manager.mjs";
import { runCodex, cliInfo } from "../lib/runner.mjs";
import { ROOT } from "../server.mjs";
const info = cliInfo();
if (!info.available || !info.loggedIn) throw new Error("本地 Codex 不可用");
const dataDir = path.resolve(
  process.env.SMOKE_DATA || path.join(ROOT, "data-smoke"),
);
const manager = new Manager({
  dataDir,
  vendor: path.join(ROOT, "vendor", "skills"),
  runner: runCodex,
  python: process.env.MEME_PYTHON || "python3",
});
const r = manager.create({
  meme: "海绵宝宝想象力",
  context:
    "这是开发者主动启动的真实端到端连通性验收。目标是海绵宝宝双手展开彩虹、说 imagination 的传播版本。只保留这个分支；研究聚焦代表素材和一个具体玩法母体，避免扩展成大综述。素材不能直接看或听时，保留缺口。测试程序会明确确认这一目标并最多生成 1 个候选。",
});
console.log(JSON.stringify({ id: r.id, dataDir }));
let last = "";
const timer = setInterval(() => {
  const s = manager.get(r.id),
    line = JSON.stringify({
      status: s.status,
      phase: s.phase,
      event: s.events.at(-1)?.message,
    });
  if (line !== last) {
    console.log(line);
    last = line;
  }
}, 5000);
try {
  await manager.idle(r.id);
  let s = manager.get(r.id);
  if (s.status !== "awaiting_confirmation")
    throw new Error(s.error || s.status);
  console.log("PASS: real analysis paused for confirmation");
  manager.confirm(s.id, {
    revision: s.revision,
    branchId: s.analysis.recommended_branch_id,
    count: 1,
    notes: "开发者验收：明确确认上述想象力版本，保留全部未验证模态和玩法假设。",
  });
  await manager.idle(r.id);
  s = manager.get(r.id);
  if (s.status !== "completed" || s.result.candidates.length > 1)
    throw new Error(s.error || s.status);
  const report = {
    passed: true,
    at: new Date().toISOString(),
    cli: info.version,
    runId: s.id,
    stages: s.jobs.map((j) => ({ stage: j.stage, status: j.status })),
    requestedMaximum: 1,
    count: s.result.candidates.length,
    evidenceStatus: s.result.candidates.map(c => c.status),
    shortfallReason: s.result.shortfall_reason,
    peak: manager.pool.peak,
  };
  fs.writeFileSync(
    path.join(dataDir, "validation.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  clearInterval(timer);
  await manager.stop();
}
