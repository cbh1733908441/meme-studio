// Research scheduling state only. No networking, model calls, or UI/deployment changes.
const copy = (value) => structuredClone(value);
const unique = (values) => [...new Set(values.filter((value) => value.trim()))];
const evidenceKey = (source) => JSON.stringify([source.url, source.support, source.mode]);
const factKeys = ["game", "platform_version", "gameplay", "rules", "controls",
  "feedback", "value_conditions", "relevance", "gaps"];
const facts = (record) => JSON.stringify(factKeys.map((key) => record[key]));

export function createResearchProgress(revision, budgetMs, maxRounds = 3) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 ||
      !Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 3)
    throw new Error("研究预算须为正整数毫秒，轮次须为 1–3 的整数");
  return {
    version: 1, revision, status: "partial", budgetMs, maxRounds,
    nextRound: 1, activeElapsedMs: 0, activeAttempt: null,
    jobIds: [], history: [], conflicts: {}, stopReason: null,
  };
}

export function remainingResearchMs(progress) {
  return Math.max(0, progress.budgetMs - progress.activeElapsedMs);
}

export function researchRoundBudget(progress) {
  const roundsLeft = progress.maxRounds - progress.nextRound + 1;
  const remaining = remainingResearchMs(progress);
  if (roundsLeft < 1 || remaining < 1) return 0;
  // Reserve room for later rounds; unused execution time rolls forward.
  return Math.max(1, Math.floor(remaining / roundsLeft));
}

export function researchReady(run) {
  if (!run.research || run.research.revision !== run.revision ||
      !run.research.mechanisms?.length) return false;
  if (run.reuseResearchOnly) return true; // Existing explicit readapt action.
  if (!run.researchProgress) return true; // Preserve pre-upgrade v3 records.
  return run.researchProgress.revision === run.revision &&
    run.researchProgress.status === "completed";
}

export function finishResearchAttempt(progress, job, elapsedMs, timedOut = false) {
  if (Object.hasOwn(job, "activeMs")) return;
  // A timeout consumed its reservation even when a fake/test clock did not move.
  job.activeMs = Math.ceil(Math.max(0, elapsedMs, timedOut ? job.budgetMs || 0 : 0));
  progress.activeElapsedMs += job.activeMs;
  progress.activeAttempt = null;
}

export function recoverResearchProgress(run) {
  const progress = run.researchProgress;
  if (!progress || progress.revision !== run.revision ||
      progress.status === "completed") return;
  const pending = progress.activeAttempt;
  if (pending) {
    const job = run.jobs.find((entry) => entry.id === pending.jobId);
    // After an unclean exit the exact process lifetime is unknown. Charge only
    // its reserved slice, never server downtime and never reset the whole budget.
    if (!job || !Object.hasOwn(job, "activeMs")) {
      progress.activeElapsedMs += pending.budgetMs;
      if (job) {
        job.activeMs = pending.budgetMs;
        job.activeMsEstimated = true;
      }
    }
    progress.activeAttempt = null;
  }
  progress.status = "interrupted";
}

export function mergeResearch(previous, value, progress, job) {
  progress.conflicts = Object.assign(Object.create(null), progress.conflicts);
  const mechanisms = new Map((previous?.mechanisms || []).map((m) => [m.id, copy(m)]));
  for (const proposed of value.mechanisms) {
    const before = mechanisms.get(proposed.id);
    if (!before) {
      mechanisms.set(proposed.id, copy(proposed));
      continue;
    }
    if (JSON.stringify(before) === JSON.stringify(proposed)) continue;
    const oldEvidence = new Set(before.sources.map(evidenceKey));
    const refreshedEvidence = proposed.sources.some((s) => !oldEvidence.has(evidenceKey(s)));
    const accepted = facts(before) === facts(proposed) || refreshedEvidence;
    progress.history.push({
      round: progress.nextRound, jobId: job.id, mechanismId: proposed.id,
      decision: accepted ? "accepted" : "conflict", before: copy(before),
      proposed: copy(proposed),
      reason: accepted ? "结构校验通过；事实修正附带更新的来源依据（未自动核验真实性）" :
        "事实发生变化但未提供更新的来源依据，保留原记录等待核验",
    });
    if (accepted) {
      mechanisms.set(proposed.id, copy(proposed));
      if (refreshedEvidence) delete progress.conflicts[proposed.id];
    } else {
      progress.conflicts[proposed.id] = `${proposed.id}：新旧记录冲突，需要更新来源依据`;
    }
  }
  const merged = [...mechanisms.values()];
  const queries = new Map();
  for (const query of [...(previous?.queries || []), ...value.queries])
    queries.set(JSON.stringify([query.purpose, query.query]), copy(query));
  const gaps = unique([
    ...value.gaps,
    ...merged.flatMap((m) => m.gaps.map((gap) => `${m.id}：${gap}`)),
    ...Object.values(progress.conflicts),
    ...(job.timeLimited ? ["本轮达到时限，须继续核验剩余缺口，不能视为完整研究"] : []),
  ]);
  progress.jobIds.push(job.id);
  const round = progress.nextRound++;
  progress.status = merged.length && !gaps.length && !job.timeLimited ? "completed" : "partial";
  return {
    summary: value.summary || previous?.summary || "",
    mechanisms: merged, queries: [...queries.values()], gaps,
    revision: progress.revision, jobId: job.id,
    timeLimited: Boolean(previous?.timeLimited || job.timeLimited),
    roundsCompleted: round,
  };
}
