import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "./pool.mjs";
import { prompt, skillText, SKILL_VERSION } from "./prompts.mjs";
import {
  analysisSchema,
  researchSchema,
  adaptationSchema,
  validator,
  checkResearch,
  checkAdaptation,
} from "./schemas.mjs";
import { stageSkills } from "./prompts.mjs";
import { registerAssets } from "./assets.mjs";
const clone = (x) => JSON.parse(JSON.stringify(x));
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export class Manager {
  constructor({
    dataDir,
    vendor,
    runner,
    limit = 3,
    python = "python3",
    researchTimeoutMs = 300000,
  }) {
    this.dataDir = path.resolve(dataDir);
    this.vendor = vendor;
    this.runner = runner;
    this.python = python;
    this.researchTimeoutMs = researchTimeoutMs;
    this.pool = new Pool(limit);
    this.runs = new Map();
    this.controllers = new Map();
    this.tasks = new Map();
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const id of fs.readdirSync(this.dataDir)) {
      const file = path.join(this.dataDir, id, "run.json");
      if (!fs.existsSync(file)) continue;
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      this.runs.set(r.id, r);
      if (
        r.workflowVersion === 3 &&
        ["analyzing", "generating"].includes(r.status)
      ) {
        r.status = "interrupted";
        r.error = "服务上次退出时任务尚未完成，未自动重启 CLI。可以重试。";
        for (const j of r.jobs)
          if (["queued", "running"].includes(j.status))
            j.status = "interrupted";
        this.save(r);
      }
    }
  }
  get(id) {
    const r = this.runs.get(id);
    if (!r) throw new AppError("任务不存在", 404);
    return r;
  }
  list() {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({
        id: r.id,
        meme: r.meme,
        status: r.status,
        phase: r.phase,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        count: r.count,
        revision: r.revision,
      }));
  }
  folder(r) {
    return path.join(this.dataDir, r.id);
  }
  save(r) {
    r.updatedAt = new Date().toISOString();
    const file = path.join(this.folder(r), "run.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(r, null, 2));
    fs.renameSync(file + ".tmp", file);
  }
  validateText(value, name, max, required = false) {
    if (
      typeof value !== "string" ||
      value.length > max ||
      (required && !value.trim())
    )
      throw new AppError(`${name}不能为空或超过长度限制`);
    return value.trim();
  }
  create(input) {
    const meme = this.validateText(input.meme, "meme", 1000, true),
      context = this.validateText(input.context ?? "", "补充说明", 12000),
      links = this.validateText(input.links ?? "", "参考链接", 6000);
    const now = new Date().toISOString();
    const r = {
      id: randomUUID(),
      meme,
      context,
      links,
      createdAt: now,
      updatedAt: now,
      status: "new",
      phase: "",
      revision: 0,
      skillVersion: SKILL_VERSION,
      workflowVersion: 3,
      assets: [],
      analysis: null,
      confirmed: null,
      research: null,
      result: null,
      jobs: [],
      events: [],
      error: null,
      count: null,
      lastAction: "analysis",
    };
    fs.mkdirSync(this.folder(r), { recursive: true });
    fs.cpSync(this.vendor, path.join(this.folder(r), "skills"), {
      recursive: true,
    });
    const snapshotRoot = path.join(this.folder(r), "skills");
    const files = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) walk(file);
        else
          files.push({
            path: path.relative(snapshotRoot, file),
            sha256: createHash("sha256")
              .update(fs.readFileSync(file))
              .digest("hex"),
          });
      }
    };
    walk(snapshotRoot);
    r.skillSnapshot = { version: SKILL_VERSION, files };
    fs.writeFileSync(
      path.join(this.folder(r), "skill-manifest.json"),
      JSON.stringify(r.skillSnapshot, null, 2),
    );
    this.runs.set(r.id, r);
    this.analyze(r, "");
    return clone(r);
  }
  event(r, message) {
    if (r.events.at(-1)?.message === message) return;
    r.events.push({ time: new Date().toISOString(), message });
    r.events = r.events.slice(-80);
    this.save(r);
  }
  launch(r, action, fn) {
    if (this.controllers.has(r.id))
      throw new AppError("任务正在执行，请先等待或取消", 409);
    const controller = new AbortController();
    this.controllers.set(r.id, controller);
    r.error = null;
    r.lastAction = action;
    this.save(r);
    const task = (async () => {
      try {
        await fn(controller.signal);
      } catch (e) {
        r.status = controller.signal.aborted ? "cancelled" : "failed";
        r.error = controller.signal.aborted ? "任务已取消" : e.message;
        this.event(r, r.error);
      } finally {
        this.controllers.delete(r.id);
        this.tasks.delete(r.id);
        this.save(r);
      }
    })();
    this.tasks.set(r.id, task);
  }
  analyze(r, correction) {
    if (this.controllers.has(r.id)) throw new AppError("任务正在执行", 409);
    r.revision++;
    r.correction = correction;
    r.status = "analyzing";
    r.phase = "理解梗与核验来源";
    r.confirmed = null;
    r.result = null;
    r.research = null;
    r.assets = [];
    r.count = null;
    const previousAnalysis = r.analysis;
    r.analysis = null;
    this.launch(r, "analysis", async (signal) => {
      const result = await this.stage(
        r,
        "analysis",
        "理解 meme",
        analysisSchema,
        {
          meme: r.meme,
          context: r.context,
          links: r.links,
          correction,
          previousAnalysis,
        },
        signal,
      );
      const ids = result.branches.map((b) => b.id);
      if (
        ids.some((id) => !id) ||
        new Set(ids).size !== ids.length ||
        !ids.includes(result.recommended_branch_id)
      )
        throw new Error("梗分支编号不完整，请重试。");
      const job = r.jobs
        .filter(
          (j) =>
            j.stage === "analysis" &&
            j.status === "completed" &&
            j.revision === r.revision,
        )
        .at(-1);
      r.assets = registerAssets(
        result,
        path.join(this.folder(r), "work", job.id),
        job.id,
        r.revision,
      );
      r.analysis = result;
      r.status = "awaiting_confirmation";
      r.phase = "选择目标版本与数量上限";
      this.event(r, "Agent 已完成梗理解；请选择要做的版本并启动选题。");
    });
  }
  requireCurrent(r) {
    if (r.workflowVersion !== 3)
      throw new AppError("历史任务保留原版记录，请使用同一素材新建研究。", 409);
  }
  revise(id, input) {
    const r = this.get(id);
    this.requireCurrent(r);
    if (
      ![
        "awaiting_confirmation",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(r.status)
    )
      throw new AppError("当前不能修改，先等待任务结束", 409);
    const correction = this.validateText(
      input.correction,
      "纠正说明",
      12000,
      true,
    );
    this.analyze(r, correction);
    return clone(r);
  }
  confirm(id, input) {
    const r = this.get(id);
    this.requireCurrent(r);
    if (r.status !== "awaiting_confirmation")
      throw new AppError("请先完成并确认梗分析，不能跳过第一步", 409);
    if (input.revision !== r.revision)
      throw new AppError("这份梗理解已更新，请刷新后重新确认", 409);
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 50)
      throw new AppError("选题数量须为 1–50 的整数");
    const branch = r.analysis.branches.find((b) => b.id === input.branchId);
    if (!branch) throw new AppError("请选择有效的 meme 分支");
    const notes = this.validateText(input.notes ?? "", "确认补充", 12000);
    r.confirmed = {
      revision: r.revision,
      branch: clone(branch),
      notes,
      confirmedAt: new Date().toISOString(),
    };
    r.count = input.count;
    this.generate(r);
    return clone(r);
  }
  generate(r) {
    if (!r.confirmed || r.confirmed.revision !== r.revision)
      throw new AppError("没有当前修订的用户确认", 409);
    r.status = "generating";
    r.result = null;
    const assets = r.assets.filter(
      (a) =>
        a.revision === r.revision &&
        a.branchIds.includes(r.confirmed.branch.id),
    );
    this.launch(r, "generation", async (signal) => {
      if (!r.research || r.research.revision !== r.revision) {
        r.phase = "机制研究";
        this.save(r);
        const value = await this.stage(
          r,
          "research",
          "机制研究",
          researchSchema,
          { meme: r.meme, confirmed: r.confirmed, assets },
          signal,
        );
        checkResearch(value);
        if (!value.mechanisms.length)
          throw new Error("没有有效机制记录，请重试研究。");
        const job = r.jobs
          .filter((j) => j.stage === "research" && j.status === "completed")
          .at(-1);
        r.research = {
          ...value,
          revision: r.revision,
          jobId: job.id,
          timeLimited: !!job.timeLimited,
        };
        this.save(r);
      } else this.event(r, "复用当前修订已完成的机制研究");
      r.phase = "玩法改编";
      this.save(r);
      const result = await this.stage(
        r,
        "adaptation",
        "玩法改编",
        adaptationSchema,
        {
          meme: r.meme,
          confirmed: r.confirmed,
          assets,
          research: r.research,
          count: r.count,
        },
        signal,
      );
      checkAdaptation(result, r.count, r.research, assets);
      r.result = result;
      r.status = "completed";
      r.phase = "选题已完成";
      this.event(r, `${result.candidates.length} 个选题已完成。`);
    });
  }
  async stage(r, stage, label, schema, ctx, signal) {
    if (signal.aborted) throw new Error("已取消");
    const job = {
      id: randomUUID(),
      stage,
      label,
      revision: r.revision,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    r.jobs.push(job);
    this.event(r, label + "：已进入队列");
    try {
      return await this.pool.run(async () => {
        if (signal.aborted) throw new Error("已取消");
        job.status = "running";

        this.event(r, label + "：运行中");
        const dir = path.join(this.folder(r), "work", job.id);
        fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
        for (const name of stageSkills[stage])
          fs.cpSync(
            path.join(this.folder(r), "skills", name),
            path.join(dir, ".agents", "skills", name),
            { recursive: true },
          );
        job.skillNames = stageSkills[stage];
        const prior_artifacts = r.jobs
          .filter(
            (j) =>
              j.status === "completed" &&
              j.revision === r.revision &&
              (stage === "adaptation"
                ? j.stage === "analysis" ||
                  (j.stage === "research" && j.id === r.research?.jobId)
                : stage === "research" && j.stage === "analysis"),
          )
          .map((j) => ({
            stage: j.stage,
            directory: path.join(this.folder(r), "work", j.id),
          }));
        let result;
        try {
          result = await this.runner({
            stage,
            label,
            schema,
            dir,
            signal,
            ctx,
            timeoutMs:
              stage === "research" ? this.researchTimeoutMs : undefined,
            onStart: () => {
              job.startedAt = new Date().toISOString();
              job.budgetMs =
                stage === "research" ? this.researchTimeoutMs : null;
              this.save(r);
            },
            onSearch: (record) => {
              job.searches ??= [];
              job.searches.push(record);
              this.save(r);
            },
            prompt: prompt(
              stage,
              { ...ctx, python: this.python, prior_artifacts },
              skillText(path.join(this.folder(r), "skills"), stage),
            ),
            onEvent: (message) => {
              if (!signal.aborted) this.event(r, `${label} · ${message}`);
            },
          });
        } catch (e) {
          if (
            stage !== "research" ||
            e.code !== "STAGE_TIMEOUT" ||
            signal.aborted
          )
            throw e;
          try {
            result = JSON.parse(
              fs.readFileSync(
                path.join(dir, "research-checkpoint.json"),
                "utf8",
              ),
            );
            result.mechanisms = result.mechanisms.filter((m) => {
              try {
                checkResearch({ ...result, mechanisms: [m] });
                return true;
              } catch {
                return false;
              }
            });
            checkResearch(result);
            if (!result.mechanisms.length) throw Error();
          } catch {
            throw new Error(
              "研究达到 5 分钟时限，没有有效的已保存机制记录；请重试。日志已保留。",
            );
          }
          job.timeLimited = true;
          this.event(r, "研究达到时限，使用已有结果");
        }
        if (signal.aborted) throw new Error("已取消");
        validator(schema)(result);
        job.status = "completed";
        job.finishedAt = new Date().toISOString();
        this.save(r);
        return result;
      }, signal);
    } catch (e) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.finishedAt = new Date().toISOString();
      job.error = e.message;
      this.save(r);
      throw e;
    }
  }
  cancel(id) {
    const r = this.get(id),
      c = this.controllers.get(id);
    if (!c) throw new AppError("任务没有在运行", 409);
    c.abort();
    this.event(r, "正在停止 CLI 并移除排队任务…");
    return clone(r);
  }
  retry(id) {
    const r = this.get(id);
    this.requireCurrent(r);
    if (!["failed", "cancelled", "interrupted"].includes(r.status))
      throw new AppError("只有失败、中断或取消的任务可以重试", 409);
    if (r.lastAction === "generation" && r.confirmed) this.generate(r);
    else this.analyze(r, r.correction || "");
    return clone(r);
  }
  async idle(id) {
    await this.tasks.get(id);
  }
  async stop() {
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.tasks.values()]);
  }
}
