import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "../lib/pool.mjs";
import { Manager } from "../lib/manager.mjs";
import { createApp, ROOT } from "../server.mjs";
import { result } from "./fixtures.mjs";

function harness(t, runner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-test-"));
  const manager = new Manager({
    dataDir: dir,
    vendor: path.join(ROOT, "vendor", "skills"),
    runner: runner || (async (args) => result(args)),
  });
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return manager;
}
const confirmation = (r) => ({
  revision: r.revision,
  branchId: "B01",
  count: 7,
  notes: "",
});

test("pool limits simultaneous work to 3, removes queued cancellations, releases failed slots", async () => {
  const pool = new Pool(3);
  let active = 0,
    peak = 0,
    started = [];
  const jobs = Array.from({ length: 8 }, (_, i) =>
    pool.run(async () => {
      started.push(i);
      active++;
      peak = Math.max(active, peak);
      await delay(15);
      active--;
      if (i === 1) throw Error("expected failure");
      return i;
    }),
  );
  const c = new AbortController();
  const cancelled = pool.run(() => {
    throw Error("must not start");
  }, c.signal);
  c.abort();
  await assert.rejects(cancelled, /取消/);
  const done = await Promise.allSettled(jobs);
  await delay(0);
  assert.equal(peak, 3);
  assert.equal(pool.peak, 3);
  assert.equal(started.length, 8);
  assert.equal(done.filter((x) => x.status === "rejected").length, 1);
  assert.deepEqual(pool.stats, { limit: 3, active: 0, queued: 0 });
});

test("confirmation is mandatory, revision checked, x is an upper bound, workers share the same research", async (t) => {
  const calls = [];
  const m = harness(t, async (args) => {
    calls.push(args);
    await delay(10);
    return result(args);
  });
  const first = m.create({ meme: "测试梗" });
  assert.throws(() => m.confirm(first.id, confirmation(first)), /第一步/);
  await m.idle(first.id);
  const r = m.get(first.id);
  assert.equal(r.status, "awaiting_confirmation");
  assert.deepEqual(
    calls.map((c) => c.stage),
    ["analysis"],
  );
  assert.throws(
    () => m.confirm(r.id, { ...confirmation(r), revision: 0 }),
    /更新/,
  );
  for (const count of [0, 51, 2.5, "3"])
    assert.throws(() => m.confirm(r.id, { ...confirmation(r), count }), /整数/);
  assert.throws(
    () => m.confirm(r.id, { ...confirmation(r), branchId: "wrong" }),
    /分支/,
  );
  m.confirm(r.id, confirmation(r));
  assert.throws(() => m.confirm(r.id, confirmation(r)), /第一步/);
  await m.idle(r.id);
  assert.equal(r.status, "completed");
  assert.equal(r.result.candidates.length, 7);
  assert.equal(calls.filter((c) => c.stage === "research").length, 1);
  const workers = calls.filter((c) => c.stage === "adaptation");
  assert.equal(workers.length, 1);
  assert.equal(workers[0].ctx.count, 7);
  assert.deepEqual(
    calls.map((c) => c.stage),
    ["analysis", "research", "adaptation"],
  );
  assert.equal(m.pool.peak, 1);
  assert.equal(r.workflowVersion, 3);
  for (const c of calls) {
    assert.deepEqual(fs.readdirSync(path.join(c.dir, ".agents", "skills")), [
      {
        analysis: "meme-asset-extract",
        research: "game-mechanism-research",
        adaptation: "meme-mechanism-adaptation",
      }[c.stage],
    ]);
  }
  assert.ok(
    calls
      .filter((c) => c.stage !== "analysis")
      .every(
        (c) =>
          c.ctx.confirmed.branch.interesting_moment ===
          r.analysis.branches[0].interesting_moment,
      ),
  );
  m.revise(r.id, { correction: "目标传播版本弄错了" });
  assert.equal(r.confirmed, null);
  assert.equal(r.result, null);
  await m.idle(r.id);
  assert.equal(r.status, "awaiting_confirmation");
  assert.equal(r.revision, 2);
});

test("multiple runs share one concurrency ceiling", async (t) => {
  let active = 0,
    peak = 0;
  const m = harness(t, async (args) => {
    active++;
    peak = Math.max(active, peak);
    await delay(10);
    active--;
    return result(args);
  });
  const runs = Array.from({ length: 5 }, (_, i) =>
    m.create({ meme: "梗" + i }),
  );
  await Promise.all(runs.map((r) => m.idle(r.id)));
  for (const r of runs)
    m.confirm(r.id, { ...confirmation(m.get(r.id)), count: 4 });
  await Promise.all(runs.map((r) => m.idle(r.id)));
  assert.equal(peak, 3);
  assert.ok(runs.every((r) => m.get(r.id).result.candidates.length === 4));
});

test("malformed or wrong-count CLI results fail visibly; retry uses the confirmed branch", async (t) => {
  let fault = "schema";
  const m = harness(t, async (args) => {
    if (args.stage === "analysis" && fault === "schema") return {};
    const r = result(args);
    if (args.stage === "adaptation" && fault === "count") r.candidates.pop();
    return r;
  });
  const run = m.create({ meme: "梗" });
  await m.idle(run.id);
  assert.equal(m.get(run.id).status, "failed");
  assert.match(m.get(run.id).error, /格式/);
  fault = "count";
  m.retry(run.id);
  await m.idle(run.id);
  m.confirm(run.id, { ...confirmation(m.get(run.id)), count: 2 });
  await m.idle(run.id);
  assert.equal(m.get(run.id).status, "failed");
  assert.match(m.get(run.id).error, /数量/);
  const confirmed = m.get(run.id).confirmed;
  fault = "none";
  m.retry(run.id);
  await m.idle(run.id);
  assert.equal(m.get(run.id).status, "completed");
  assert.deepEqual(m.get(run.id).confirmed, confirmed);
});

test("cancel aborts running and queued jobs; interrupted runs are restored without rerunning", async (t) => {
  const m = harness(t, async ({ signal, ...args }) => {
    await delay(50, null, { signal });
    return result(args);
  });
  const runs = Array.from({ length: 4 }, (_, i) =>
    m.create({ meme: "梗" + i }),
  );
  m.cancel(runs[3].id);
  m.cancel(runs[0].id);
  await Promise.all(runs.map((r) => m.idle(r.id)));
  assert.equal(m.get(runs[3].id).status, "cancelled");
  assert.equal(m.get(runs[0].id).status, "cancelled");
  const r = m.get(runs[1].id);
  r.status = "generating";
  m.save(r);
  const restored = new Manager({
    dataDir: m.dataDir,
    vendor: m.vendor,
    runner: () => {
      throw Error("must not run");
    },
  });
  assert.equal(restored.get(r.id).status, "interrupted");
  assert.equal(restored.pool.stats.active, 0);
});

test("HTTP boundaries, exact export and media traversal protection", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-http-"));
  const { server, manager } = createApp({
    dataDir: dir,
    runner: async (args) => result(args),
    info: { available: true, loggedIn: true, version: "test" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await manager.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const meta = await (await fetch(base + "/api/meta")).json();
  const post = (url, data, headers = {}) =>
    fetch(base + url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meme-token": meta.token,
        ...headers,
      },
      body: JSON.stringify(data),
    });
  assert.equal(
    (await post("/api/runs", { meme: "梗" }, { "x-meme-token": "wrong" }))
      .status,
    403,
  );
  assert.equal(
    (
      await post(
        "/api/runs",
        { meme: "梗" },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const foreignHost = await new Promise((resolve, reject) => {
    http
      .get(base + "/api/meta", { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await post("/api/runs", null)).status, 400);
  const create = await post("/api/runs", { meme: "梗" });
  assert.equal(create.status, 201);
  const r = await create.json();
  await manager.idle(r.id);
  const confirmed = await post(`/api/runs/${r.id}/confirm`, {
    ...confirmation(manager.get(r.id)),
    count: 2,
  });
  assert.equal(confirmed.status, 200);
  await manager.idle(r.id);
  const exp = await fetch(`${base}/api/runs/${r.id}/export?format=json`);
  assert.equal(exp.status, 200);
  assert.equal((await exp.json()).result.candidates.length, 2);
  assert.equal(
    (await fetch(`${base}/api/runs/${r.id}/media?path=../../private.png`))
      .status,
    403,
  );
  const work = path.join(dir, r.id, "work");
  const outside = path.join(dir, "outside.png");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(work, "link.png"));
  assert.equal(
    (await fetch(`${base}/api/runs/${r.id}/media?path=link.png`)).status,
    403,
  );
  fs.writeFileSync(path.join(work, "sample.png"), "abcde");
  const media = await fetch(`${base}/api/runs/${r.id}/media?path=sample.png`, {
    headers: { range: "bytes=1-3" },
  });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), "bcd");
  assert.match(
    (await fetch(base)).headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
});

test("timeout salvages only complete valid checkpoint from this attempt; empty and invalid stop adaptation", async (t) => {
  for (const mode of ["valid", "empty", "invalid", "none"]) {
    const calls = [];
    const m = harness(t, async (args) => {
      calls.push(args.stage);
      args.onStart?.();
      if (args.stage === "research") {
        assert.equal(args.timeoutMs, 300000);
        let record = result(args);
        if (mode === "empty") record.mechanisms = [];
        if (mode === "invalid") record.mechanisms[0].sources[0].url = "fake";
        if (mode !== "none")
          fs.writeFileSync(
            path.join(args.dir, "research-checkpoint.json"),
            JSON.stringify(record),
          );
        throw Object.assign(Error("timeout"), { code: "STAGE_TIMEOUT" });
      }
      return result(args);
    });
    const { id } = m.create({ meme: "超时恢复" });
    await m.idle(id);
    m.confirm(id, confirmation(m.get(id)));
    await m.idle(id);
    const r = m.get(id);
    assert.equal(r.status, mode === "valid" ? "completed" : "failed", r.error);
    assert.equal(calls.includes("adaptation"), mode === "valid");
    if (mode === "valid") assert.equal(r.research.timeLimited, true);
  }
});
test("adaptation retry reuses same research; correction invalidates it", async (t) => {
  let fail = true;
  const calls = [];
  const m = harness(t, async (args) => {
    calls.push(args.stage);
    if (args.stage === "adaptation" && fail) throw Error("failure");
    return result(args);
  });
  const { id } = m.create({ meme: "重试" });
  await m.idle(id);
  m.confirm(id, confirmation(m.get(id)));
  await m.idle(id);
  const research = structuredClone(m.get(id).research);
  fail = false;
  m.retry(id);
  await m.idle(id);
  assert.equal(m.get(id).status, "completed");
  assert.deepEqual(m.get(id).research, research);
  assert.equal(calls.filter((s) => s === "research").length, 1);
  m.revise(id, { correction: "另一个版本" });
  assert.equal(m.get(id).research, null);
  await m.idle(id);
  m.confirm(id, confirmation(m.get(id)));
  await m.idle(id);
  assert.equal(calls.filter((s) => s === "research").length, 2);
});
test("assets are registered from real files and referenced across stages; missing paths stay gaps", async (t) => {
  const m = harness(t, async (args) => {
    const r = result(args);
    if (args.stage === "analysis") {
      fs.writeFileSync(path.join(args.dir, "audio.wav"), "RIFFfixture");
      r.branches[0].media = [
        {
          path: "audio.wav",
          caption: "原声",
          source_url: "https://example.com/media",
          start_s: 1,
          end_s: 3,
        },
        {
          path: "missing.mp4",
          caption: "未取得",
          source_url: null,
          start_s: null,
          end_s: null,
        },
      ];
    }
    return r;
  });
  const { id } = m.create({ meme: "素材" });
  await m.idle(id);
  const r = m.get(id);
  assert.equal(r.assets.length, 1);
  assert.ok(r.analysis.branches[0].gaps.some((g) => g.includes("missing.mp4")));
  m.confirm(id, confirmation(r));
  await m.idle(id);
  assert.equal(r.status, "completed", r.error);
  assert.equal(r.result.candidates[0].media_usage[0].asset_id, r.assets[0].id);
});
test("legacy snapshots remain unmodified and cannot be retried in v3", async (t) => {
  const m = harness(t);
  const { id } = m.create({ meme: "历史" });
  await m.idle(id);
  const r = m.get(id);
  r.workflowVersion = 2;
  r.status = "generating";
  m.save(r);
  const file = path.join(m.folder(r), "run.json"),
    before = fs.readFileSync(file, "utf8");
  const restored = new Manager({
    dataDir: m.dataDir,
    vendor: m.vendor,
    runner: () => {
      throw Error("must not run");
    },
  });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.throws(() => restored.revise(id, { correction: "重做" }), /历史任务/);
});

test("queued research has no startedAt or budget consumption until a CLI slot opens", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let block = false;
  const m = harness(t, async (args) => {
    args.onStart?.();
    if (block && args.stage === "research") await gate;
    return result(args);
  });
  const runs = Array.from({ length: 4 }, () => m.create({ meme: "队列" }));
  await Promise.all(runs.map((r) => m.idle(r.id)));
  block = true;
  for (const r of runs) m.confirm(r.id, confirmation(m.get(r.id)));
  await delay(10);
  const queued = m.get(runs[3].id).jobs.at(-1);
  assert.equal(queued.status, "queued");
  assert.equal(queued.startedAt, undefined);
  assert.equal(queued.budgetMs, undefined);
  release();
  await Promise.all(runs.map((r) => m.idle(r.id)));
  assert.equal(queued.status, "completed");
  assert.ok(queued.startedAt);
  assert.equal(queued.budgetMs, 300000);
});
test("v3 media IDs support Range and both exports contain compact fields; unknown and deleted media are 404", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-media-"));
  const { server, manager } = createApp({
    dataDir: dir,
    info: { available: true, loggedIn: true },
    runner: async (args) => {
      const r = result(args);
      if (args.stage === "analysis") {
        fs.writeFileSync(path.join(args.dir, "sample.wav"), "RIFFabcde");
        r.branches[0].media = [
          {
            path: "sample.wav",
            caption: "音频",
            source_url: null,
            start_s: null,
            end_s: null,
          },
        ];
      }
      return r;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await manager.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { id } = manager.create({ meme: "完整输出" });
  await manager.idle(id);
  manager.confirm(id, confirmation(manager.get(id)));
  await manager.idle(id);
  const r = manager.get(id),
    base = `http://127.0.0.1:${server.address().port}/api/runs/${id}`,
    url = base + "/media?assetId=" + r.assets[0].id;
  const response = await fetch(url, { headers: { range: "bytes=4-6" } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "abc");
  const md = await (await fetch(base + "/export")).text();
  for (const field of [
    "玩法与简单规则",
    "素材使用",
    "梗的趣味",
    "参考",
  ])
    assert.ok(md.includes("### " + field));
  for (const removed of ["一句话玩法", "必要规则", "玩家操控方式", "最小实现"])
    assert.ok(!md.includes("### " + removed));
  assert.ok(md.includes(r.assets[0].id));
  const json = await (await fetch(base + "/export?format=json")).json();
  assert.deepEqual(json.result, r.result);
  assert.equal((await fetch(base + "/media?assetId=unknown")).status, 404);
  fs.unlinkSync(
    path.join(
      manager.folder(r),
      "work",
      r.assets[0].jobId,
      r.assets[0].relativePath,
    ),
  );
  assert.equal((await fetch(url)).status, 404);
});
test("invalid mechanism and asset references fail without content-quality filtering", async (t) => {
  for (const fault of ["mechanism", "asset"]) {
    const m = harness(t, async (args) => {
      const r = result(args);
      if (args.stage === "adaptation") {
        if (fault === "mechanism")
          r.candidates[0].references[0].mechanism_id = "unknown";
        else
          r.candidates[0].media_usage = [
            {
              status: "used",
              asset_id: "invented",
              where: "结果",
              interaction: "播放",
              note: "",
            },
          ];
      }
      return r;
    });
    const { id } = m.create({ meme: "引用检查" });
    await m.idle(id);
    m.confirm(id, confirmation(m.get(id)));
    await m.idle(id);
    assert.equal(m.get(id).status, "failed");
    assert.match(m.get(id).error, /引用/);
  }
});

test("changing installed skills during a run does not change its stage snapshot", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-snapshot-")),
    vendor = path.join(dir, "vendor");
  fs.cpSync(path.join(ROOT, "vendor/skills"), vendor, { recursive: true });
  const calls = [];
  const m = new Manager({
    dataDir: path.join(dir, "data"),
    vendor,
    runner: async (args) => {
      calls.push(args);
      return result(args);
    },
  });
  t.after(async () => {
    await m.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { id } = m.create({ meme: "固定快照" });
  await m.idle(id);
  const r = m.get(id),
    before = structuredClone(r.skillSnapshot);
  fs.appendFileSync(
    path.join(vendor, "game-mechanism-research/SKILL.md"),
    "\nTHIS_IS_A_LATER_VERSION\n",
  );
  m.confirm(id, confirmation(r));
  await m.idle(id);
  assert.equal(r.status, "completed");
  assert.ok(
    !calls
      .find((c) => c.stage === "research")
      .prompt.includes("THIS_IS_A_LATER_VERSION"),
  );
  assert.deepEqual(r.skillSnapshot, before);
});
