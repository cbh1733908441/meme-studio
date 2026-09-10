// Explicit developer integration check: real CLI, isolated records, one concept per meme.
import fs from "node:fs";
import path from "node:path";
import { Manager } from "../lib/manager.mjs";
import { runCodex, cliInfo } from "../lib/runner.mjs";
import { ROOT } from "../server.mjs";
const info = cliInfo();
if (!info.available || !info.loggedIn) throw Error("本地 Codex 不可用");
const dataDir = path.resolve(
  process.env.SMOKE_DATA || path.join(ROOT, "data-smoke"),
);
const manager = new Manager({
  dataDir,
  vendor: path.join(ROOT, "vendor/skills"),
  runner: runCodex,
  python: process.env.MEME_PYTHON || "python3",
});
const targets = [
  {
    meme: "厉飞雨",
    context:
      "目标是《凡人修仙传》韩立借厉飞雨的名字行事、功过报不同姓名的传播梗，不是研究真实人物。请核验该版本，并尽可能获取可预览的代表素材。",
  },
  {
    meme: "广东人吃福建人",
    context:
      "目标是网络中广东人把福建人当作食材、一本正经讨论吃法的虚构地域段子。请核验该版本，并尽可能获取可预览的代表素材。",
  },
];
const reports = [];
let last = "";
const timer = setInterval(() => {
  const text = JSON.stringify(
    manager
      .list()
      .filter((r) => ids.includes(r.id))
      .map((r) => ({
        id: r.id,
        meme: r.meme,
        status: r.status,
        phase: r.phase,
        event: manager.get(r.id).events.at(-1)?.message,
      })),
  );
  if (text !== last) {
    console.log(text);
    last = text;
  }
}, 5000);
const ids = [];
try {
  const resumeIds = (process.env.SMOKE_RESUME_IDS || "")
    .split(",")
    .filter(Boolean);
  const outcomes = await Promise.allSettled(
    targets.map(async (input, index) => {
      const { id } = resumeIds[index]
        ? manager.get(resumeIds[index])
        : manager.create(input);
      if (
        resumeIds[index] &&
        ["failed", "cancelled", "interrupted"].includes(manager.get(id).status)
      )
        manager.retry(id);
      ids.push(id);
      console.log(JSON.stringify({ id, meme: input.meme, dataDir }));
      await manager.idle(id);
      const r = manager.get(id);
      if (r.status === "awaiting_confirmation")
        manager.confirm(id, {
          revision: r.revision,
          branchId: r.analysis.recommended_branch_id,
          count: 1,
          notes: "开发者真实链路验收，明确确认上述目标版本，生成一个选题。",
        });
      await manager.idle(id);
      if (r.status !== "completed" || r.result.candidates.length !== 1)
        throw Error(r.meme + ": " + (r.error || "未产生一个选题"));
      reports.push({
        meme: r.meme,
        runId: id,
        passed: true,
        stages: r.jobs.map((j) => ({
          stage: j.stage,
          status: j.status,
          startedAt: j.startedAt,
          finishedAt: j.finishedAt,
          timeLimited: j.timeLimited,
          searchCalls: j.searches?.length || 0,
        })),
        assets: r.assets.length,
        mediaUsage: r.result.candidates[0].media_usage,
        count: r.result.candidates.length,
      });
    }),
  );
  const passed = outcomes.every((x) => x.status === "fulfilled");
  if (!passed) {
    process.exitCode = 1;
    for (const x of outcomes)
      if (x.status === "rejected") console.error(x.reason.message);
  }
  console.log(JSON.stringify({ passed, reports, peak: manager.pool.peak }));
} finally {
  clearInterval(timer);
  await manager.stop();
  fs.writeFileSync(
    path.join(dataDir, "validation.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: reports.length === 2,
        attempts: ids.map((id) => {
          const r = manager.get(id);
          return {
            id,
            meme: r.meme,
            status: r.status,
            error: r.error,
            jobs: r.jobs,
            assets: r.assets.length,
          };
        }),
        cli: info.version,
        reports,
        runIds: ids,
        peak: manager.pool.peak,
      },
      null,
      2,
    ),
  );
}
