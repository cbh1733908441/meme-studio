import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Manager } from "../lib/manager.mjs";
import { result } from "./fixtures.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function harness(t, runner, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-regression-"));
  const m = new Manager({ dataDir, vendor: path.join(root, "vendor/skills"), runner, ...options });
  t.after(async () => { await m.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return m;
}
async function start(m) {
  const { id } = m.create({ meme: "fixture only; no network" });
  await m.idle(id);
  assert.equal(m.get(id).status, "awaiting_confirmation");
  return id;
}
const confirm = (m, id) => m.confirm(id, { revision: m.get(id).revision, branchId: "B01", count: 1 });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("later evidence correction reaches adaptation instead of being deduplicated away", async (t) => {
  let round = 0, adapted;
  const m = harness(t, async (args) => {
    args.onStart();
    const v = result(args);
    if (args.stage === "research") {
      round++;
      v.mechanisms[0].rules = round === 1 ? "OLD" : "CORRECTED";
      v.mechanisms[0].sources[0].support = round === 1 ? "initial evidence" : "corrected source evidence";
      v.gaps = round === 1 ? ["verify rule"] : [];
    } else if (args.stage === "adaptation") adapted = structuredClone(args.ctx.research);
    return v;
  });
  const id = await start(m); confirm(m, id); await m.idle(id);
  assert.equal(m.get(id).status, "completed", m.get(id).error);
  assert.equal(round, 2);
  assert.equal(adapted.mechanisms[0].rules, "CORRECTED");
  assert.equal(m.get(id).researchProgress.history[0].before.rules, "OLD");
});

test("failed second round retries that round before adapting, retaining prior results and budget", async (t) => {
  let calls = 0, adaptations = 0, clock = 0;
  const rounds = [];
  const m = harness(t, async (args) => {
    args.onStart(); const v = result(args);
    if (args.stage === "research") {
      calls++; rounds.push(args.ctx.research_state.round); clock += 10000;
      if (calls === 2) throw Error("injected failure");
      if (calls === 3) assert.equal(args.ctx.research_state.previous.mechanisms[0].id, "M01");
      v.gaps = calls === 1 ? ["needs evidence"] : [];
    } else if (args.stage === "adaptation") adaptations++;
    return v;
  }, { now: () => clock });
  const id = await start(m); confirm(m, id); await m.idle(id);
  assert.equal(m.get(id).status, "failed");
  assert.equal(m.get(id).research.roundsCompleted, 1);
  assert.equal(adaptations, 0);
  m.retry(id); await m.idle(id);
  assert.deepEqual(rounds, [1, 2, 2]);
  assert.equal(m.get(id).status, "completed", m.get(id).error);
  assert.equal(m.get(id).researchProgress.activeElapsedMs, 30000);
  assert.equal(adaptations, 1);
});

test("290 seconds queued plus 40 seconds executing consumes only 40 seconds", async (t) => {
  let clock = 0, rounds = 0;
  const m = harness(t, async (args) => {
    args.onStart(); const v = result(args);
    if (args.stage === "research") { clock += 20000; v.gaps = ++rounds === 1 ? ["more"] : []; }
    return v;
  }, { limit: 1, now: () => clock });
  const id = await start(m);
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const occupied = m.pool.run(() => gate);
  confirm(m, id); await tick();
  assert.equal(m.get(id).jobs.at(-1).status, "queued");
  assert.equal(m.get(id).researchProgress.activeElapsedMs, 0);
  clock += 290000; release(); await occupied; await m.idle(id);
  assert.equal(rounds, 2);
  assert.equal(m.get(id).researchProgress.activeElapsedMs, 40000);
  assert.equal(m.get(id).status, "completed", m.get(id).error);
});

test("round exhaustion stops automatic adaptation; existing explicit readapt accepts partial without changing source", async (t) => {
  let researchCalls = 0, adaptationCalls = 0;
  const m = harness(t, async (args) => {
    args.onStart(); const v = result(args);
    if (args.stage === "research") { researchCalls++; v.gaps = ["unresolved evidence"]; }
    if (args.stage === "adaptation") { adaptationCalls++; assert.equal(args.allowSearch, false); }
    return v;
  });
  const id = await start(m); confirm(m, id); await m.idle(id);
  const source = m.get(id);
  assert.equal(source.status, "failed");
  assert.equal(source.researchProgress.status, "exhausted");
  assert.equal(researchCalls, 3); assert.equal(adaptationCalls, 0);
  m.retry(id); await m.idle(id); assert.equal(researchCalls, 3);
  const before = fs.readFileSync(path.join(m.folder(source), "run.json"));
  const fork = m.readapt(id); await m.idle(fork.id);
  assert.equal(m.get(fork.id).status, "completed", m.get(fork.id).error);
  assert.equal(m.get(fork.id).checkpoint.acceptedPartialResearch, true);
  assert.deepEqual(m.get(fork.id).research.gaps, ["unresolved evidence"]);
  assert.equal(m.get(fork.id).jobs.filter((j) => j.stage === "research").length, 3);
  assert.deepEqual(fs.readFileSync(path.join(m.folder(source), "run.json")), before);
  assert.equal(researchCalls, 3); assert.equal(adaptationCalls, 1);
});

test("unsupported corrections cannot silently overwrite evidence or clear conflicts", async (t) => {
  let rounds = 0;
  const m = harness(t, async (args) => {
    const v = result(args);
    if (args.stage === "research") {
      v.mechanisms[0].rules = ++rounds === 1 ? "OLD" : "UNSUPPORTED";
      v.gaps = rounds === 1 ? ["verify"] : [];
    }
    return v;
  });
  const id = await start(m); confirm(m, id); await m.idle(id);
  assert.equal(m.get(id).status, "failed");
  assert.equal(m.get(id).research.mechanisms[0].rules, "OLD");
  assert.match(m.get(id).research.gaps.join(), /冲突/);
  assert.equal(m.get(id).jobs.some((j) => j.stage === "adaptation"), false);
});

test("mechanism-level gaps prevent completion even when top-level gaps are empty", async (t) => {
  const m = harness(t, async (args) => {
    const v = result(args);
    if (args.stage === "research") v.mechanisms[0].gaps = ["unknown feedback"];
    return v;
  });
  const id = await start(m); confirm(m, id); await m.idle(id);
  assert.equal(m.get(id).status, "failed");
  assert.match(m.get(id).research.gaps.join(), /unknown feedback/);
});

test("cancelled queued research spends zero budget and is resumable", async (t) => {
  const m = harness(t, async (args) => { args.onStart(); return result(args); }, { limit: 1, now: () => 0 });
  const id = await start(m);
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const occupied = m.pool.run(() => gate);
  confirm(m, id); await tick(); m.cancel(id); await m.idle(id);
  assert.equal(m.get(id).status, "cancelled");
  assert.equal(m.get(id).researchProgress.activeElapsedMs, 0);
  assert.equal(m.get(id).researchProgress.nextRound, 1);
  release(); await occupied; m.retry(id); await m.idle(id);
  assert.equal(m.get(id).status, "completed", m.get(id).error);
});

test("cancelling running round two keeps first round and charges its actual runtime", async (t) => {
  let clock = 0, calls = 0, reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const m = harness(t, async (args) => {
    args.onStart(); const v = result(args);
    if (args.stage === "research") {
      calls++; clock += 10000;
      if (calls === 1) v.gaps = ["more"];
      if (calls === 2) { reached(); await delay(100000, null, { signal: args.signal }); }
    }
    return v;
  }, { now: () => clock });
  const id = await start(m); confirm(m, id); await started; m.cancel(id); await m.idle(id);
  assert.equal(m.get(id).status, "cancelled");
  assert.equal(m.get(id).research.roundsCompleted, 1);
  assert.equal(m.get(id).researchProgress.activeElapsedMs, 20000);
  m.retry(id); await m.idle(id);
  assert.equal(calls, 3);
  assert.equal(m.get(id).status, "completed", m.get(id).error);
});

test("a valid timeout checkpoint continues to another round instead of adapting immediately", async (t) => {
  let calls = 0;
  const m = harness(t, async (args) => {
    args.onStart(); const v = result(args);
    if (args.stage === "research" && ++calls === 1) {
      fs.writeFileSync(path.join(args.dir, "research-checkpoint.json"), JSON.stringify(v));
      throw Object.assign(Error("timeout"), { code: "STAGE_TIMEOUT" });
    }
    return v;
  }, { now: () => 0 });
  const id = await start(m); confirm(m, id); await m.idle(id);
  assert.equal(calls, 2);
  assert.equal(m.get(id).status, "completed", m.get(id).error);
  assert.equal(m.get(id).researchProgress.activeElapsedMs, 100000);
  assert.equal(m.get(id).research.timeLimited, true);
});

test("all-timeout checkpoints exhaust the shared budget; retry cannot reset it", async (t) => {
  let calls = 0;
  const m = harness(t, async (args) => {
    args.onStart(); const v = result(args);
    if (args.stage === "research") {
      calls++; fs.writeFileSync(path.join(args.dir, "research-checkpoint.json"), JSON.stringify(v));
      throw Object.assign(Error("timeout"), { code: "STAGE_TIMEOUT" });
    }
    return v;
  }, { now: () => 0 });
  const id = await start(m); confirm(m, id); await m.idle(id);
  assert.equal(calls, 3);
  assert.equal(m.get(id).researchProgress.activeElapsedMs, 300000);
  assert.equal(m.get(id).researchProgress.stopReason, "budget");
  m.retry(id); await m.idle(id);
  assert.equal(calls, 3);
  assert.equal(m.get(id).status, "failed");
});

test("invalid second-round output remains a failed job and cannot overwrite saved research", async (t) => {
  let calls = 0;
  const m = harness(t, async (args) => {
    const v = result(args);
    if (args.stage === "research") {
      calls++; v.gaps = calls === 1 ? ["more"] : [];
      if (calls === 2) v.mechanisms[0].sources[0].url = "invalid";
    }
    return v;
  });
  const id = await start(m); confirm(m, id); await m.idle(id);
  assert.equal(m.get(id).status, "failed");
  assert.equal(m.get(id).research.roundsCompleted, 1);
  assert.equal(m.get(id).jobs.at(-1).status, "failed");
  m.retry(id); await m.idle(id);
  assert.equal(m.get(id).status, "completed", m.get(id).error);
});

test("restart restores round two without auto-running or counting server downtime", async (t) => {
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "research-crash-"));
  t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
  let clock = 0, calls = 0;
  const m = harness(t, async (args) => {
    args.onStart(); const v = result(args);
    if (args.stage === "research") {
      calls++;
      if (calls === 1) { clock += 20000; v.gaps = ["more"]; }
      else { fs.cpSync(m.dataDir, backup, { recursive: true }); throw Error("crash snapshot taken"); }
    }
    return v;
  }, { now: () => clock });
  const id = await start(m); confirm(m, id); await m.idle(id);
  let resumedCalls = 0;
  const restored = new Manager({ dataDir: backup, vendor: m.vendor, now: () => 999999999,
    runner: async (args) => {
      args.onStart(); resumedCalls++;
      if (args.stage === "research") assert.equal(args.ctx.research_state.round, 2);
      return result(args);
    } });
  t.after(() => restored.stop());
  assert.equal(resumedCalls, 0);
  assert.equal(restored.get(id).status, "interrupted");
  assert.equal(restored.get(id).researchProgress.activeElapsedMs, 160000);
  restored.retry(id); await restored.idle(id);
  assert.equal(restored.get(id).status, "completed", restored.get(id).error);
  assert.equal(restored.get(id).researchProgress.activeElapsedMs, 160000);
});

test("pre-upgrade v3 completed research is reused unchanged; correction resets new progress", async (t) => {
  let calls = 0;
  const m = harness(t, async (args) => { if (args.stage === "research") calls++; return result(args); });
  const id = await start(m); confirm(m, id); await m.idle(id);
  const r = m.get(id); delete r.researchProgress;
  r.status = "failed"; r.lastAction = "generation";
  const original = JSON.stringify(r.research);
  m.retry(id); await m.idle(id);
  assert.equal(calls, 1); assert.equal(JSON.stringify(r.research), original);
  m.revise(id, { correction: "new version" });
  assert.equal(r.research, null); assert.equal(r.researchProgress, null);
  await m.idle(id); confirm(m, id); await m.idle(id);
  assert.equal(calls, 2); assert.equal(r.researchProgress.revision, 2);
});
