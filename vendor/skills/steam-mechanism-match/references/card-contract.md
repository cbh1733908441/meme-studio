# 证据与候选卡

按任务规模选择 Markdown 或 JSON。字段表达语义，不是必须填满的表格；未知用 null/缺口说明。

```json
{
  "meme_id": "stable-id",
  "branch": "具体分支",
  "interesting_moment": "素材有意思的具体一下",
  "basis": "哪些素材或实际用例支持这个解释",
  "must_keep": ["不能随便改的东西及其理由"],
  "meme_evidence_status": "用户提供/此前研究/本次直接观察",
  "mechanism_sources": [
    {
      "game": "游戏名称及版本",
      "platform": "Steam/iPhone/iPad等实际证据",
      "url": "原始来源",
      "retrieved_at": "ISO日期",
      "source_kind": "publisher_store_description",
      "evidence_mode": "developer_described / gameplay_observed / directly_played",
      "locator": "支持段落的位置或视频时间段",
      "observed_modalities": [],
      "source_mechanism": "动作→对象或变量→反馈；条件",
      "operation_walkthrough": {
        "basis": "developer_described / gameplay_observed / directly_played / player_report / rule_based_reconstruction",
        "source_locator": "具体段落、时间段或报告链接；关键步骤可分别注明",
        "initial_state_and_intent": "来源游戏的局面、可见信息与玩家意图",
        "choices_and_constraints": "可选行动、差异及造成差异的约束",
        "input_state_feedback": "具体输入→状态变化→可感知反馈",
        "result_and_next_action": "结果提供的信息或作品变化怎样影响下一步；也可结束",
        "value_bearing_condition": "上述过程哪一步产生判断、发现、练习或表达价值，依赖什么",
        "reconstructed_details": [],
        "missing": []
      },
      "supported_claim": "此来源实际支持的局部关系",
      "gameplay_observed": false,
      "missing": []
    }
  ],
  "candidate_id": "stable-candidate-id",
  "candidate_version": "v1",
  "agent_disposition": "retain / explore / park（不是真人评分）",
  "mechanism_support": "direct_local / partial_or_new_combination / original_or_missing",
  "new_design": "此次新增的输入、映射、表现和结束方式",
  "interaction_benefit": "相较自动播放，多获得什么，是否值得操作成本",
  "input_outcome_traces": ["操作A→结果A", "操作B→结果B"],
  "preserved_mechanism_conditions": ["原机制产生体验所需的条件"],
  "condition_transfer": [
    {
      "condition": "可能承载体验的条件",
      "evidence_basis": "source_fact / observed / inferred",
      "source_ref": "来源 URL 与位置；无依据时为 null",
      "change": "preserved / removed / replaced",
      "replacement": null,
      "remaining_risk": "简化或迁移后仍需验证什么"
    }
  ],
  "next_action_hypothesis": "第一次结果为何使玩家想改变下一次操作或继续完成；尚未验证",
  "fit_reason": "保留何种效果；尚有何种迁移跳跃",
  "rejected_alternative": "方向及不采用理由",
  "prototype": "最小验证范围",
  "falsifier": "哪种观察会推翻体验假设",
  "human_review": {
    "decision": null,
    "reason": null,
    "stage": null,
    "reviewer": null,
    "reviewed_at": null
  }
}
```

人类 decision 可用 prototype / revise / reject；stage 区分 concept_review 与 player_test。需要 Good/Bad 时另外保留阶段和理由，不能把 Agent 的结构匹配判断填成真人标签。候选修改后递增版本，旧反馈留在旧版本。

局部关系 direct_local 只表示借用的关系有依据，不代表完整候选已被验证好玩。部分来源支持与新增组合分别写明；没有证据的原创假设不进入上游“通过检索”的候选表。`gameplay_observed=false` 时不能用视频 URL 或元数据将其隐式升级为已观察。证据模式不必填完整选题与真人评价字段，返回已有证据和缺口即可。

`operation_walkthrough` 按[具体操作过程](operation-walkthrough.md)记录来源游戏，不是候选的 `input_outcome_traces`。补件可只保留有依据的步骤；规则推演中的自拟细节不能升级为观察。梗的研究记录另保留素材有意思的一下、实际用例如何支持、不能随便改的东西及其理由，并区分来源事实与解释，不将全部研究强塞进候选正文。

反馈用于定位错误：素材误读、来源关系误读、迁移不成立、表现不喜欢、制作不可行、操作体验失败。一个 Bad case 未必需要改提示词，也可能需要更好的媒体或工具。

批量反馈可单独保存 scope、verbatim、stage、candidate_version、per_case_reason=null。只有整批否定而没有逐项理由时，只记录该批未获认可，不推断拒绝次序、逐项理由或玩家实际体验。后续模型诊断放在独立字段。park 记录检索结果、淘汰理由和重启条件，不必补造操作经过。
