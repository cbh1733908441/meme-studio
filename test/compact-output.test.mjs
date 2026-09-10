import test from "node:test";
import assert from "node:assert/strict";
import { checkAdaptation, legacyAdaptationSchema } from "../lib/schemas.mjs";
import { markdown } from "../server.mjs";
import { result } from "./fixtures.mjs";

test("compact output accepts 150 characters, rejects 151 and removed fields", () => {
  const research = result({ stage: "research", ctx: {} });
  const value = result({ stage: "adaptation", ctx: { count: 1, assets: [] } });
  value.candidates[0].gameplay = "玩".repeat(149) + "。";
  assert.doesNotThrow(() => checkAdaptation(value, 1, research, []));
  value.candidates[0].gameplay += "字";
  assert.throws(() => checkAdaptation(value, 1, research, []), /150/);
  value.candidates[0].gameplay = "点一下改变局面。";
  for (const field of ["hook", "rules", "controls", "minimum_implementation"]) {
    value.candidates[0][field] = "不应生成";
    assert.throws(() => checkAdaptation(value, 1, research, []), /additional properties/);
    delete value.candidates[0][field];
  }
});

test("historical seven-field results retain their content and export format", () => {
  const research = result({ stage: "research", ctx: {} });
  const value = result({ stage: "adaptation", ctx: { count: 1, assets: [] } });
  const c = value.candidates[0];
  delete c.gameplay;
  Object.assign(c, { hook: "历史玩法", rules: "历史规则", controls: "历史操控", minimum_implementation: "历史实现" });
  const before = JSON.stringify(value);
  assert.doesNotThrow(() => checkAdaptation(value, 1, research, [], legacyAdaptationSchema));
  const md = markdown({ workflowVersion: 3, meme: "历史", result: value, assets: [], research });
  for (const text of ["历史玩法", "历史规则", "历史操控", "历史实现"]) assert.ok(md.includes(text));
  assert.ok(!md.includes("### 玩法与简单规则"));
  assert.equal(JSON.stringify(value), before);
});
