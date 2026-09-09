import {
  analysisSchema,
  planSchema,
  draftSchema,
  finalSchema,
} from "../lib/schemas.mjs";
export function example(s) {
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
    const r = example(planSchema),
      m = example(planSchema.properties.mothers.items);
    m.id = "M01";
    m.url = "https://example.com/source";
    r.mothers = [m];
    r.directions = Array.from({ length: ctx.count }, (_, i) => ({
      ...example(planSchema.properties.directions.items),
      id: "T" + String(i + 1).padStart(2, "0"),
      mother_ids: ["M01"],
    }));
    return r;
  }
  if (stage === "draft")
    return {
      rejected: [],
      candidates: ctx.assigned_ids.map((id) => ({
        ...example(draftSchema.properties.candidates.items),
        id,
        mother_ids: ["M01"],
      })),
    };
  return {
    ...example(finalSchema),
    candidates: ctx.drafts.flatMap((d) => d.candidates),
    shortfall_reason: "",
  };
}
