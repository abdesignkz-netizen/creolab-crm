import type { PrismaClient } from "@creolab/db";
import type { ControlAction, ControlAnalysis, ControlAnalysisCard, DecisionRef } from "@creolab/contracts";
import { CONTROL_ACTION_META } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { CONTROL_PROFILES, CONTROL_ANALYSIS_LIMITS } from "./agentProfiles.ts";
import { controlPlanFollowup, type ControlPlanRequest } from "./controlPlanLanguage.ts";
import type { ControlChatExecutor } from "./controlChatService.ts";
import { controlAuthorizationVersion, authorizeWebControl } from "./aiControlService.ts";
import { businessMemoryContext } from "./businessMemoryService.ts";
import { listBusinessGoals } from "./businessGoalService.ts";
import { listBusinessInsights } from "./businessInsightService.ts";
import { getActionRun, previewActionPlan } from "./aiActionService.ts";
import { controlLink, presentControlReply } from "./controlChatPresentation.ts";
import { cleanText, words, type ChatLanguage } from "./controlChatLanguage.ts";
import { record } from "./controlChatSettings.ts";

const asOf = (now: Date) => now.toISOString();
type Clock = () => number;
class AnalysisBudget {
  reads = 0; limited = false;
  readonly started: number;
  private clock: Clock;
  readonly maxReads: number;
  private timeMs: number;
  constructor(clock: Clock, maxReads: number = CONTROL_ANALYSIS_LIMITS.reads, timeMs: number = CONTROL_ANALYSIS_LIMITS.timeMs) {
    this.clock = clock; this.maxReads = maxReads; this.timeMs = timeMs; this.started = clock();
  }
  elapsed() { return Math.max(0, this.clock() - this.started); }
  exhausted() { return this.limited || this.elapsed() >= this.timeMs; }
  async read<T>(work: () => Promise<T>): Promise<T> {
    if (this.reads >= this.maxReads || this.exhausted()) { this.limited = true; throw new ApiError(409, "analysis_budget", "Достигнут лимит анализа."); }
    this.reads++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Only read-only work is raced. A timed-out query can finish, never launch a write.
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { this.limited = true; reject(new ApiError(409, "analysis_budget", "Достигнут лимит времени анализа.")); }, Math.max(1, this.timeMs - this.elapsed())); });
      const value = await Promise.race([work(), timeout]);
      if (this.exhausted()) { this.limited = true; throw new ApiError(409, "analysis_budget", "Достигнут лимит времени анализа."); }
      return value;
    } finally { if (timer) clearTimeout(timer); }
  }
}

/** No model loop and no inferred writes: facts come only from existing ACL-aware tools. */
export async function prepareControlAnalysis(db: PrismaClient, request: ControlPlanRequest, options: {
  jobId: string; tenantId: string; executor: ControlChatExecutor; language: ChatLanguage;
  now?: Date; clock?: Clock; maxReads?: number; timeMs?: number;
}): Promise<{ text: string; analysis: ControlAnalysis; actions: ControlAction[] }> {
  const { executor, language } = options, now = options.now || new Date();
  const profile = CONTROL_PROFILES[request.profile], ctx = await executor.authorize();
  if (ctx.tenant.id !== options.tenantId) throw new ApiError(403, "forbidden", "Нет доступа к данным компании.");
  if (!["owner", "director", "sales_lead"].includes(ctx.auth.activeMembership!.role) || ctx.auth.configurationTenant) throw new ApiError(403, "forbidden", "Разбор компании доступен владельцу, директору и руководителю продаж. Для своих задач используйте обычные команды Control.");
  const authVersion = () => controlAuthorizationVersion({ ...ctx, identity: { userId: ctx.auth.user.id } });
  const initialVersion = authVersion();
  // All selected tools are authorized before the first data read. A profile cannot elevate access.
  for (const read of profile.reads) await executor.authorize(read.action);
  const fresh = async () => {
    const after = await executor.authorize();
    if (controlAuthorizationVersion({ ...after, identity: { userId: after.auth.user.id } }) !== initialVersion) throw new ApiError(403, "access_changed", "Права изменились во время анализа. Повторите запрос.");
  };
  const budget = new AnalysisBudget(options.clock || Date.now, Math.max(0, Math.min(options.maxReads ?? CONTROL_ANALYSIS_LIMITS.reads, CONTROL_ANALYSIS_LIMITS.reads)), Math.max(1, Math.min(options.timeMs ?? CONTROL_ANALYSIS_LIMITS.timeMs, CONTROL_ANALYSIS_LIMITS.timeMs)));
  const cards: ControlAnalysisCard[] = [], limitations: string[] = [], decisions: DecisionRef[] = [], actions: ControlAction[] = [];
  let unavailable = false;
  const read = async <T>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    try { return await budget.read(work); }
    catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
      unavailable = true;
      limitations.push(error instanceof ApiError && error.code === "analysis_budget" ? "Лимит анализа достигнут: показана только проверенная часть. План не подготовлен." : `${label}: не удалось проверить данные. Это не означает, что проблем нет.`);
      return undefined;
    }
  };
  for (const tool of profile.reads) {
    if (budget.exhausted()) break;
    const result = await read("Данные раздела", async () => {
      await executor.authorize(tool.action);
      actions.push(tool.action);
      return executor.execute(tool.action, tool.period ? request.period : {}, `analysis:${options.jobId}:${tool.action}`);
    });
    if (result) {
      const scope = tool.action === "GET_LEADS_STATS" ? words(language, "Здесь считаются заявки за выбранный период.", "Мұнда таңдалған кезеңдегі өтінімдер саналады.")
        : tool.action === "GET_SITUATION" ? words(language, "Текущая ситуация. «Ждут ответа» — число контактов, а не заявок.", "Ағымдағы жағдай. «Жауап күтіп отыр» — өтінімдер емес, байланыстар саны.") : "";
      const facts = presentControlReply(tool.action, result, language, ctx.tenant.timezone).split("\n").slice(1).join("\n").replace(/https?:\/\/[^\s]+/g, "").trim();
      cards.push({ kind: "facts", title: CONTROL_ACTION_META[tool.action].label, text: [scope, facts].filter(Boolean).join("\n\n").slice(0, 1600), href: tool.href, asOf: asOf(now) });
    }
  }
  // Company context can contain money and team details. Restrictive Control access
  // must not be bypassed through a goal, insight or management-decision title/body.
  const companyContext = ctx.access.canReadFinancialData && ctx.access.canReadTeamData && (!Array.isArray(ctx.access.allowedActions) || !ctx.access.allowedActions.length);
  if (companyContext && !budget.exhausted()) {
    const insights = await read("Выводы компании", () => listBusinessInsights(db, ctx.auth, {}, now));
    if (insights) {
      for (const item of insights.items.filter(i => profile.rules.includes(i.rule) && i.content && !i.stale).slice(0, 2)) {
        const c = item.content!;
        cards.push({ kind: "insight", title: cleanText(c.title, 160), text: `${cleanText(c.explanation, 600)}\n${cleanText(c.limitation, 220)}`, href: `/control?view=insights&insight=${item.id}`, asOf: item.checkedAt });
      }
      limitations.push("Выводы — выборка доступных актуальных сигналов. Отсутствие сигнала не доказывает отсутствие проблемы; полный список доступен в Control.");
    }
    if (!budget.exhausted()) {
      const goals = await read("Цели компании", () => listBusinessGoals(db, ctx.auth, {}, now));
      if (goals) for (const goal of goals.items.filter(g => profile.goals.includes(g.metric)).slice(0, 2)) {
        const measured = goal.current, reliable = !goal.stale && !goal.targetChanged && measured?.sample.status === "ready";
        cards.push({ kind: "goal", title: cleanText(goal.title, 160), text: reliable
          ? `Период: ${goal.from} — ${goal.to}. Факт: ${measured.sample.exact ?? measured.sample.value ?? "—"}${goal.currency ? ` ${goal.currency}` : goal.metric === "first_response_minutes" ? " мин" : " задач"}. Цель: ${goal.target ?? "—"}. ${cleanText(measured.sample.limitation, 240)}`
          : "Актуального полного замера нет. Откройте цель и проверьте данные; достижение не подтверждено.", href: `/control?view=goals&goal=${goal.id}`, asOf: measured?.asOf || asOf(now) });
      }
    }
    if (!budget.exhausted()) {
      const memory = await read("Решения компании", () => businessMemoryContext(db, ctx.auth, profile.topic ? { topic: profile.topic } : {}, now));
      if (memory) for (const entry of memory.entries.slice(0, 1)) {
        // Displayed as attributed context, never parsed as commands or permission.
        cards.push({ kind: "decision", title: cleanText(entry.title, 160), text: `${cleanText(entry.body, 600)}\nУтверждённое решение компании; оно не разрешает автоматическое выполнение.`, href: entry.href, asOf: memory.asOf });
        decisions.push({ id: entry.id, version: entry.version });
      }
      if (memory?.limited || (memory?.entries.length || 0) > 1) limitations.push("Включено одно актуальное решение по теме. Остальные решения проверьте в разделе «Решения компании».");
    }
  } else if (!companyContext) limitations.push("Цели, выводы и решения компании не включены: доступ Control к данным компании ограничен.");
  if (request.causal) limitations.unshift("Сам запрос не подтверждает падение продаж. Этот разбор не устанавливает причину: нужны сопоставимые завершённые периоды и проверка конкретных сделок. Текущие сигналы — направления проверки, а не доказательство причинности.");
  if (request.profile === "finance") limitations.push("Сумма успешных сделок и подтверждённые поступления — разные показатели. Разбор не является бухгалтерской сверкой и не подтверждает платежи.");
  limitations.push("Показатели за период и текущие открытые проблемы показаны отдельно. Это снимок на время проверки; рекомендации ещё не выполнены.");
  const analysis: ControlAnalysis = { profile: request.profile, title: profile.title, asOf: asOf(now), timezone: ctx.tenant.timezone,
    summary: "Данные проверены. Следующий шаг — предложение для руководителя.", cards: cards.slice(0, CONTROL_ANALYSIS_LIMITS.cards), limitations,
    suggestion: !unavailable && cards.length ? { title: profile.task, steps: profile.steps, href: profile.href, command: controlPlanFollowup(request) } : null,
    plan: null, budget: { reads: budget.reads, maxReads: budget.maxReads, modelCalls: 0, elapsedMs: budget.elapsed(), limited: budget.limited } };
  await fresh();
  if (request.mode === "plan" && analysis.suggestion && !budget.exhausted()) {
    try {
      // WhatsApp also requires platform access for A1 review. It is never enabled implicitly.
      await executor.authorize("CREATE_TASK");
      await authorizeWebControl(db, ctx.auth, "CREATE_TASK");
      if (record(record(ctx.tenant.settingsJson).runtime).aiPaused) throw new ApiError(409, "action_paused", "Работа ИИ приостановлена. План не подготовлен.");
      await fresh();
      if (budget.exhausted()) throw new ApiError(409, "analysis_budget", "Лимит времени достигнут. План не подготовлен.");
      const existing = await db.actionRun.findUnique({ where: { tenantId_userId_requestId: { tenantId: options.tenantId, userId: ctx.auth.user.id, requestId: options.jobId } }, select: { id: true } });
      const run = existing ? await getActionRun(db, ctx.auth, existing.id) : await previewActionPlan(db, ctx.auth, {
        requestId: options.jobId, title: profile.task, decisions,
        steps: [{ key: "review", kind: "task.create", type: "note", title: profile.task,
          // Generic internal checklist: no copied private financial/customer data in a shared task.
          description: `Проверка руководителем:\n${profile.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\nСоздание задачи само по себе не означает достижения результата.`,
          ownerMembershipId: ctx.auth.activeMembership!.id, ...(request.dueAt ? { dueAt: request.dueAt } : {}),
        }],
      });
      analysis.plan = { id: run.id, href: `/control?view=plans&run=${run.id}`, status: run.status, completed: run.completed, stepCount: run.steps.length };
      analysis.summary = run.status === "draft" ? "План подготовлен: одна внутренняя задача для вас. До подтверждения задача не создаётся." : "По этому запросу уже есть план. Проверьте его текущий результат по ссылке.";
      analysis.limitations.push(request.dueAt ? `Срок задачи: ${new Date(request.dueAt).toLocaleString("ru-RU", { timeZone: ctx.tenant.timezone })}.` : "Срок задачи не задан. При необходимости задайте его в карточке задачи после создания.");
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      analysis.limitations.push(error.message); analysis.summary = "Разбор готов. План не подготовлен — проверьте ограничение ниже.";
    }
  } else if (unavailable || budget.exhausted()) {
    analysis.summary = "Доступна только часть проверки. План не подготовлен.";
    analysis.suggestion = null;
  }
  await fresh();
  analysis.budget.elapsedMs = budget.elapsed();
  analysis.budget.limited ||= budget.exhausted() && !analysis.plan;
  analysis.limitations = [...new Set(analysis.limitations)];
  // The plain-text version is bounded for WhatsApp; cards remain structured in the platform.
  const head = [analysis.title, analysis.summary, `На ${now.toLocaleString(language === "kk" ? "kk-KZ" : "ru-RU", { timeZone: ctx.tenant.timezone })} (${ctx.tenant.timezone})`];
  // Keep each source link intact; arbitrary slicing could break the last URL.
  const excerpts: string[] = [];
  for (const card of analysis.cards) {
    const excerpt = `${card.title}\n${card.text.slice(0, 600)}\n${controlLink(card.href)}`;
    if (excerpts.join("\n\n").length + excerpt.length + 2 > 3300) break;
    excerpts.push(excerpt);
  }
  const notes = [...new Set(analysis.limitations)].map(s => `• ${s}`).join("\n");
  const next = analysis.suggestion ? `\n\n${words(language, "Предлагаемый следующий шаг", "Ұсынылатын келесі қадам")}: ${analysis.suggestion.title}\n${analysis.suggestion.steps.join("\n")}` : "";
  const planLink = analysis.plan ? `\n\nПроверить план и подтвердить выполнение:\n${controlLink(analysis.plan.href)}` : analysis.suggestion ? `\n\nДля подготовки: «${analysis.suggestion.command}».` : "";
  const text = `${head.join("\n")}\n\n${excerpts.join("\n\n")}\n\n${notes}${next}${planLink}`;
  return { text, analysis, actions };
}
