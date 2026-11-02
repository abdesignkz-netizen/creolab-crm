import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { AI_MANAGER_GOALS, aiManagerDraftSchema, architectAnswersSchema, architectApplySchema, architectApplyReviewSchema, emptyAiManagerDraft,
  type ArchitectAnswers, type ArchitectApplyChange, type ArchitectApplyReview, type AiManagerDraft } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { ApiError } from "../errors.ts";
import { authorizeArchitect, architectSnapshot, buildArchitectPreview, type ArchitectSnapshot } from "./aiArchitectService.ts";
import { actionHash } from "./aiActionRegistry.ts";
import { serializeActionRun, stopActionRun } from "./aiActionService.ts";
import { authForUserInTenant } from "./authService.ts";
import { ensureDealPipelineStages } from "./dealService.ts";
import { PIPELINE_STAGES } from "./dealPipeline.ts";
import { saveAiManagerSetupDraft } from "./aiManagerSetupService.ts";
import { saveAIAutomationSettingsInTransaction } from "./aiAutomationSettingsService.ts";
import { parseAIAutomationSettings, type AIAutomationSettings } from "./aiAutomationSettings.ts";
import { updateOnboarding } from "./onboardingService.ts";
import { requireFeature } from "./entitlementService.ts";

type Tx = Prisma.TransactionClient;
type Draft = Prisma.ArchitectDraftGetPayload<Record<string, never>>;
const withSteps = { steps: { orderBy: { position: "asc" as const } } };
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const options = { timeout: 30000, maxWait: 10000 };
const inProgress = ["queued", "running"];

async function ownDraft(tx: Tx, tenantId: string, id: string, revision: number) {
  const row = await tx.architectDraft.findFirst({ where: { id, tenantId } });
  if (!row) throw new ApiError(404, "not_found", "Проект не найден");
  if (row.schemaVersion !== 1 || row.revision !== revision) throw new ApiError(409, "architect_draft_conflict", "Версия проекта изменилась. Обновите сохранённый проект.");
  return row;
}
async function lockConfiguration(tx: Tx, tenantId: string, userId: string) {
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${tenantId} ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "AIConfiguration" WHERE "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "DealStage" WHERE "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "KnowledgeDocument" WHERE "tenantId" = ${tenantId} ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Integration" WHERE "tenantId" = ${tenantId} ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ChannelConnection" WHERE "tenantId" = ${tenantId} ORDER BY id FOR SHARE`;
}
function authorizationHash(auth: AuthContext) {
  const m = requireTenant(auth);
  return actionHash({ user: auth.user.id, member: m.id, role: m.role, permissions: m.permissions });
}
function instructions(a: ArchitectAnswers, s: ArchitectSnapshot, id: string): AiManagerDraft {
  const draft = emptyAiManagerDraft(s.tenant.name), preview = buildArchitectPreview(s, a);
  const goal = AI_MANAGER_GOALS.find(g => g.id === preview.config.ai.goalPreset)!;
  draft.primaryRole = a.goal === "unknown" ? "consultation" : a.goal;
  draft.knowledge = s.reusableKnowledge;
  draft.company.description = a.description; draft.company.audience = a.audience;
  draft.company.hours = a.hours.mode === "always" ? (a.locale === "kk" ? "Тәулік бойы" : "Круглосуточно")
    : `${a.hours.days.map(d => (a.locale === "kk" ? ["Жс", "Дс", "Сс", "Ср", "Бс", "Жм", "Сб"] : ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"])[d]).join(", ")} ${a.hours.start}–${a.hours.end} (${s.tenant.timezone})`;
  draft.offerings = [{ id: `architect-${id}`, name: a.offerings.slice(0, 300), description: a.offerings, price: "", includes: "", timing: "", restrictions: "" }];
  if (goal) draft.conversation = { ...draft.conversation, goalPreset: goal.id, goal: goal.goal[a.locale], questions: goal.questions[a.locale], completion: goal.completion[a.locale], successCriteria: goal.successCriteria[a.locale] };
  draft.handoff.when = a.locale === "kk" ? "Сұраққа бекітілген жауап жоқ; клиент адамды сұрады; шарттар мен тапсырысты растау керек." : "Нет утверждённого ответа; клиент просит человека; требуется согласовать условия или подтвердить запись/заказ.";
  draft.handoff.contact = s.members.find(m => m.id === a.responsibleMembershipId)?.user.name || "";
  return aiManagerDraftSchema.parse(draft);
}
function replyPatch(s: ArchitectSnapshot, a: ArchitectAnswers): Partial<AIAutomationSettings> {
  const current = s.automation, patch: Partial<AIAutomationSettings> = {};
  if (current.replyAudience.audience !== a.replyAudience) patch.replyAudience = { ...current.replyAudience, audience: a.replyAudience };
  if (a.firstResponseMinutes !== null && current.firstContactSlaMinutes !== a.firstResponseMinutes) patch.firstContactSlaMinutes = a.firstResponseMinutes;
  if (a.hours.mode === "always") {
    if (current.scheduleMode !== "always") patch.scheduleMode = "always";
    if (current.conversationHours.mode !== "always") patch.conversationHours = { ...current.conversationHours, mode: "always" };
  } else if (a.hours.mode === "schedule") {
    const window = { days: [...a.hours.days].sort(), start: a.hours.start, end: a.hours.end };
    if (current.scheduleMode !== "working_hours") patch.scheduleMode = "working_hours";
    if (actionHash(current.workingHours) !== actionHash(window) || actionHash(s.tenant.workingHoursJson) !== actionHash(window)) patch.workingHours = window;
    const hours: AIAutomationSettings["conversationHours"] = { mode: "schedule", offHoursBehavior: "no_reply", days: {} };
    for (let day = 0; day <= 6; day++) hours.days[day] = { enabled: a.hours.days.includes(day), start: a.hours.start, end: a.hours.end };
    if (actionHash(current.conversationHours) !== actionHash(hours)) patch.conversationHours = hours;
  }
  return patch;
}
function buildApplication(row: Draft, s: ArchitectSnapshot) {
  const a = architectAnswersSchema.parse(row.answersJson), preview = buildArchitectPreview(s, a);
  const t = (ru: string, kk: string) => a.locale === "kk" ? kk : ru;
  const changes: ArchitectApplyChange[] = [], pending: ArchitectApplyReview["pending"] = [];
  const blockers = preview.questions.filter(q => !["knowledge", "custom_review"].includes(q.code)).map(q => q.text);
  if (row.baseRevision !== s.revision) blockers.unshift(t("Настройки изменились. Пересоберите и сохраните проект перед применением.", "Баптаулар өзгерді. Қолданар алдында жобаны қайта жасап, сақтаңыз."));
  if (row.expiresAt <= new Date()) blockers.unshift(t("Прошло 7 дней. Обновите и сохраните проект.", "7 күн өтті. Жобаны жаңартып сақтаңыз."));
  if (record(s.settings.runtime).aiPaused) blockers.push(t("Работа ИИ приостановлена. Проверьте паузу в управлении; проект её не снимает.", "ЖИ жұмысы тоқтатылған. Басқарудағы үзілісті тексеріңіз; жоба оны жоймайды."));
  const pipeline = s.stages.length === 0 && Boolean(s.e.DEALS);
  if (pipeline) changes.push({ key: "pipeline", title: t("Создать начальные этапы сделок", "Бастапқы мәміле кезеңдерін құру"), before: t("Этапов нет", "Кезеңдер жоқ"), after: preview.config.pipeline.stages.map(st => st.name).join(" → "), to: "/settings?section=ops" });
  const knowledgeFits = s.reusableKnowledge.length <= 40 && s.reusableKnowledge.every(k => k.title.length <= 300 && k.content.length <= 65000);
  const aiDraft = a.replyMode !== "manual" && a.goal !== "unknown" && s.aiAvailable && !s.existingAi && knowledgeFits ? instructions(a, s, row.id) : null;
  if (aiDraft) changes.push({ key: "ai_draft", title: t("Подготовить черновик мастера ИИ", "ЖИ баптауының нобайын дайындау"),
    before: t("Собственные инструкции не сохранены", "Жеке нұсқаулық сақталмаған"),
    after: [aiDraft.company.description, aiDraft.offerings[0].description, aiDraft.company.audience,
      aiDraft.conversation.goal, aiDraft.conversation.questions, aiDraft.conversation.completion, aiDraft.conversation.successCriteria,
      `${t("Время", "Уақыт")}: ${aiDraft.company.hours}`, `${t("Контакт для передачи", "Беру контакті")}: ${aiDraft.handoff.contact}`, aiDraft.handoff.when,
      `${t("Существующие материалы базы знаний сохраняются в черновике", "Қолданыстағы білім материалдары нобайда сақталады")}: ${aiDraft.knowledge.length}.`,
      t("Черновик без публикации. Цены и условия нужно дополнить, ответы — проверить в тестовом чате.", "Жарияланбайтын нобай. Баға мен шарттарды толтырып, жауаптарды сынақ чатында тексеру керек.")].filter(Boolean).join("\n"), to: "/settings/ai-manager" });
  else if (s.existingAi) pending.push({ text: t("Собственный промпт и анкета сохранены без перезаписи. Сравните желаемую цель с действующей в мастере ИИ.", "Жеке промпт пен анкета өзгермейді. Қалаулы мақсатты қазіргі мақсатпен ЖИ баптауында салыстырыңыз."), to: "/settings/ai-manager" });
  else if (!knowledgeFits) pending.push({ text: t("База знаний превышает объём анкеты мастера ИИ. Материалы сохранены полностью; настройте инструкции отдельно.", "Білім қоры ЖИ баптау анкетасының көлемінен асады. Материалдар толық сақталады; нұсқаулықтарды бөлек баптаңыз."), to: "/settings/ai-manager" });
  const rules = s.aiAvailable && a.replyMode !== "manual" ? replyPatch(s, a) : {};
  if (Object.keys(rules).length) {
    const audience = (value: string) => value === "new" ? t("только новым", "тек жаңаларына") : value === "existing" ? t("только существующим", "тек бар клиенттерге") : t("всем", "барлығына");
    const describe = (v: AIAutomationSettings) => {
      const dayNames = a.locale === "kk" ? ["Жс", "Дс", "Сс", "Ср", "Бс", "Жм", "Сб"] : ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
      const windows = v.conversationHours.mode === "always" ? t("круглосуточно", "тәулік бойы") : Object.entries(v.conversationHours.days).filter(([, d]) => d.enabled).map(([day, d]) => `${dayNames[Number(day)]} ${d.start}–${d.end}`).join(", ");
      const intakeWindow = v.scheduleMode === "working_hours" ? v.workingHours : v.customSchedule;
      const intake = v.scheduleMode === "always" ? t("круглосуточно", "тәулік бойы") : `${intakeWindow.days.map(day => dayNames[day]).join(", ")} ${intakeWindow.start}–${intakeWindow.end}`;
      return `${t("Аудитория", "Аудитория")}: ${audience(v.replyAudience.audience)}. ${t("Ответы в диалогах", "Диалог жауаптары")}: ${windows} (${s.tenant.timezone}). ${t("Обработка новых заявок", "Жаңа өтінімдерді өңдеу")}: ${intake}. ${t("Цель первого ответа", "Алғашқы жауап мақсаты")}: ${v.firstContactSlaMinutes} ${t("мин", "мин")}.`;
    };
    changes.push({ key: "reply_rules", title: t("Сохранить аудиторию и время ответов", "Жауап аудиториясы мен уақытын сақтау"), before: describe(s.automation),
      after: `${describe({ ...s.automation, ...rules })}\n${a.hours.mode === "schedule" ? t("Вне выбранных часов ИИ не отвечает. Часы приёма новых заявок будут такими же.", "Таңдалған уақыттан тыс ЖИ жауап бермейді. Жаңа өтінім өңдеу уақыты бірдей болады.") : t("Время обработки новых заявок: круглосуточно.", "Жаңа өтінімдерді өңдеу уақыты: тәулік бойы.")}\n${a.replyAudience !== "all" ? t("Граница новых клиентов сохраняется, если она уже задана; иначе фиксируется при применении.", "Жаңа клиенттер шекарасы бұрын орнатылса сақталады; әйтпесе қолдану кезінде белгіленеді.") : ""}\n${t("Режим отправки, индивидуальные правила каналов и повторные сообщения сохраняются. Если автоответы уже включены, новая аудитория и часы начнут действовать сразу.", "Жіберу режимі, арна ережелері мен қайталама хабарлар сақталады. Автожауап қосулы болса, жаңа аудитория мен уақыт бірден күшіне енеді.")}`,
      to: "/settings/ai-automation" });
  }
  const firstChannel = a.channels[0], onboarding = record(s.settings.onboarding);
  const route = firstChannel && !onboarding.startedAt && !onboarding.channel && s.channels.find(c => c.kind === firstChannel)?.available
    ? { channel: firstChannel, replyMode: (a.replyMode === "manual" || firstChannel === "form" ? "manual" : "ai") as "manual" | "ai" } : null;
  if (route) changes.push({ key: "onboarding", title: t("Выбрать маршрут первого запуска", "Алғашқы іске қосу бағытын таңдау"), before: t("Маршрут ещё не выбран", "Бағыт әлі таңдалмаған"), after: `${firstChannel} · ${route.replyMode === "ai" ? t("обучение ИИ и проверка первого ответа", "ЖИ оқыту және алғашқы жауапты тексеру") : t("обработка сотрудником", "қызметкердің өңдеуі")}`, to: "/start" });
  for (const item of preview.items.filter(i => ["connect", "unavailable"].includes(i.disposition))) pending.push({ text: `${item.title}: ${item.reason}`, to: item.to });
  if (a.replyMode !== "manual") pending.push({ text: t("Проверьте знания и языки ответов, проведите тесты, затем отдельно опубликуйте инструкции и выберите режим ИИ в каналах. Проект не включает автоответы.", "Білім мен жауап тілдерін тексеріп, сынақтан соң нұсқаулықтарды бөлек жариялап, арнадағы ЖИ режимін таңдаңыз. Жоба автожауапты қоспайды."), to: "/settings/ai-manager" });
  else pending.push({ text: t("Проверьте ручной режим ответов в каналах. Уже включённые автоответы проект не отключает.", "Арналардың қолмен жауап беру режимін тексеріңіз. Жоба бұрын қосылған автожауапты өшірмейді."), to: "/settings/ai-automation" });
  pending.push({ text: t("Проверьте назначение сотрудника, создание задач и его уведомления в автоматизации. Права, действующие назначения и уведомления не меняются.", "Автоматтандыруда қызметкерді тағайындау, тапсырма құру және хабарландыруларын тексеріңіз. Құқықтар, тағайындаулар мен хабарландырулар өзгермейді."), to: "/settings/ai-automation" });
  if (a.otherRequirements) pending.push({ text: t("Дополнительные пожелания требуют отдельной настройки: ", "Қосымша тілектер бөлек баптауды қажет етеді: ") + a.otherRequirements, to: "/settings/ai-automation" });
  const plan = { version: 1, draftId: row.id, revision: row.revision, baseRevision: s.revision, pipeline, aiDraft, rules, route, changes, pending };
  const applicationHash = actionHash(plan);
  return { plan, blockers, applicationHash };
}
async function checkFeatures(tx: Tx, auth: AuthContext, plan: ReturnType<typeof buildApplication>["plan"]) {
  if (plan.pipeline) await requireFeature(tx, auth, "DEALS");
  if (plan.aiDraft || Object.keys(plan.rules).length) await requireFeature(tx, auth, "AI_MANAGER");
}
async function relatedRun(tx: Tx, row: Draft) {
  if (!row.applicationRunId) return null;
  return tx.actionRun.findFirst({ where: { id: row.applicationRunId, tenantId: row.tenantId }, include: withSteps });
}
export async function reviewArchitectApplication(db: PrismaClient, auth: AuthContext, id: string, raw: unknown): Promise<ArchitectApplyReview> {
  const input = architectApplyReviewSchema.parse(raw);
  return db.$transaction(async tx => {
    const { current, tenantId } = await authorizeArchitect(tx, auth), row = await ownDraft(tx, tenantId, id, input.revision);
    const run = await relatedRun(tx, row);
    if (run && (inProgress.includes(run.status) || row.appliedRevision === row.revision)) {
      const stored = record(run.snapshotJson).review as ArchitectApplyReview;
      return { ...stored, canApply: false, blockers: [], run: { ...serializeActionRun(run), canCancel: run.userId === current.user.id && inProgress.includes(run.status) } };
    }
    const built = buildApplication(row, await architectSnapshot(tx, tenantId));
    return { draftId: id, revision: row.revision, applicationHash: built.applicationHash, expiresAt: row.expiresAt.toISOString(),
      canApply: !built.blockers.length && built.plan.changes.length > 0, blockers: built.blockers, changes: built.plan.changes, pending: built.plan.pending,
      run: run ? { ...serializeActionRun(run), canCancel: false } : null };
  }, { ...options, isolationLevel: "RepeatableRead" });
}
export async function applyArchitect(db: PrismaClient, auth: AuthContext, id: string, raw: unknown) {
  const input = architectApplySchema.parse(raw), tenantId = requireTenant(auth).tenantId;
  return db.$transaction(async tx => {
    await lockConfiguration(tx, tenantId, auth.user.id);
    const { current } = await authorizeArchitect(tx, auth), requestHash = actionHash({ id, ...input });
    const existing = await tx.actionRun.findUnique({ where: { tenantId_userId_requestId: { tenantId, userId: auth.user.id, requestId: input.requestId } }, include: withSteps });
    if (existing) {
      if (existing.requestHash !== requestHash || record(existing.snapshotJson).source !== "architect") throw new ApiError(409, "idempotency_conflict", "Запрос уже использован для другого действия");
      return serializeActionRun(existing);
    }
    const row = await ownDraft(tx, tenantId, id, input.revision), prior = await relatedRun(tx, row);
    if (prior && (inProgress.includes(prior.status) || row.appliedRevision === row.revision)) {
      if (record(prior.snapshotJson).planHash !== input.applicationHash) throw new ApiError(409, "architect_preview_changed", "Откройте текущий результат применения проекта");
      return { ...serializeActionRun(prior), canCancel: prior.userId === current.user.id && inProgress.includes(prior.status) };
    }
    const { plan, blockers, applicationHash } = buildApplication(row, await architectSnapshot(tx, tenantId));
    if (blockers.length) throw new ApiError(409, "architect_not_ready", blockers[0]);
    if (!plan.changes.length) throw new ApiError(409, "architect_no_changes", "Нет изменений для применения. Выполните оставшиеся настройки и подключения из списка.");
    if (applicationHash !== input.applicationHash) throw new ApiError(409, "architect_preview_changed", "Список изменений устарел. Просмотрите его ещё раз.");
    await checkFeatures(tx, current, plan);
    const runId = randomUUID(), expiresAt = new Date(Math.min(row.expiresAt.getTime(), Date.now() + 30 * 60000));
    const title = record(row.answersJson).locale === "kk" ? "Компанияны баптау жобасын қолдану" : "Применение проекта настройки компании";
    const review: ArchitectApplyReview = { draftId: id, revision: row.revision, applicationHash, expiresAt: row.expiresAt.toISOString(), canApply: false, blockers: [], changes: plan.changes, pending: plan.pending, run: null };
    const confirmation = await tx.controlConfirmation.create({ data: { tenantId, userId: current.user.id, source: "ARCHITECT", action: "ARCHITECT_APPLY",
      status: "confirmed", confirmedAt: new Date(), paramsJson: { runId, draftId: id, revision: row.revision, planHash: applicationHash }, summary: title, requestId: `architect:${runId}`, expiresAt } });
    const run = await tx.actionRun.create({ data: { id: runId, tenantId, userId: current.user.id, initiatorMembershipId: current.activeMembership!.id,
      requestId: input.requestId, requestHash, title, status: "queued", confirmedAt: new Date(), expiresAt, confirmationId: confirmation.id,
      snapshotJson: json({ version: 1, source: "architect", planHash: applicationHash, authorizationHash: authorizationHash(current), draftId: id, revision: row.revision, review }),
      steps: { create: plan.changes.map((c, position) => ({ position, key: c.key, kind: "architect.settings", label: c.title, detail: c.after,
        inputJson: { draftId: id, revision: row.revision }, snapshotJson: { baseRevision: plan.baseRevision } })) } }, include: withSteps });
    const event = await tx.outboxEvent.create({ data: { tenantId, type: "ai.action_run", entityType: "action_run", entityId: run.id, payloadJson: { version: 1 } } });
    await tx.actionRun.update({ where: { id: run.id }, data: { outboxId: event.id } });
    await tx.architectDraft.update({ where: { id }, data: { applicationRunId: run.id } });
    await writeAudit(tx, { tenantId, actorUserId: current.user.id, action: "architect.application_confirmed", entityType: "action_run", entityId: run.id,
      changes: { revision: row.revision, fields: plan.changes.map(c => c.key) } });
    return serializeActionRun(run);
  }, options);
}

/** A configuration project is atomic: all local changes and receipts commit together. */
export async function processArchitectApplication(db: PrismaClient, tenantId: string, id: string) {
  const head = await db.actionRun.findFirst({ where: { id, tenantId } });
  if (!head || !inProgress.includes(head.status) || record(head.snapshotJson).source !== "architect") return;
  await db.$transaction(async tx => {
    await lockConfiguration(tx, tenantId, head.userId);
    await tx.$queryRaw`SELECT id FROM "ActionRun" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const run = await tx.actionRun.findFirstOrThrow({ where: { id, tenantId }, include: withSteps });
    if (!inProgress.includes(run.status)) return;
    const snap = record(run.snapshotJson);
    if (run.expiresAt <= new Date()) { await stopActionRun(tx, run, "expired", "architect_expired", "Срок применения истёк. Рабочие настройки не изменены."); return; }
    await tx.$executeRawUnsafe("SAVEPOINT architect_apply");
    try {
      const auth = await authForUserInTenant(tx, run.userId, tenantId), { current } = await authorizeArchitect(tx, auth);
      if (authorizationHash(current) !== snap.authorizationHash) throw new ApiError(409, "architect_access_changed", "Права инициатора изменились. Подтвердите проект заново.");
      const row = await ownDraft(tx, tenantId, snap.draftId, snap.revision), s = await architectSnapshot(tx, tenantId);
      const { plan, blockers, applicationHash } = buildApplication(row, s);
      if (row.applicationRunId !== id || row.appliedRevision === row.revision || snap.version !== 1 || blockers.length || applicationHash !== snap.planHash
        || run.steps.length !== plan.changes.length || run.steps.some((step, i) => step.status !== "pending" || step.kind !== "architect.settings" || step.key !== plan.changes[i].key)) {
        throw new ApiError(409, "architect_changed", blockers[0] || "Проект или настройки изменились. Рабочие настройки не изменены; подготовьте новое сравнение.");
      }
      await checkFeatures(tx, current, plan);
      const refs: Record<string, unknown> = {};
      if (plan.pipeline) {
        const stages = await ensureDealPipelineStages(tx, tenantId);
        if (stages.length !== PIPELINE_STAGES.length) throw new ApiError(409, "architect_postcondition", "Не удалось подтвердить создание этапов");
        refs.pipeline = stages.map(stage => ({ id: stage.id, systemKey: stage.systemKey }));
      }
      if (plan.aiDraft) {
        const result = await saveAiManagerSetupDraft(tx, current, { revision: Number(s.setup.revision || 0), draft: plan.aiDraft });
        if (actionHash(result.draft) !== actionHash(plan.aiDraft)) throw new ApiError(409, "architect_postcondition", "Не удалось подтвердить сохранение черновика");
        refs.ai_draft = { revision: result.revision };
      }
      if (Object.keys(plan.rules).length) {
        const result = await saveAIAutomationSettingsInTransaction(tx, current, plan.rules, { preferencesOnly: true });
        if (result.salesChanged) throw new ApiError(409, "architect_postcondition", "Проект не должен менять действующий процесс продажи");
        refs.reply_rules = Object.keys(plan.rules);
      }
      if (plan.route) {
        const result = await updateOnboarding(tx, current, plan.route);
        if (result.channel !== plan.route.channel || result.replyMode !== plan.route.replyMode) throw new ApiError(409, "architect_postcondition", "Не удалось подтвердить маршрут первого запуска");
        refs.onboarding = plan.route;
      }
      const after = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const afterAi = await tx.aIConfiguration.findFirst({ where: { tenantId, scope: "company" } });
      if (afterAi && (afterAi.enabled !== (s.config?.enabled ?? false) || afterAi.systemPrompt !== (s.config?.systemPrompt ?? null)
        || afterAi.draftPrompt !== (s.config?.draftPrompt ?? null) || afterAi.promptStatus !== (s.config?.promptStatus ?? "draft"))) {
        throw new ApiError(409, "architect_postcondition", "Опубликованные инструкции и включение ИИ должны сохраняться без изменений");
      }
      const afterRules = parseAIAutomationSettings(after.settingsJson);
      for (const key of Object.keys(plan.rules) as Array<keyof AIAutomationSettings>) {
        const equal = key === "replyAudience" ? afterRules.replyAudience.audience === plan.rules.replyAudience?.audience
          : actionHash(afterRules[key]) === actionHash(plan.rules[key]);
        if (!equal) throw new ApiError(409, "architect_postcondition", "Не удалось подтвердить сохранение правил ответов");
      }
      if (afterRules.defaultMode !== s.automation.defaultMode || afterRules.autoStartAiManager !== s.automation.autoStartAiManager || afterRules.allowProactiveOutbound !== s.automation.allowProactiveOutbound) {
        throw new ApiError(409, "architect_postcondition", "Режим отправки не должен меняться автоматически");
      }
      for (const step of run.steps) await tx.actionStep.update({ where: { id: step.id }, data: { status: "succeeded", finishedAt: new Date(), resultJson: json({ summary: "Сохранено. " + step.label, references: refs[step.key] }) } });
      await tx.architectDraft.update({ where: { id: row.id }, data: { appliedRevision: row.revision, appliedAt: new Date() } });
      await tx.actionRun.update({ where: { id }, data: { status: "succeeded", finishedAt: new Date() } });
      await tx.controlConfirmation.update({ where: { id: run.confirmationId! }, data: { status: "executed", executedAt: new Date(), resultJson: { runId: id, status: "succeeded" } } });
      await writeAudit(tx, { tenantId, actorUserId: run.userId, action: "architect.applied", entityType: "architect_draft", entityId: row.id, correlationId: id,
        changes: { revision: row.revision, fields: plan.changes.map(c => c.key), references: refs, externalActions: false } });
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT architect_apply");
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT architect_apply");
      await stopActionRun(tx, run, "failed", error.code, `${error.message} Изменения проекта не применены.`, run.steps[0]?.id);
    }
  }, options);
}
