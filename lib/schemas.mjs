import Ajv from "ajv";
const text = { type: "string" };
const texts = { type: "array", items: text };
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const list = (items) => ({ type: "array", items });
const source = obj({
  title: text,
  url: text,
  support: text,
  mode: {
    type: "string",
    enum: [
      "media_observed",
      "developer_described",
      "player_report",
      "source_reported",
      "user_provided",
    ],
  },
});
const branch = obj({
  id: text,
  title: text,
  summary: text,
  interesting_moment: text,
  basis: text,
  must_keep: texts,
  sources: list(source),
  gaps: texts,
  media: list(obj({ path: text, caption: text })),
});
export const analysisSchema = obj({
  meme: text,
  summary: text,
  recommended_branch_id: text,
  branches: { type: "array", items: branch, minItems: 1, maxItems: 6 },
  open_questions: texts,
});
const walkthrough = obj({
  initial_state: text,
  choices_constraints: text,
  input_feedback: text,
  result_next_action: text,
  value_condition: text,
  evidence_mode: text,
  source_locator: text,
  reconstructed_details: texts,
  gaps: texts,
});
const mother = obj({
  id: text,
  game: text,
  platform_version: text,
  url: text,
  experience_signal: text,
  walkthrough,
  retained_conditions: texts,
  removed_conditions: texts,
  transfer_gap: text,
});
const direction = obj({
  id: text,
  title: text,
  experience_change: text,
  interest_connection: text,
  distinct_variable: text,
  mother_ids: texts,
  added_hypotheses: texts,
  status: { type: "string", enum: ["supported_direction", "hypothesis_only"] },
});
export const planSchema = obj({
  branch_summary: text,
  discovery_queries: texts,
  research_summary: text,
  mothers: list(mother),
  directions: list(direction),
  rejected_neighbors: texts,
  gaps: texts,
});
const candidate = obj({
  id: text,
  title: text,
  hook: text,
  player_action: text,
  trace_a: text,
  trace_b: text,
  experience_change: text,
  interest_connection: text,
  mother_ids: texts,
  source_support: text,
  retained_conditions: texts,
  removed_conditions: texts,
  new_assumptions: texts,
  replay_reason: text,
  simplification: text,
  production_risk: text,
  minimum_test: text,
  reject_if: text,
  status: { type: "string", enum: ["candidate", "needs_evidence", "park"] },
});
const rejection = obj({ id: text, title: text, reason: text });
export const draftSchema = obj({
  candidates: list(candidate),
  rejected: list(rejection),
});
export const finalSchema = obj({
  summary: text,
  candidates: list(candidate),
  rejected: list(rejection),
  quality_notes: texts,
  shortfall_reason: text,
});
const ajv = new Ajv({ allErrors: true });
export function validator(schema) {
  const check = ajv.compile(schema);
  return (value) => {
    if (!check(value))
      throw new Error("CLI 输出格式不完整：" + ajv.errorsText(check.errors));
    return value;
  };
}
export function exactIds(items, ids) {
  if (
    items.length !== ids.length ||
    new Set(items.map((x) => x.id)).size !== ids.length ||
    items.some((x) => !ids.includes(x.id))
  )
    throw new Error("选题数量或编号与本次分配不一致，请重试。");
}

export function subsetIds(items, ids) {
  const found = items.map((x) => x.id);
  if (
    new Set(found).size !== found.length ||
    found.some((id) => !ids.includes(id))
  )
    throw new Error("选题数量或编号超出本次分配，或编号重复。");
}
export function partitionIds(output, ids) {
  exactIds([...output.candidates, ...output.rejected], ids);
  if (output.rejected.some((x) => !x.reason.trim()))
    throw new Error("撤下的方向必须说明原因。");
}
