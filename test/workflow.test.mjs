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
  const workers = calls.filter((c) => c.stage === "draft");
  assert.equal(workers.length, 3);
  assert.deepEqual(
    workers.flatMap((w) => w.ctx.assigned_ids).sort(),
    Array.from({ length: 7 }, (_, i) => "T0" + (i + 1)),
  );
  assert.ok(workers.every((w) => w.ctx.research === workers[0].ctx.research));
  assert.equal(m.pool.peak, 3);
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
    if (args.stage === "audit" && fault === "count") r.candidates.pop();
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

test("research may return fewer directions or none; hypothesis-only work never spawns writers", async (t) => {
  for (const remaining of [0, 1]) {
    const stages = [];
    const m = harness(t, async (args) => {
      stages.push(args.stage);
      const data = result(args);
      if (args.stage === "research") {
        data.directions = data.directions.slice(0, remaining + 1);
        data.directions.at(-1).status = "hypothesis_only";
        data.directions.at(-1).added_hypotheses = ["操作收益没有依据"];
      }
      return data;
    });
    const { id } = m.create({ meme: "保留案例" });
    await m.idle(id);
    m.confirm(id, { ...confirmation(m.get(id)), count: 4 });
    await m.idle(id);
    const r = m.get(id);
    assert.equal(r.status, "completed", r.error);
    assert.equal(r.result.candidates.length, remaining);
    assert.equal(stages.filter((s) => s === "draft").length, remaining);
    assert.equal(stages.includes("audit"), remaining > 0);
    assert.equal(r.result.rejected.length, 1);
    assert.ok(r.result.shortfall_reason);
  }
});

test("draft and audit rejections persist separately, including zero accepted candidates", async (t) => {
  for (const rejectAt of ["draft", "audit"]) {
    const m = harness(t, async (args) => {
      const data = result(args);
      if (args.stage === rejectAt) {
        data.rejected = data.candidates.map((c) => ({
          id: c.id,
          title: c.title,
          reason: "操作没有延续素材趣味",
        }));
        data.candidates = [];
      }
      return data;
    });
    const { id } = m.create({ meme: "保留案例" });
    await m.idle(id);
    m.confirm(id, { ...confirmation(m.get(id)), count: 3 });
    await m.idle(id);
    const r = m.get(id);
    assert.equal(r.status, "completed", r.error);
    assert.equal(r.result.candidates.length, 0);
    assert.equal(r.result.rejected.length, 3);
    assert.ok(r.result.shortfall_reason);
  }
});

test("audit can retain one and reject others; weak statuses cannot leak to candidate cards", async (t) => {
  const m = harness(t, async (args) => {
    const data = result(args);
    if (args.stage === "draft" && data.candidates[0].id === "T01")
      data.candidates[0].status = "needs_evidence";
    if (args.stage === "audit") {
      const c = data.candidates.pop();
      data.rejected.push({
        id: c.id,
        title: c.title,
        reason: "与另一方案重复",
      });
    }
    return data;
  });
  const { id } = m.create({ meme: "保留案例" });
  await m.idle(id);
  m.confirm(id, { ...confirmation(m.get(id)), count: 3 });
  await m.idle(id);
  const r = m.get(id);
  assert.equal(r.status, "completed", r.error);
  assert.equal(r.result.candidates.length, 1);
  assert.deepEqual(r.result.rejected.map((x) => x.id).sort(), ["T01", "T03"]);
});

test("unknown or duplicate direction IDs fail; legacy snapshots cannot be reused with new schemas", async (t) => {
  const m = harness(t, async (args) => {
    const data = result(args);
    if (args.stage === "research") data.directions[0].id = "T99";
    return data;
  });
  const { id } = m.create({ meme: "保留案例" });
  await m.idle(id);
  m.confirm(id, { ...confirmation(m.get(id)), count: 2 });
  await m.idle(id);
  const r = m.get(id);
  assert.equal(r.status, "failed");
  assert.match(r.error, /编号/);
  delete r.workflowVersion;
  assert.throws(() => m.retry(id), /历史任务/);
  assert.throws(() => m.revise(id, { correction: "重做" }), /历史任务/);
});
