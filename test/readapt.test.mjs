import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Manager } from "../lib/manager.mjs";
import { ROOT } from "../server.mjs";
import { result } from "./fixtures.mjs";

test("checkpoint adaptation preserves inputs and originals, loads new skill, and never repeats research", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readapt-test-"));
  const vendor = path.join(dir, "vendor");
  fs.cpSync(path.join(ROOT, "vendor/skills"), vendor, { recursive: true });
  const calls = [];
  let fail = false;
  const m = new Manager({ dataDir: path.join(dir, "runs"), vendor,
    runner: async (args) => {
      calls.push(args);
      if (args.stage === "analysis") {
        fs.writeFileSync(path.join(args.dir, "material.txt"), "original material");
      }
      if (args.ctx.reuseResearchOnly && fail) throw Error("test failure");
      return result(args);
    } });
  t.after(async () => { await m.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { id } = m.create({ meme: "独立样本" });
  await m.idle(id);
  assert.throws(() => m.readapt(id), /断点/);
  m.confirm(id, { revision: 1, branchId: "B01", count: 1 });
  await m.idle(id);
  const source = m.get(id);
  const original = fs.readFileSync(path.join(m.folder(source), "run.json"));
  const skill = path.join(vendor, "meme-mechanism-adaptation/SKILL.md");
  fs.appendFileSync(skill, "\n新的独立规则标记\n");
  calls.length = 0;
  const fork = m.readapt(id);
  await m.idle(fork.id);
  const r = m.get(fork.id);
  assert.equal(r.status, "completed");
  assert.deepEqual(calls.map(c => c.stage), ["adaptation"]);
  assert.equal(calls[0].allowSearch, false);
  assert.deepEqual(calls[0].ctx.confirmed, source.confirmed);
  assert.deepEqual(calls[0].ctx.research, source.research);
  assert.deepEqual(calls[0].ctx.assets, source.assets);
  assert.equal(calls[0].ctx.result, undefined);
  assert.equal(calls[0].ctx.previousAnalysis, undefined);
  assert.equal(calls[0].ctx.count, source.count);
  assert.match(calls[0].prompt, /新的独立规则标记/);
  assert.ok(!calls[0].prompt.includes("只做格式完整的设计"));
  assert.deepEqual(fs.readFileSync(path.join(m.folder(source), "run.json")), original);
  for (const j of source.jobs.filter(j => j.stage === "adaptation"))
    assert.equal(fs.existsSync(path.join(m.folder(r), "work", j.id)), false);
  const analysisJob = r.jobs.find(j => j.stage === "analysis");
  assert.equal(fs.readFileSync(path.join(m.folder(r), "work", analysisJob.id, "material.txt"), "utf8"), "original material");
  fail = true;
  const failed = m.readapt(id);
  await m.idle(failed.id);
  assert.equal(m.get(failed.id).status, "failed");
  fail = false;
  m.retry(failed.id);
  await m.idle(failed.id);
  assert.equal(m.get(failed.id).status, "completed");
  assert.ok(calls.every(c => c.stage === "adaptation" && c.allowSearch === false));
  m.get(failed.id).research = null;
  assert.throws(() => m.generate(m.get(failed.id)), /不能自动重新调研/);
  source.research.revision = 0;
  assert.throws(() => m.readapt(id), /断点/);
});
