const root = document.querySelector("#app");
let meta,
  selected = localStorage.getItem("meme-studio-selected"),
  runs = [],
  current = null,
  signature = "",
  posting = false;
const drafts = {
  meme: "",
  links: "",
  context: "",
  correction: "",
  notes: "",
  count: 3,
  branchId: "",
};
const statuses = {
  new: "准备中",
  analyzing: "分析中",
  awaiting_confirmation: "待选择版本",
  generating: "生成中",
  completed: "已完成",
  failed: "运行失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const tags = {
  candidate: "可评估候选",
  needs_evidence: "待补证据",
  park: "暂缓",
};
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c !== null && c !== undefined && c !== false)
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const p = (text, cls = "") => h("p", { class: cls }, text);
function safeUrl(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
function link(url, label) {
  const u = safeUrl(url);
  return u
    ? h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, label)
    : h("span", {}, label);
}
function toast(message) {
  const el = h("div", { class: "toast", role: "alert" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 6500);
}
async function api(url, data) {
  const res = await fetch(
    url,
    data
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Meme-Token": meta.token,
          },
          body: JSON.stringify(data),
        }
      : undefined,
  );
  const result = await res.json();
  if (!res.ok) throw Error(result.error || "请求失败");
  return result;
}
async function action(fn) {
  if (posting) return;
  posting = true;
  try {
    await fn();
    await refresh();
  } catch (e) {
    toast(e.message);
  } finally {
    posting = false;
    document.querySelectorAll("button[data-busy]").forEach((b) => {
      b.disabled = false;
      delete b.dataset.busy;
    });
  }
}
function btn(label, fn, cls = "primary") {
  return h(
    "button",
    {
      class: cls,
      type: "button",
      onClick: (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.dataset.busy = "true";
        action(fn);
      },
    },
    label,
  );
}
function field(label, key, placeholder, multiline = false) {
  const el = h(multiline ? "textarea" : "input", {
    value: drafts[key],
    placeholder,
    maxLength: key === "meme" ? 1000 : 12000,
    onInput: (e) => (drafts[key] = e.target.value),
  });
  return h("label", { class: "field" }, h("span", {}, label), el);
}
function setSelected(id) {
  selected = id;
  current = null;
  signature = "";
  drafts.branchId = "";
  drafts.notes = "";
  drafts.correction = "";
  if (id) localStorage.setItem("meme-studio-selected", id);
  else localStorage.removeItem("meme-studio-selected");
  refresh();
}
function shell() {
  root.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "aside",
        { class: "sidebar" },
        h(
          "div",
          { class: "brand" },
          h("span", { class: "logo", "aria-hidden": "true" }, "m"),
          "Meme Studio",
        ),
        p("从梗，到值得玩的选题", "tagline"),
        h(
          "button",
          { class: "new", onClick: () => setSelected(null) },
          "＋  新的 meme",
        ),
        p("最近的研究", "eyebrow history-title"),
        h("nav", { class: "history", id: "history", "aria-label": "研究历史" }),
        h(
          "div",
          { class: "side-footer" },
          h("span", { class: "dot" }),
          "本地工作台",
          h("br"),
          `Skill ${meta.skillVersion || meta.skillCommit?.slice(0, 7)} · ${meta.gitCommit?.slice(0, 7) || ""}`,
        ),
      ),
      h(
        "main",
        { class: "main" },
        h(
          "div",
          { class: "topbar" },
          h("span", {}, "WORKSPACE / 创意研究"),
          h("span", { class: "pill", id: "pool" }, "并发 0 / 3"),
        ),
        h("div", { id: "workspace" }),
      ),
    ),
  );
}
function history() {
  document.querySelector("#history").replaceChildren(
    ...(runs.length
      ? runs.map((r) =>
          h(
            "button",
            {
              class: r.id === selected ? "selected" : "",
              onClick: () => setSelected(r.id),
            },
            h("span", { class: "name" }, r.meme),
            h("small", {}, statuses[r.status] || r.status),
          ),
        )
      : [p("你的研究会保存在这里。\n可以随时回来继续。", "empty")]),
  );
}
function stepper(step) {
  return h(
    "div",
    { class: "steps" },
    ...[
      [1, "理解并确认 meme", "哪一下有趣 · 依据 · 不能改什么"],
      [2, "生成互动选题", "5 分钟机制研究 · 玩法改编"],
    ].map(([i, title, desc]) =>
      h(
        "div",
        { class: "step" + (step === i ? " active" : "") },
        h("b", {}, step > i ? "✓" : `0${i}`),
        h("div", {}, h("strong", {}, title), h("small", {}, desc)),
      ),
    ),
  );
}
function newPage() {
  return [
    h(
      "header",
      { class: "hero" },
      h("span", { class: "eyebrow" }, "MAKE THE MEME PLAYABLE"),
      h("h1", {}, "先懂这个梗。", h("br"), "再找值得玩的选题。"),
      p(
        "从一个梗名或具体片段开始。先核对我们说的是同一个 meme，再把它变成可以亲手参与的玩法。",
      ),
    ),
    stepper(1),
    h(
      "section",
      { class: "panel" },
      h(
        "div",
        { class: "panel-head" },
        h("h2", {}, "从哪个 meme 开始？"),
        h("span", { class: "pill" }, "第一步"),
      ),
      field("meme 名称或一句描述", "meme", "例如：牛来，或海绵宝宝「想象力」"),
      h(
        "div",
        { class: "chips" },
        ...["牛来", "广东", "中国人会飞", "海绵宝宝"].map((v) =>
          h(
            "button",
            {
              class: "chip",
              type: "button",
              onClick: () => {
                drafts.meme = v;
                render();
              },
            },
            v,
          ),
        ),
      ),
      field(
        "参考链接（可选）",
        "links",
        "粘贴视频或图片的发布页，多个链接可分行",
        true,
      ),
      field(
        "你指的是哪个版本？（可选）",
        "context",
        "描述喜欢的片段、具体表现，或需要排除的版本。",
        true,
      ),
      !meta.cli.available || !meta.cli.loggedIn
        ? p(meta.cli.login || "未检测到 Codex CLI，请先安装。", "error")
        : null,
      h(
        "div",
        { class: "actions" },
        btn("开始理解 meme  →", async () => {
          if (!drafts.meme.trim()) throw Error("先输入一个 meme");
          const r = await api("/api/runs", {
            meme: drafts.meme,
            links: drafts.links,
            context: drafts.context,
          });
          selected = r.id;
          localStorage.setItem("meme-studio-selected", selected);
          signature = "";
        }),
        p("Agent 核验理解后，由你选择版本和数量上限。", "hint"),
      ),
    ),
    p(
      "研究记录只保存在这台电脑 · Codex CLI 最多同时执行 3 个任务",
      "footer-note",
    ),
  ];
}
function details(title, ...children) {
  return h(
    "details",
    {},
    h("summary", {}, title),
    h("div", { class: "detail" }, children),
  );
}
function fact(label, text) {
  return h("div", { class: "fact" }, h("small", {}, label), p(text));
}
function sources(items) {
  return h(
    "div",
    { class: "sources" },
    ...items.map((s) => link(s.url, s.title)),
  );
}
function assetPreview(a, r) {
  const src = `/api/runs/${r.id}/media?assetId=${encodeURIComponent(a.id)}`;
  const tag = a.mediaType.startsWith("image/")
    ? "img"
    : a.mediaType.startsWith("video/")
      ? "video"
      : "audio";
  const el = h(tag, {
    src,
    ...(tag === "img"
      ? { alt: a.caption, loading: "eager" }
      : { controls: true, preload: "metadata" }),
  });
  el.addEventListener(
    "error",
    () =>
      el.replaceWith(p("素材文件无法读取，请查看来源或重新获取。", "error")),
    { once: true },
  );
  return h(
    "figure",
    {},
    el,
    h("figcaption", {}, a.caption),
    a.sourceUrl ? link(a.sourceUrl, "打开来源") : null,
  );
}
function media(branch, r) {
  if (r.workflowVersion === 3)
    return h(
      "div",
      { class: "media" },
      ...(r.assets || [])
        .filter((a) => a.branchIds.includes(branch.id))
        .map((a) => assetPreview(a, r)),
    );

  const job = [...r.jobs]
    .reverse()
    .find((j) => j.stage === "analysis" && j.status === "completed");
  if (!job) return null;
  return h(
    "div",
    { class: "media" },
    ...branch.media.map((m) => {
      if (!m.path || m.path.startsWith("/") || m.path.split("/").includes(".."))
        return null;
      const src = `/api/runs/${r.id}/media?path=${encodeURIComponent(job.id + "/" + m.path)}`,
        ext = m.path.split(".").pop().toLowerCase();
      let el;
      if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext))
        el = h("img", { src, alt: m.caption, loading: "lazy" });
      else if (["mp4", "webm"].includes(ext))
        el = h("video", { src, controls: true, preload: "metadata" });
      else if (["mp3", "wav", "ogg"].includes(ext))
        el = h("audio", { src, controls: true, preload: "metadata" });
      else return null;
      return h("figure", {}, el, h("figcaption", {}, m.caption));
    }),
  );
}
function branchCard(b, r, selectable) {
  return h(
    "article",
    { class: "branch" + (drafts.branchId === b.id ? " chosen" : "") },
    h(
      "label",
      { class: "branch-label" },
      selectable
        ? h("input", {
            type: "radio",
            name: "branch",
            value: b.id,
            checked: drafts.branchId === b.id,
            onChange: () => {
              drafts.branchId = b.id;
              render();
            },
          })
        : null,
      b.title,
    ),
    p(b.summary, "intro"),
    media(b, r),
    b.interesting_moment
      ? h(
          "div",
          { class: "facts" },
          fact("素材到底哪一下有意思？", b.interesting_moment),
          fact("依据是什么？", b.basis),
          fact("要保住这个趣味，哪些东西不能随便改？", b.must_keep.join("；")),
        )
      : h(
          "div",
          { class: "facts" },
          fact("历史版本的解释", b.attraction || b.summary),
          fact(
            "历史版本记录",
            [b.content, b.performance, b.usage].filter(Boolean).join("；"),
          ),
        ),
    sources(b.sources),
    b.gaps.length
      ? h("div", { class: "gaps" }, "证据缺口：", b.gaps.join("；"))
      : null,
    details(
      "来源支持范围",
      ...b.sources.map((s) => p(`${s.title} · ${s.mode}：${s.support}`)),
    ),
  );
}
function progress(r) {
  const active =
    r.workflowVersion === 3 && ["analyzing", "generating"].includes(r.status);
  return h(
    "section",
    { class: "panel", "aria-live": "polite" },
    h(
      "div",
      { class: "panel-head" },
      h(
        "div",
        { class: "progress-title" },
        active ? h("span", { class: "spinner", "aria-hidden": "true" }) : null,
        h("h3", {}, r.phase || statuses[r.status]),
      ),
      h("span", { class: "pill" }, statuses[r.status]),
    ),
    h(
      "div",
      { class: "jobs" },
      ...r.jobs.slice(-6).map((j) =>
        h(
          "span",
          { class: "job " + j.status },
          j.label +
            " · " +
            ({
              queued: "排队",
              running: "执行中",
              completed: "完成",
              failed: "失败",
              cancelled: "取消",
              interrupted: "中断",
            }[j.status] || j.status),
        ),
      ),
    ),
    h(
      "div",
      { class: "log" },
      ...r.events
        .slice(-4)
        .map((e) =>
          p(
            [
              new Date(e.time).toLocaleTimeString("zh-CN", { hour12: false }),
              e.message,
            ].join("  "),
          ),
        ),
    ),
    ...r.jobs
      .filter((j) => j.stage === "research" && j.revision === r.revision)
      .slice(-1)
      .map((j) =>
        p(
          j.status === "queued"
            ? "研究排队中，尚未开始计时"
            : j.startedAt
              ? `研究用时 ${Math.min(300, Math.floor(((j.finishedAt ? Date.parse(j.finishedAt) : Date.now()) - Date.parse(j.startedAt)) / 1000))} 秒 / 300 秒`
              : "研究准备中",
        ),
      ),
    r.error ? p(r.error, "error") : null,
    active
      ? btn(
          "取消本次执行",
          () => api(`/api/runs/${r.id}/cancel`, {}),
          "secondary",
        )
      : r.workflowVersion === 3 &&
          ["failed", "cancelled", "interrupted"].includes(r.status)
        ? btn("重试这一阶段", () => api(`/api/runs/${r.id}/retry`, {}))
        : null,
  );
}
function candidate(c, research) {
  return h(
    "article",
    { class: "panel candidate" },
    h(
      "div",
      { class: "panel-head" },
      h("div", {}, p(c.id, "number"), h("h3", {}, c.title)),
      h("span", { class: "pill tag-" + c.status }, tags[c.status]),
    ),
    p(c.hook, "hook"),
    p(c.player_action),
    fact(
      "玩家操作以后，会发生什么值得他亲手体验的变化？",
      c.experience_change || "历史版本未记录",
    ),
    fact("这个变化怎样保住原趣味？", c.interest_connection || c.meme_relation),
    sources(
      c.mother_ids
        .map((id) => research.mothers.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => ({ title: m.game, url: m.url })),
    ),
    details(
      "机制、重试价值与制作边界",
      h("h4", {}, "来源实际支持什么"),
      p(c.source_support),
      h("h4", {}, "保留 / 删除的条件"),
      p("保留：" + c.retained_conditions.join("；")),
      p("删除：" + c.removed_conditions.join("；")),
      h("h4", {}, "新增假设"),
      p(c.new_assumptions.join("；")),
      h("h4", {}, "为什么再操作一次"),
      p(c.replay_reason),
      h("h4", {}, "简化与风险"),
      p(c.simplification),
      p(c.production_risk),
      h("h4", {}, "最小验证与撤下条件"),
      p(c.minimum_test),
      p(c.reject_if),
    ),
  );
}
function runPage(r) {
  const second = Boolean(r.confirmed);
  const nodes = [
    h(
      "header",
      { class: "hero" },
      h("span", { class: "eyebrow" }, "MEME RESEARCH"),
      h("h1", {}, r.meme),
      p(
        second
          ? "已锁定你确认的版本。选题会沿着这份理解继续。"
          : "先检查版本、表现和使用语境。不同分支可以分别确认。",
      ),
    ),
    stepper(second ? 2 : 1),
    progress(r),
  ];
  if (r.workflowVersion !== 3)
    nodes.push(
      h(
        "section",
        { class: "panel" },
        h("h3", {}, "历史版本记录"),
        p("此记录保留原流程。使用新版流程请新建研究，旧结果不会被改写。"),
        btn("使用同一素材新建研究", async () => {
          const next = await api("/api/runs", {
            meme: r.meme,
            context: r.context,
            links: r.links,
          });
          selected = next.id;
          localStorage.setItem("meme-studio-selected", selected);
          drafts.branchId = "";
        }),
      ),
    );
  if (r.analysis) {
    const selectable =
      r.status === "awaiting_confirmation" && r.workflowVersion === 3;
    if (
      !drafts.branchId ||
      !r.analysis.branches.some((b) => b.id === drafts.branchId)
    )
      drafts.branchId = r.analysis.recommended_branch_id;
    if (selectable) {
      nodes.push(
        h(
          "section",
          { class: "panel" },
          h(
            "div",
            { class: "panel-head" },
            h("h2", {}, "这是你说的 meme 吗？"),
            h(
              "span",
              { class: "pill" },
              `${r.analysis.branches.length} 个版本`,
            ),
          ),
          p(r.analysis.summary, "muted"),
          ...r.analysis.branches.map((b) => branchCard(b, r, true)),
          r.analysis.open_questions.length
            ? p(
                "尚未解决的研究问题：" + r.analysis.open_questions.join("；"),
                "muted",
              )
            : null,
          details(
            "理解有偏差？补充后重新分析",
            field(
              "告诉 Codex 哪一部分不对",
              "correction",
              "例如：我要的是电台飞天二创，不是原版 MV。",
              true,
            ),
            btn(
              "按纠正重新理解",
              () =>
                api(`/api/runs/${r.id}/revise`, {
                  correction: drafts.correction,
                }),
              "secondary",
            ),
          ),
        ),
      );
      nodes.push(
        h(
          "section",
          { class: "panel confirm" },
          h("h2", {}, "确认版本，然后生成选题"),
          p(
            "Agent 负责核验理解与依据；你选择要做的版本。按指定数量生成；材料不足而未完成时会明确说明。",
            "muted",
          ),
          field(
            "确认补充 / 选题约束（可选）",
            "notes",
            "例如：保留原声；只做单指操作；不要节奏游戏。",
            true,
          ),
          h(
            "label",
            { class: "count-row" },
            "这次最多生成",
            h("input", {
              type: "number",
              min: 1,
              max: 50,
              step: 1,
              value: drafts.count,
              "aria-label": "选题数量上限",
              onInput: (e) => (drafts.count = Number(e.target.value)),
            }),
            "个选题方向",
          ),
          h(
            "div",
            { class: "actions" },
            btn("确认 meme，生成选题  →", () =>
              api(`/api/runs/${r.id}/confirm`, {
                branchId: drafts.branchId,
                revision: r.revision,
                count: drafts.count,
                notes: drafts.notes,
              }),
            ),
            p("研究最多 5 分钟，随后一次生成全部选题。", "hint"),
          ),
        ),
      );
    } else if (r.confirmed)
      nodes.push(
        h(
          "section",
          { class: "panel read-only" },
          details(
            "查看已确认的 meme：" + r.confirmed.branch.title,
            branchCard(r.confirmed.branch, r, false),
            p(r.confirmed.notes || "没有额外约束", "muted"),
          ),
        ),
      );
  }
  if (r.result && r.workflowVersion !== 3) {
    const supported = r.result.candidates.filter(
      (c) => c.status === "candidate",
    ).length;
    nodes.push(
      h(
        "div",
        { class: "results-header" },
        h(
          "div",
          {},
          h("h2", {}, `${supported} 个候选 · 上限 ${r.count} 个`),
          p("仅展示保留选题 · 尚未真人试玩", "muted"),
        ),
        h(
          "div",
          { class: "actions" },
          h(
            "a",
            { href: `/api/runs/${r.id}/export`, class: "secondary" },
            "下载 Markdown",
          ),
          h(
            "a",
            {
              href: `/api/runs/${r.id}/export?format=json`,
              class: "secondary",
            },
            "JSON",
          ),
        ),
      ),
      p(r.result.summary),
      r.result.shortfall_reason ? p(r.result.shortfall_reason, "gaps") : null,
      ...r.result.candidates
        .filter((c) => c.status === "candidate")
        .map((c) => candidate(c, r.research)),
      details(
        "未采用方向与原因",
        ...[
          ...(r.result.rejected || []),
          ...r.result.candidates
            .filter((c) => c.status !== "candidate")
            .map((c) => ({ ...c, reason: c.source_support || c.reject_if })),
        ].map((x) => p(`${x.id} · ${x.title}：${x.reason}`)),
      ),
      h(
        "section",
        { class: "panel" },
        h("h3", {}, "研究依据与质量检查"),
        ...r.result.quality_notes.map((n) => p(n, "muted")),
        details(
          "查看参考游戏的具体操作过程",
          ...r.research.mothers.map((m) =>
            h(
              "div",
              {},
              h("h4", {}, link(m.url, m.game)),
              p(m.platform_version + " · " + m.experience_signal, "muted"),
              ...Object.entries({
                当前局面: m.walkthrough.initial_state,
                选择与约束: m.walkthrough.choices_constraints,
                输入与反馈: m.walkthrough.input_feedback,
                结果与下一步: m.walkthrough.result_next_action,
                价值依赖: m.walkthrough.value_condition,
                证据模式: m.walkthrough.evidence_mode,
                来源位置: m.walkthrough.source_locator,
              }).map(([k, v]) => p(`${k}：${v}`)),
              p("重建细节：" + m.walkthrough.reconstructed_details.join("；")),
              p("缺口：" + m.walkthrough.gaps.join("；")),
            ),
          ),
        ),
        details(
          "查看检索与未采用方向",
          p(r.research.discovery_queries.join("\n")),
          p(r.research.rejected_neighbors.join("\n")),
        ),
        r.workflowVersion === 3 &&
          details(
            "更换理解，重新开始",
            field(
              "这次想怎么修正？",
              "correction",
              "描述新的目标版本或反馈；需要重新确认后才能生成。",
              true,
            ),
            btn(
              "回到梗分析",
              () =>
                api(`/api/runs/${r.id}/revise`, {
                  correction: drafts.correction,
                }),
              "secondary",
            ),
          ),
      ),
    );
  }
  if (r.workflowVersion === 3) {
    if (r.research)
      nodes.push(
        h(
          "section",
          { class: "panel" },
          r.research.timeLimited
            ? p("研究达到时限，使用已有结果", "gaps")
            : null,
          details(
            "机制研究、搜索与依据",
            p(r.research.summary),
            ...r.research.mechanisms.map((m) =>
              details(
                m.game + " · " + m.id,
                p(m.platform_version + " · " + m.retrieved_at),
                fact("玩家实际做什么", m.gameplay),
                fact("规则", m.rules),
                fact("操控", m.controls),
                fact("反馈", m.feedback),
                fact("操作价值依赖", m.value_conditions.join("；")),
                fact("与梗的关联", m.relevance),
                fact("缺口", m.gaps.join("；")),
                sources(m.sources),
                ...m.sources.map((s) => p(s.support)),
              ),
            ),
            details(
              "中文搜索目的与研究记录",
              ...r.research.queries.map((q) => p(q.purpose + "：" + q.query)),
            ),
            details(
              "CLI 实际搜索调用",
              ...r.jobs
                .filter((j) => j.id === r.research.jobId)
                .flatMap((j) =>
                  (j.searches || []).map((q) => p(q.queries.join("\n"))),
                ),
            ),
          ),
        ),
      );
    if (r.result)
      nodes.push(
        h(
          "div",
          { class: "results-header" },
          h("h2", {}, `${r.result.candidates.length} 个选题`),
          h(
            "div",
            { class: "actions" },
            h(
              "a",
              { href: `/api/runs/${r.id}/export`, class: "secondary" },
              "下载 Markdown",
            ),
            h(
              "a",
              {
                href: `/api/runs/${r.id}/export?format=json`,
                class: "secondary",
              },
              "JSON",
            ),
          ),
        ),
        r.result.shortfall_reason ? p(r.result.shortfall_reason, "gaps") : null,
        ...r.result.candidates.map((c) =>
          h(
            "article",
            { class: "panel candidate" },
            p(c.id, "number"),
            h("h3", {}, c.title),
            fact("一句话玩法", c.hook),
            fact("必要规则", c.rules),
            fact("玩家操控方式", c.controls),
            h("h4", {}, "素材使用"),
            ...c.media_usage.map((u) => {
              const a = r.assets.find((a) => a.id === u.asset_id);
              return h(
                "div",
                { class: "media" },
                p(
                  [
                    u.status === "used"
                      ? "使用"
                      : u.status === "missing"
                        ? "待补"
                        : "不使用",
                    u.where,
                    u.interaction,
                    u.note,
                  ]
                    .filter(Boolean)
                    .join("："),
                ),
                a ? assetPreview(a, r) : null,
              );
            }),
            fact("梗的趣味", c.meme_interest),
            fact("最小实现", c.minimum_implementation),
            h("h4", {}, "参考"),
            ...c.references.map((ref) => {
              const m = r.research.mechanisms.find(
                (m) => m.id === ref.mechanism_id,
              );
              return h(
                "div",
                {},
                p(
                  `${m.game}：借用 ${ref.borrowed}；改动 ${ref.changes}；原创 ${ref.original}`,
                ),
                sources(m.sources),
              );
            }),
          ),
        ),
        details(
          "修改梗理解，重新研究",
          field("纠正说明", "correction", "说明需要修正的理解", true),
          btn(
            "回到梗分析",
            () =>
              api(`/api/runs/${r.id}/revise`, {
                correction: drafts.correction,
              }),
            "secondary",
          ),
        ),
      );
  }
  return nodes;
}
function render() {
  document
    .querySelector("#workspace")
    .replaceChildren(
      ...(current ? runPage(current) : newPage()).filter(
        (node) => node !== null && node !== undefined,
      ),
    );
}
let polling = false;
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const [list, detail] = await Promise.all([
      api("/api/runs"),
      selected
        ? api(`/api/runs/${selected}`).catch((e) => {
            if (e.message === "任务不存在") {
              selected = null;
              localStorage.removeItem("meme-studio-selected");
              return null;
            }
            throw e;
          })
        : null,
    ]);
    runs = list.runs;
    document.querySelector("#pool").textContent =
      `CLI 并发 ${list.pool.active} / 3${list.pool.queued ? " · " + list.pool.queued + " 排队" : ""}`;
    history();
    current = detail?.run || null;
    const next = current ? current.id + current.updatedAt : "new";
    if (next !== signature) {
      signature = next;
      render();
    }
  } catch (e) {
    if (!document.querySelector("#workspace")?.children.length)
      toast(e.message);
  } finally {
    polling = false;
  }
}
try {
  meta = await api("/api/meta");
  shell();
  await refresh();
  setInterval(refresh, 1500);
  setInterval(() => {
    if (!current) return;
    const j = current.jobs.find(
      (j) => j.stage === "research" && j.status === "running" && j.startedAt,
    );
    if (j)
      for (const e of document.querySelectorAll("p"))
        if (e.textContent.startsWith("研究用时 "))
          e.textContent = `研究用时 ${Math.min(300, Math.floor((Date.now() - Date.parse(j.startedAt)) / 1000))} 秒 / 300 秒`;
  }, 1000);
} catch (e) {
  root.replaceChildren(p("无法连接本地服务：" + e.message, "error"));
}
