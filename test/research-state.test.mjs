import test from "node:test";
import assert from "node:assert/strict";
import {
  createResearchProgress, remainingResearchMs, researchRoundBudget, researchReady,
  finishResearchAttempt, recoverResearchProgress, mergeResearch,
} from "../lib/research-state.mjs";

const mechanism = (id = "M01") => ({
  id, game: "fixture", platform_version: "fixture v1", retrieved_at: "2026-09-15",
  sources: [{ title: "fixture source", url: "https://example.com/rules", support: "old evidence", mode: "developer_described" }],
  gameplay: "fixture", rules: "old rule", controls: "tap", feedback: "changes",
  value_conditions: ["state persists"], relevance: "fixture", gaps: [],
});
const value = (m = mechanism(), gaps = []) => ({ summary: "fixture", mechanisms: [m], queries: [], gaps });

test("budget is sliced across remaining rounds and unused time rolls forward", () => {
  const p = createResearchProgress(1, 300000);
  assert.equal(researchRoundBudget(p), 100000);
  finishResearchAttempt(p, { budgetMs: 100000 }, 20000);
  p.nextRound = 2;
  assert.equal(remainingResearchMs(p), 280000);
  assert.equal(researchRoundBudget(p), 140000);
  p.nextRound = 4;
  assert.equal(researchRoundBudget(p), 0);
});
test("invalid budgets/round counts are rejected", () => {
  for (const b of [0, -1, NaN, Infinity, 1.1]) assert.throws(() => createResearchProgress(1, b));
  for (const n of [0, 4, 1.5]) assert.throws(() => createResearchProgress(1, 300000, n));
});
test("attempt time is charged exactly once, and timeouts consume their slice", () => {
  const p = createResearchProgress(1, 300000);
  const job = { budgetMs: 100000 };
  finishResearchAttempt(p, job, 0, true);
  finishResearchAttempt(p, job, 900000, true);
  assert.equal(p.activeElapsedMs, 100000);
  assert.equal(job.activeMs, 100000);
});
test("crash recovery conservatively reserves only the running slice, not downtime", () => {
  const p = createResearchProgress(1, 300000);
  p.activeElapsedMs = 20000;
  p.activeAttempt = { jobId: "running", budgetMs: 140000 };
  const run = { revision: 1, researchProgress: p, jobs: [{ id: "running" }] };
  recoverResearchProgress(run);
  recoverResearchProgress(run);
  assert.equal(p.activeElapsedMs, 160000);
  assert.equal(p.status, "interrupted");
  assert.equal(run.jobs[0].activeMsEstimated, true);
});
test("queued interruptions consume no budget", () => {
  const p = createResearchProgress(1, 300000);
  recoverResearchProgress({ revision: 1, researchProgress: p, jobs: [{ id: "q", status: "queued" }] });
  assert.equal(p.activeElapsedMs, 0);
});
test("evidence-backed same-ID corrections replace the record and preserve an audit trail", () => {
  const p = createResearchProgress(1, 300000);
  const first = mergeResearch(null, value(mechanism(), ["verify rule"]), p, { id: "a" });
  const correction = mechanism(); correction.rules = "corrected rule";
  correction.sources[0].support = "source specifically supports corrected rule";
  const second = mergeResearch(first, value(correction), p, { id: "b" });
  assert.equal(second.mechanisms[0].rules, "corrected rule");
  assert.equal(first.mechanisms[0].rules, "old rule");
  assert.equal(p.history[0].before.rules, "old rule");
  assert.equal(p.history[0].decision, "accepted");
  assert.equal(p.status, "completed");
});
test("unsupported changes remain conflicts even when the next response omits them", () => {
  const p = createResearchProgress(1, 300000);
  let r = mergeResearch(null, value(mechanism(), ["verify"]), p, { id: "a" });
  const changed = mechanism(); changed.rules = "unsupported rule";
  r = mergeResearch(r, value(changed), p, { id: "b" });
  r = mergeResearch(r, { summary: "no update", mechanisms: [], queries: [], gaps: [] }, p, { id: "c" });
  assert.equal(r.mechanisms[0].rules, "old rule");
  assert.match(r.gaps.join(), /冲突/);
  assert.equal(p.status, "partial");
});
test("updated evidence can resolve a previously blocked correction", () => {
  const p = createResearchProgress(1, 300000);
  let r = mergeResearch(null, value(mechanism(), ["verify"]), p, { id: "a" });
  const changed = mechanism(); changed.rules = "correct rule";
  r = mergeResearch(r, value(changed), p, { id: "b" });
  changed.sources[0].support = "new evidence";
  r = mergeResearch(r, value(changed), p, { id: "c" });
  assert.equal(r.mechanisms[0].rules, "correct rule");
  assert.deepEqual(r.gaps, []);
  assert.equal(p.status, "completed");
});
test("omitted mechanisms and their mechanism-level gaps survive merging", () => {
  const p = createResearchProgress(1, 300000);
  const m = mechanism(); m.gaps = ["unknown feedback"];
  let r = mergeResearch(null, value(m), p, { id: "a" });
  r = mergeResearch(r, value(mechanism("M02")), p, { id: "b" });
  assert.deepEqual(r.mechanisms.map((m) => m.id), ["M01", "M02"]);
  assert.match(r.gaps.join(), /unknown feedback/);
  assert.equal(p.status, "partial");
});
test("a timed-out checkpoint does not mark the research complete", () => {
  const p = createResearchProgress(1, 300000);
  const r = mergeResearch(null, value(), p, { id: "a", timeLimited: true });
  assert.equal(p.status, "partial");
  assert.equal(r.timeLimited, true);
  assert.ok(r.gaps.length);
});
test("queries deduplicate without losing distinct purposes", () => {
  const p = createResearchProgress(1, 300000);
  const v = value(); v.queries = [{ purpose: "rule", query: "fixture" }];
  let r = mergeResearch(null, v, p, { id: "a" });
  v.queries.push({ purpose: "feedback", query: "fixture" });
  r = mergeResearch(r, v, p, { id: "b" });
  assert.equal(r.queries.length, 2);
});
test("mechanism IDs cannot poison the conflict object's prototype", () => {
  const p = createResearchProgress(1, 300000);
  let r = mergeResearch(null, value(mechanism("__proto__")), p, { id: "a" });
  const changed = mechanism("__proto__"); changed.rules = "unsupported";
  r = mergeResearch(r, value(changed), p, { id: "b" });
  assert.equal(Object.getPrototypeOf(p.conflicts), null);
  assert.ok(r.gaps.some((g) => g.includes("__proto__")));
});
test("readiness distinguishes legacy, partial, completed, stale and explicit-reuse records", () => {
  const r = { revision: 1, research: { revision: 1, mechanisms: [mechanism()] } };
  assert.equal(researchReady(r), true);
  r.researchProgress = createResearchProgress(1, 300000);
  assert.equal(researchReady(r), false);
  r.researchProgress.status = "completed";
  assert.equal(researchReady(r), true);
  r.researchProgress.revision = 0;
  assert.equal(researchReady(r), false);
  r.reuseResearchOnly = true;
  assert.equal(researchReady(r), true);
  r.research.revision = 0;
  assert.equal(researchReady(r), false);
});

test("JSON property ordering alone cannot create an evidence conflict", () => {
  const p = createResearchProgress(1, 300000);
  let r = mergeResearch(null, value(mechanism(), ["verify"]), p, { id: "a" });
  const reordered = Object.fromEntries(Object.entries(mechanism()).reverse());
  r = mergeResearch(r, value(reordered), p, { id: "b" });
  assert.deepEqual(r.gaps, []);
  assert.equal(p.status, "completed");
});
