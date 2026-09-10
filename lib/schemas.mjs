import Ajv from "ajv";
const text = { type: "string" },
  texts = { type: "array", items: text };
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
const media = obj({
  path: text,
  caption: text,
  source_url: { type: ["string", "null"] },
  start_s: { type: ["number", "null"], minimum: 0 },
  end_s: { type: ["number", "null"], minimum: 0 },
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
  media: list(media),
});
export const analysisSchema = obj({
  meme: text,
  summary: text,
  recommended_branch_id: text,
  branches: { type: "array", items: branch, minItems: 1, maxItems: 6 },
  open_questions: texts,
});
const mechanism = obj({
  id: text,
  game: text,
  platform_version: text,
  retrieved_at: text,
  sources: list(source),
  gameplay: text,
  rules: text,
  controls: text,
  feedback: text,
  value_conditions: texts,
  relevance: text,
  gaps: texts,
});
export const researchSchema = obj({
  summary: text,
  mechanisms: list(mechanism),
  queries: list(obj({ purpose: text, query: text })),
  gaps: texts,
});
const usage = obj({
  status: { type: "string", enum: ["used", "not_used", "missing"] },
  asset_id: { type: ["string", "null"] },
  where: text,
  interaction: text,
  note: text,
});
const reference = obj({
  mechanism_id: text,
  borrowed: text,
  changes: text,
  original: text,
});
const candidate = obj({
  id: text,
  title: text,
  hook: text,
  rules: text,
  controls: text,
  media_usage: list(usage),
  meme_interest: text,
  minimum_implementation: text,
  references: list(reference),
});
export const adaptationSchema = obj({
  summary: text,
  candidates: list(candidate),
  shortfall_reason: text,
});
const ajv = new Ajv({ allErrors: true });
export function validator(schema) {
  const check = ajv.compile(schema);
  return (value) => {
    if (!check(value))
      throw new Error("输出格式不完整：" + ajv.errorsText(check.errors));
    return value;
  };
}
export function subsetIds(items, ids) {
  const got = items.map((x) => x.id);
  if (new Set(got).size !== got.length || got.some((id) => !ids.includes(id)))
    throw new Error("编号重复或超出范围");
}
export function validUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export function checkResearch(value) {
  validator(researchSchema)(value);
  const ids = value.mechanisms.map((m) => m.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !id.trim()))
    throw new Error("机制编号重复或为空");
  for (const m of value.mechanisms) {
    if (
      [
        "game",
        "platform_version",
        "retrieved_at",
        "gameplay",
        "rules",
        "controls",
        "feedback",
        "relevance",
      ].some((k) => !m[k].trim()) ||
      !m.value_conditions.some((x) => x.trim()) ||
      !m.sources.length
    )
      throw new Error("机制记录缺少必要内容");
    if (
      m.sources.some(
        (s) => !validUrl(s.url) || !s.title.trim() || !s.support.trim(),
      )
    )
      throw new Error("机制引用无效");
  }
  return value;
}
export function checkAdaptation(value, count, research, assets) {
  validator(adaptationSchema)(value);
  subsetIds(
    value.candidates,
    Array.from(
      { length: count },
      (_, i) => "T" + String(i + 1).padStart(2, "0"),
    ),
  );
  for (const c of value.candidates) {
    if (
      [
        "title",
        "hook",
        "rules",
        "controls",
        "meme_interest",
        "minimum_implementation",
      ].some((k) => !c[k].trim())
    )
      throw new Error("选题七项内容不完整");
    if (
      !c.references.length ||
      c.references.some(
        (ref) =>
          !research.mechanisms.some((m) => m.id === ref.mechanism_id) ||
          !ref.borrowed.trim(),
      )
    )
      throw new Error("选题引用了不存在的机制");
    if (!c.media_usage.length) throw new Error("未说明素材使用");
    for (const u of c.media_usage) {
      if (u.status === "used") {
        if (
          !assets.some((a) => a.id === u.asset_id) ||
          !u.where.trim() ||
          !u.interaction.trim()
        )
          throw new Error("素材引用或使用说明无效");
      } else if (u.asset_id !== null || !u.note.trim())
        throw new Error("待补或不使用素材必须说明原因，不能提供虚假素材 ID");
    }
  }
  if (value.candidates.length < count && !value.shortfall_reason.trim())
    throw new Error("数量不足需要说明");
  return value;
}
