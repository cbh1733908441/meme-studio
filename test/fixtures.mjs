import {
  analysisSchema,
  researchSchema,
  adaptationSchema,
} from "../lib/schemas.mjs";
export function example(s) {
  if (Array.isArray(s.type)) return null;
  if (s.type === "object")
    return Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, example(v)]),
    );
  if (s.type === "array")
    return Array.from({ length: s.minItems || 0 }, () => example(s.items));
  return s.enum?.[0] || "验收样本";
}
export function result({ stage, ctx }) {
  if (stage === "analysis") {
    const a = example(analysisSchema);
    a.branches[0].id = "B01";
    a.recommended_branch_id = "B01";
    return a;
  }
  if (stage === "research") {
    const r = example(researchSchema),
      m = example(researchSchema.properties.mechanisms.items);
    m.id = "M01";
    m.sources = [
      {
        title: "官方玩法说明",
        url: "https://example.com/game",
        support: "玩法说明",
        mode: "developer_described",
      },
    ];
    m.value_conditions = ["后续状态保留"];
    r.mechanisms = [m];
    return r;
  }
  return {
    summary: "生成完成",
    candidates: Array.from({ length: ctx.count }, (_, i) => ({
      ...example(adaptationSchema.properties.candidates.items),
      id: "T" + String(i + 1).padStart(2, "0"),
      media_usage: ctx.assets.length
        ? ctx.assets.map((a) => ({
            status: "used",
            asset_id: a.id,
            where: "操作后",
            interaction: "触发媒体反馈",
            note: "",
          }))
        : [
            {
              status: "missing",
              asset_id: null,
              where: "",
              interaction: "",
              note: "待补原声",
            },
          ],
      references: [
        {
          mechanism_id: "M01",
          borrowed: "规则",
          changes: "改为触屏",
          original: "新增场景",
        },
      ],
    })),
    shortfall_reason: "",
  };
}
