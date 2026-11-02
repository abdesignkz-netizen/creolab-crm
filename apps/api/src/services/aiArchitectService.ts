import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ARCHITECT_CHANNELS, AI_MANAGER_GOALS, architectAnswersSchema, architectPreviewSchema, architectSaveSchema,
  type ArchitectAnswers, type ArchitectConfig, type ArchitectItem, type ArchitectPreview, type ArchitectSavedDraft, type ArchitectState } from "@creolab/contracts";
import { requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { authForUserInTenant } from "./authService.ts";
import { getEntitlements } from "./entitlementService.ts";
import { PIPELINE_STAGES } from "./dealPipeline.ts";
import { parseAIAutomationSettings, parseScheduleWindow } from "./aiAutomationSettings.ts";

type Tx = Prisma.TransactionClient;
type ArchitectDraft = Prisma.ArchitectDraftGetPayload<Record<string, never>>;
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
function canonical(v: unknown): unknown {
  return Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, canonical(val)])) : v;
}
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const local = (a: ArchitectAnswers, ru: string, kk: string) => a.locale === "kk" ? kk : ru;
const channelTypes = { whatsapp: ["whatsapp_qr", "whatsapp_cloud", "whatsapp_seller"], telegram: ["telegram_bot"], instagram: ["instagram_direct"], "website-chat": ["website_chat"], form: ["form"] };
const channelNames = { whatsapp: "WhatsApp", telegram: "Telegram", instagram: "Instagram Direct", "website-chat": "Веб-чат", form: "Форма" };
const goalIds = { consultation: "answer_question", sales: "quote_request", qualification: "qualify_request", booking: "booking_request", product_order: "product_order_request", food_order: "food_order_request", support: "resolve_issue" } as const;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, "invalid_architect", "Проверьте ответы: неверный формат или превышен размер поля. / Жауаптардың пішімі мен көлемін тексеріңіз.");
  return result.data;
}
function checkSource(a: ArchitectAnswers) {
  // Known credential formats and explicit credential assignments are rejected before persistence.
  // No source text is ever sent to an LLM, executed, fetched as a URL or put in a system prompt.
  const source = [a.description, a.offerings, a.audience, a.otherRequirements].join("\n");
  if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\b\d{7,12}:[A-Za-z0-9_-]{25,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|secret|token|password|пароль|токен|құпиясөз)\s*[:=]\s*\S{4,}/iu.test(source)) {
    throw new ApiError(422, "architect_secret", local(a, "Уберите пароли и ключи из описания. Подключения настраиваются в разделе «Интеграции».", "Сипаттамадан құпиясөздер мен кілттерді алып тастаңыз. Қосылымдар «Интеграциялар» бөлімінде бапталады."));
  }
}
export async function authorizeArchitect(tx: Tx, auth: AuthContext) {
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Проект доступен владельцу или директору компании");
  const tenantId = requireTenant(auth).tenantId;
  const current = await authForUserInTenant(tx, auth.user.id, tenantId, auth.sessionId);
  requireCompanyAdmin(current);
  if (current.activeMembership?.tenantId !== tenantId) throw new ApiError(403, "forbidden", "Нет доступа к компании");
  return { current, tenantId };
}
export async function architectSnapshot(tx: Tx, tenantId: string) {
  const [tenant, members, stages, integrations, configs, knowledge, features, platform, publishedKnowledge, reusableKnowledge] = await Promise.all([
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, timezone: true, currency: true, settingsJson: true, workingHoursJson: true } }),
    tx.membership.findMany({ where: { tenantId, active: true, user: { status: "active" } }, orderBy: { id: "asc" }, take: 501,
      select: { id: true, role: true, permissions: true, user: { select: { name: true } } } }),
    tx.dealStage.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 101 }),
    tx.integration.findMany({ where: { tenantId, type: { in: Object.values(channelTypes).flat() } }, orderBy: { id: "asc" }, take: 101,
      select: { id: true, type: true, status: true, connectionStatus: true,
        channelConnections: { where: { tenantId, status: "active" }, orderBy: { id: "asc" }, select: { id: true, autoReply: true } },
        forms: { where: { tenantId, active: true }, orderBy: { id: "asc" }, select: { id: true } } } }),
    tx.aIConfiguration.findMany({ where: { tenantId, scope: "company" }, orderBy: { id: "asc" }, take: 2,
      select: { id: true, enabled: true, scenario: true, promptStatus: true, systemPrompt: true, draftPrompt: true, limitsJson: true } }),
    tx.knowledgeDocument.findMany({ where: { tenantId }, orderBy: { id: "asc" }, take: 2001, select: { id: true, status: true, updatedAt: true } }),
    getEntitlements(tx, tenantId), tx.platformSetting.findUnique({ where: { key: "defaults" }, select: { valueJson: true } }),
    tx.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::integer AS count FROM "KnowledgeDocument" WHERE "tenantId" = ${tenantId} AND status = 'published' AND LENGTH(BTRIM(content)) > 0`,
    // Bound the copy to the existing wizard's limits. Oversized knowledge is
    // retained in place and reviewed separately, never silently truncated.
    tx.$queryRaw<Array<{ id: string; title: string; content: string }>>`SELECT id, LEFT(title, 301) AS title, LEFT(content, 65001) AS content FROM "KnowledgeDocument" WHERE "tenantId" = ${tenantId} AND status = 'published' ORDER BY id LIMIT 41`,
  ]);
  if (members.length > 500 || stages.length > 100 || integrations.length > 100 || knowledge.length > 2000 || configs.length > 1) {
    throw new ApiError(422, "architect_scope_limit", "Для этой конфигурации используйте отдельные разделы настроек: объём превышает лимит помощника.");
  }
  const settings = record(tenant.settingsJson), config = configs[0], setup = record(record(config?.limitsJson).aiSetup);
  const automation = parseAIAutomationSettings(settings);
  if (Object.keys(record(tenant.workingHoursJson)).length) automation.workingHours = parseScheduleWindow(tenant.workingHoursJson, automation.workingHours);
  const e = features.entitlements;
  const plan = record(features.plan), planFeatures = { ...record(record(plan.plan).featuresJson), ...record(plan.featuresSnapshotJson) };
  const feature = (key: string) => Boolean(record(settings.features)[key] ?? planFeatures[key] ?? record(record(platform?.valueJson).features)[key] ?? true);
  const aiAvailable = Boolean(e.AI_MANAGER && feature("ai") && record(record(platform?.valueJson).ai).enabled !== false && !record(settings.runtime).aiPaused);
  const available = { whatsapp: e.WHATSAPP && feature("whatsapp"), telegram: e.TELEGRAM, instagram: e.INSTAGRAM, "website-chat": e.CHANNELS, form: e.CHANNELS && feature("forms") };
  const channels: ArchitectConfig["channels"] = ARCHITECT_CHANNELS.map(kind => {
    const matches = integrations.filter(i => channelTypes[kind].includes(i.type));
    const ready = matches.filter(i => i.status === "active" && (kind === "form" ? i.forms.length > 0
      : ["CONNECTED", "connected", "authorized"].includes(i.connectionStatus) && i.channelConnections.length > 0));
    return { kind, available: Boolean(available[kind]), connected: ready.length > 0,
      connectionIds: ready.flatMap(i => kind === "form" ? i.forms.map(f => f.id) : i.channelConnections.map(c => c.id)) };
  });
  // Only digests of published/private configuration participate in conflict detection; none is returned.
  const revision = hash({ tenant: { ...tenant, settingsJson: hash(settings) }, members, stages, integrations,
    config: hash(config || null), knowledge: knowledge.map(k => ({ ...k, updatedAt: k.updatedAt.toISOString() })),
    entitlements: e, available, aiAvailable, knowledgeContent: hash(reusableKnowledge) });
  return { tenant, members, stages, channels, config, setup, settings, e, aiAvailable, revision,
    knowledgeCount: publishedKnowledge[0].count, reusableKnowledge,
    existingAi: Boolean(config?.systemPrompt?.trim() || config?.draftPrompt?.trim() || setup.savedAt || setup.publishedAt),
    automation };
}
export type ArchitectSnapshot = Awaited<ReturnType<typeof architectSnapshot>>;
type Snapshot = ArchitectSnapshot;

export function buildArchitectPreview(s: Snapshot, a: ArchitectAnswers): ArchitectPreview {
  checkSource(a);
  const l = (ru: string, kk: string) => local(a, ru, kk);
  const questions: ArchitectPreview["questions"] = [], items: ArchitectItem[] = [];
  const ask = (field: keyof ArchitectAnswers, code: string, ru: string, kk: string) => questions.push({ field, code, text: l(ru, kk) });
  const selectedMember = s.members.find(m => m.id === a.responsibleMembershipId);
  if (a.responsibleMembershipId && !selectedMember) throw new ApiError(422, "architect_member", l("Выберите действующего сотрудника этой компании.", "Осы компанияның белсенді қызметкерін таңдаңыз."));
  if (!a.description) ask("description", "description", "Чем занимается компания и чем помогает клиенту?", "Компания немен айналысады және клиентке қалай көмектеседі?");
  if (!a.offerings) ask("offerings", "offerings", "Какие товары или услуги вы предлагаете?", "Қандай тауарлар не қызметтер ұсынасыз?");
  if (a.businessKind === "unknown") ask("businessKind", "business_kind", "Выберите основной процесс бизнеса.", "Бизнестің негізгі процесін таңдаңыз.");
  if (a.goal === "unknown" && a.replyMode !== "manual") ask("goal", "goal", "Какой результат должен получить клиент от ИИ?", "Клиент ЖИ-ден қандай нәтиже алуы керек?");
  if (!a.channels.length) ask("channels", "channel", "Выберите хотя бы один канал обращений.", "Өтінім келетін кемінде бір арнаны таңдаңыз.");
  if (!selectedMember) ask("responsibleMembershipId", "responsible", "Кто проверит заявки и поможет, если ИИ не знает ответа?", "Өтінімдерді кім тексеріп, ЖИ жауап білмесе кім көмектеседі?");
  if (a.hours.mode === "unknown") ask("hours", "hours", "Уточните, когда обрабатывать обращения.", "Өтінімдерді қашан өңдеу керегін көрсетіңіз.");
  if (a.hours.mode === "schedule" && (!a.hours.days.length || a.hours.start >= a.hours.end)) ask("hours", "schedule", "Укажите дни и дневной интервал: начало раньше окончания. Ночные смены настраиваются отдельно.", "Күндерді және басталуы аяқталудан ерте уақыт аралығын көрсетіңіз. Түнгі ауысымдар бөлек бапталады.");
  if (a.channels.length === 1 && a.channels[0] === "form" && a.replyMode === "auto") ask("replyMode", "form_auto", "Форма собирает заявку, но не ведёт диалог. Добавьте чат или выберите обработку сотрудником.", "Форма өтінімді жинайды, бірақ диалог жүргізбейді. Чат қосыңыз немесе қызметкердің өңдеуін таңдаңыз.");
  if ((a.businessKind === "food" && a.goal === "booking") || (a.businessKind === "booking" && ["product_order", "food_order"].includes(a.goal))) {
    ask("goal", "goal_mismatch", "Основной процесс и цель ИИ различаются. Уточните цель или выберите «Другой процесс».", "Негізгі процесс пен ЖИ мақсаты әртүрлі. Мақсатты нақтылаңыз немесе «Басқа процесс» таңдаңыз.");
  }
  if (a.otherRequirements) ask("otherRequirements", "custom_review", "Дополнительные пожелания сохранены для проверки. Они не включены в автоматические действия проекта.", "Қосымша тілектер тексеруге сақталды. Олар жобаның автоматты әрекеттеріне енгізілген жоқ.");
  if (a.replyMode !== "manual" && s.knowledgeCount === 0) ask("offerings", "knowledge", "Перед включением ответов добавьте проверенные цены, условия и ответы на вопросы в базу знаний.", "Жауаптарды қоспас бұрын тексерілген баға, шарттар мен жауаптарды білім қорына қосыңыз.");
  const goalId = a.goal === "unknown" ? null : goalIds[a.goal];
  const goal = AI_MANAGER_GOALS.find(g => g.id === goalId);
  const stages = s.stages.filter(st => !st.isArchived);
  const config: ArchitectConfig = {
    schemaVersion: 1, profile: { businessKind: a.businessKind, description: a.description, offerings: a.offerings, audience: a.audience, languages: a.languages },
    pipeline: { strategy: s.stages.length ? "preserve" : "create_missing", stages: s.stages.length
      ? stages.map(st => ({ id: st.id, systemKey: st.systemKey, name: st.name, terminal: st.isTerminal }))
      : PIPELINE_STAGES.map(st => ({ systemKey: st.systemKey, name: st.name, terminal: false })) },
    ai: { role: a.goal, goalPreset: goalId, goalText: goal?.goal[a.locale] || "", successCriteria: goal?.successCriteria[a.locale] || "",
      replyMode: a.replyMode, replyAudience: a.replyAudience, hours: a.hours,
      rules: ["approved_facts_only", "clarify_unknown", "human_on_request", "no_unverified_confirmation", "no_proactive_messages"],
      activation: "unchanged", existingConfiguration: s.existingAi },
    channels: a.channels.map(kind => s.channels.find(c => c.kind === kind)!),
    handoff: { membershipId: a.responsibleMembershipId, firstResponseMinutes: a.firstResponseMinutes, notificationChannel: "in_app", permissions: "unchanged" },
    task: { type: "follow_up", title: l("Проверить обращение и согласовать следующий шаг", "Өтінімді тексеріп, келесі қадамды келісу"), executor: "human", trigger: "review_required", existingAutomation: "preserve" },
  };
  items.push({ key: "profile", title: l("О вашем бизнесе", "Бизнесіңіз туралы"), disposition: "review",
    current: l("Исходные ответы владельца; факты ещё нужно проверить", "Иесінің бастапқы жауаптары; деректерді тексеру қажет"),
    proposed: [a.description, a.offerings, a.audience, a.languages.map(v => v === "ru" ? "Русский" : "Қазақша").join(", ")].filter(Boolean).join("\n"),
    reason: l("Эти сведения служат основой проекта. Они не заменяют утверждённую базу знаний и не публикуются как инструкции автоматически.", "Бұл мәліметтер жобаға негіз болады. Олар бекітілген білім қорын алмастырмайды және автоматты нұсқаулық ретінде жарияланбайды."),
    sources: ["description", "offerings", "audience", "languages"], to: "/settings/ai-manager" });
  items.push({ key: "pipeline", title: l("Путь клиента", "Клиент жолы"), disposition: s.stages.length ? "keep" : s.e.DEALS ? "propose" : "unavailable",
    current: stages.map(st => st.name).join(" → ") || l("Воронка не настроена", "Кезеңдер бапталмаған"),
    proposed: config.pipeline.stages.map(st => st.name).join(" → "),
    reason: l("Действующие этапы и сделки сохраняются. Для новой воронки используются поддерживаемые этапы BasQar; завершение отмечается результатом сделки.", "Қолданыстағы кезеңдер мен мәмілелер сақталады. Жаңа воронкаға BasQar кезеңдері ұсынылады; аяқталуы мәміле нәтижесімен белгіленеді."), sources: ["currentSettings", "capabilities"], to: "/settings?section=ops" });
  for (const c of config.channels) items.push({ key: `channel:${c.kind}`, title: channelNames[c.kind], disposition: !c.available ? "unavailable" : c.connected ? "keep" : "connect",
    current: l(c.connected ? "Есть активное подключение" : "Активное подключение не подтверждено", c.connected ? "Белсенді қосылым бар" : "Белсенді қосылым расталмаған"),
    proposed: l("Принимать обращения через выбранный канал", "Таңдалған арнадан өтінім қабылдау"),
    reason: l(!c.available ? "Возможность недоступна в текущем тарифе или настройках. Проект не меняет подписку." : c.connected ? "Используем существующее подключение без повторного создания." : "Подключите канал по обычной инструкции: QR, токен или вход в аккаунт. Проект не запрашивает секреты.",
      !c.available ? "Бұл мүмкіндік ағымдағы тарифте не баптауда қолжетімсіз. Жоба тарифті өзгертпейді." : c.connected ? "Бар қосылымды қайта құрмай пайдаланамыз." : "Арнаны QR, токен немесе аккаунтқа кіру арқылы қосыңыз. Жоба құпия деректер сұрамайды."),
    sources: ["channels", "currentSettings", "capabilities"], to: "/integrations" });
  const mode = a.replyMode === "manual" ? l("Отвечает сотрудник", "Қызметкер жауап береді") : a.replyMode === "assist" ? l("ИИ готовит подсказки, сотрудник проверяет", "ЖИ ұсыныс дайындайды, қызметкер тексереді") : l("ИИ отвечает в выбранных каналах после отдельного включения", "ЖИ бөлек қосылған соң таңдалған арналарда жауап береді");
  items.push({ key: "ai", title: l("Задача ИИ и правила ответа", "ЖИ міндеті мен жауап ережелері"), disposition: a.replyMode !== "manual" && !s.aiAvailable ? "unavailable" : s.existingAi ? "review" : "propose",
    current: l(s.existingAi ? "Есть собственный промпт или сохранённый мастер. Сохранить без перезаписи." : "Собственная инструкция ещё не подготовлена", s.existingAi ? "Промпт не сақталған баптау бар. Үстінен жазбай сақтау керек." : "Жеке нұсқаулық әлі дайындалмаған"),
    proposed: [mode, goal?.goal[a.locale]].filter(Boolean).join(". "), reason: l("Цель взята из выбранной функции. Ответы — по утверждённым фактам; неизвестное уточняется или передаётся человеку. Правила отправки и текущий промпт не меняются.", "Мақсат таңдалған функциядан алынды. Жауаптар бекітілген дерекке сүйенеді; белгісізі нақтыланады не адамға беріледі. Жіберу ережелері мен промпт өзгермейді."), sources: ["goal", "replyMode", "currentSettings"], to: "/settings/ai-manager" });
  const audience = a.replyAudience === "all" ? l("Все клиенты", "Барлық клиенттер") : a.replyAudience === "new" ? l("Только новые клиенты", "Тек жаңа клиенттер") : l("Только существующие клиенты", "Тек бар клиенттер");
  const dayNames = a.locale === "kk" ? ["Жс", "Дс", "Сс", "Ср", "Бс", "Жм", "Сб"] : ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  items.push({ key: "hours", title: l("Кому и когда отвечать", "Кімге және қашан жауап беру"), disposition: "review",
    current: l("Текущие правила остаются действующими", "Қазіргі ережелер күшінде қалады"),
    proposed: `${audience}. ${a.hours.mode === "always" ? l("Круглосуточно", "Тәулік бойы") : a.hours.mode === "schedule" ? `${[...a.hours.days].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)).map(d => dayNames[d]).join(", ")} · ${a.hours.start}–${a.hours.end} · ${s.tenant.timezone}` : l("Время нужно уточнить", "Уақытты нақтылау керек")}`,
    reason: l("Это желаемые правила проекта. Для новой аудитории точка отсчёта задаётся при включении; сейчас сообщения не отправляются.", "Бұл жобаның қалаулы ережелері. Жаңа клиенттер үшін есептеу басы қосу кезінде анықталады; қазір хабар жіберілмейді."), sources: ["replyAudience", "hours", "currentSettings"], to: "/settings/ai-automation" });
  items.push({ key: "handoff", title: l("Участие сотрудника", "Қызметкердің қатысуы"), disposition: selectedMember ? "propose" : "review",
    current: l("Роли и права сотрудников сохраняются", "Қызметкерлер рөлі мен құқықтары сақталады"),
    proposed: `${selectedMember?.user.name || l("Ответственный не выбран", "Жауапты таңдалмаған")}. ${a.firstResponseMinutes ? l(`Цель первого ответа: ${a.firstResponseMinutes} мин.`, `Алғашқы жауап мақсаты: ${a.firstResponseMinutes} мин.`) : l("Срок реакции не задан", "Жауап мерзімі көрсетілмеген")}`,
    reason: l("Выбирается существующий сотрудник. Задачи и уведомления внутри BasQar предлагаются для проверки; создание аккаунтов и изменение прав сюда не входят.", "Қолданыстағы қызметкер таңдалады. BasQar ішіндегі тапсырмалар мен хабарландырулар тексеруге ұсынылады; аккаунт құру мен құқық өзгерту кірмейді."), sources: ["responsibleMembershipId", "firstResponseMinutes"], to: "/settings?section=members" });
  items.push({ key: "task", title: l("Задачи и уведомления", "Тапсырмалар мен хабарландырулар"), disposition: s.e.TASKS ? "review" : "unavailable",
    current: l("Существующие правила автоматизации сохраняются", "Қолданыстағы автоматтандыру ережелері сақталады"),
    proposed: `${config.task.title}. ${l("Уведомить ответственного внутри BasQar", "Жауаптыға BasQar ішінде хабарлау")}`,
    reason: l("При передаче человеку нужен конкретный следующий шаг. Проект предлагает правило, но не создаёт задачи и не включает рассылку.", "Адамға беру кезінде нақты келесі қадам керек. Жоба ереже ұсынады, бірақ тапсырма құрмайды және тарату қоспайды."), sources: ["goal", "responsibleMembershipId", "currentSettings"], to: "/settings/ai-automation" });
  const limitations = [l("Проект составляется по выбранным ответам и проверенным шаблонам BasQar. Описание бизнеса сохраняется как исходные данные; цены и условия из него не подтверждаются автоматически.", "Жоба жауаптар мен BasQar үлгілері бойынша жасалады. Бизнес сипаттамасы бастапқы дерек ретінде сақталады; баға мен шарттар автоматты расталмайды."),
    l("Подключения, публикация знаний, включение ИИ и отправка сообщений выполняются отдельно в своих разделах. Сохранение проекта ничего из этого не запускает.", "Қосылым, білімді жариялау, ЖИ қосу және хабар жіберу өз бөлімдерінде орындалады. Жобаны сақтау оларды іске қоспайды.")];
  if (["booking", "product_order", "food_order"].includes(a.goal)) limitations.push(l("ИИ может собрать пожелания или состав заказа. Свободное время, остатки, оплату, доставку и окончательное подтверждение проверяет сотрудник; автоматическое бронирование и склад сюда не входят.", "ЖИ тілектерді не тапсырыс құрамын жинай алады. Бос уақыт, қор, төлем, жеткізу мен соңғы растауды қызметкер тексереді; автоматты бронь мен қойма бұл жобаға кірмейді."));
  const preview = { schemaVersion: 1 as const, generator: "validated_templates_v1" as const, baseRevision: s.revision, config, items, questions, limitations,
    canApply: false as const, readyForReview: !questions.length && !items.some(i => i.disposition === "unavailable") };
  return { ...preview, previewHash: hash({ answers: a, preview }) };
}

function saved(row: ArchitectDraft, s: Snapshot): ArchitectSavedDraft {
  if (row.schemaVersion !== 1) throw new ApiError(409, "architect_version", "Обновите страницу: версия проекта изменилась");
  return { id: row.id, revision: row.revision, answers: parse(architectAnswersSchema, row.answersJson), preview: row.previewJson as unknown as ArchitectPreview,
    savedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), stale: row.baseRevision !== s.revision, expired: row.expiresAt <= new Date(),
    appliedRevision: row.appliedRevision, appliedAt: row.appliedAt?.toISOString() || null, applicationRunId: row.applicationRunId };
}
export async function getArchitectState(db: PrismaClient, auth: AuthContext): Promise<ArchitectState> {
  return db.$transaction(async tx => {
    const { tenantId } = await authorizeArchitect(tx, auth), s = await architectSnapshot(tx, tenantId);
    const draft = await tx.architectDraft.findUnique({ where: { tenantId } });
    const aiDraft = record(s.setup.draft), company = record(aiDraft.company);
    // Reuse bounded facts, not custom prompts or integration credentials.
    const safe = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";
    const role = architectAnswersSchema.shape.goal.safeParse(aiDraft.primaryRole || "unknown");
    const offerings = Array.isArray(aiDraft.offerings) ? aiDraft.offerings.slice(0, 30).map(v => safe(record(v).name, 300)).filter(Boolean).join("; ") : "";
    const defaults = architectAnswersSchema.parse({ locale: auth.user.locale === "kk" ? "kk" : "ru", description: safe(company.description, 3000), audience: safe(company.audience, 600), offerings: safe(offerings, 1500),
      channels: s.channels.filter(c => c.connected).map(c => c.kind), goal: role.success ? role.data : "unknown",
      replyAudience: s.automation.replyAudience.audience, replyMode: s.automation.defaultMode === "MANUAL" ? "manual" : "assist" });
    return { companyName: s.tenant.name, timezone: s.tenant.timezone, revision: draft?.revision || 0, members: s.members.map(m => ({ id: m.id, name: m.user.name, role: m.role })),
      channels: s.channels, aiAvailable: s.aiAvailable, defaults, draft: draft ? saved(draft, s) : null };
  }, { isolationLevel: "RepeatableRead", timeout: 15000 });
}
export async function previewArchitect(db: PrismaClient, auth: AuthContext, input: unknown) {
  const { answers } = parse(architectPreviewSchema, input);
  return db.$transaction(async tx => {
    const { tenantId } = await authorizeArchitect(tx, auth);
    return buildArchitectPreview(await architectSnapshot(tx, tenantId), answers);
  }, { isolationLevel: "RepeatableRead", timeout: 15000 });
}
export async function saveArchitectDraft(db: PrismaClient, auth: AuthContext, input: unknown): Promise<ArchitectSavedDraft> {
  const body = parse(architectSaveSchema, input), tenantId = requireTenant(auth).tenantId;
  checkSource(body.answers);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${tenantId} AND "userId" = ${auth.user.id} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${auth.user.id} FOR SHARE`;
    await authorizeArchitect(tx, auth);
    const prior = await tx.architectDraft.findUnique({ where: { tenantId } }), s = await architectSnapshot(tx, tenantId);
    const requestHash = hash(body);
    if (prior?.requestId === body.requestId && prior.savedByUserId === auth.user.id) {
      if (prior.requestHash !== requestHash) throw new ApiError(409, "architect_idempotency", "Этот запрос уже сохранён с другими ответами");
      return saved(prior, s);
    }
    if ((prior?.revision || 0) !== body.revision) throw new ApiError(409, "architect_draft_conflict", "Проект уже изменён в другой вкладке. Обновите сохранённую версию.");
    if (prior?.applicationRunId && await tx.actionRun.count({ where: { id: prior.applicationRunId, tenantId, status: { in: ["queued", "running"] } } })) {
      throw new ApiError(409, "architect_applying", "Дождитесь завершения применения или отмените его перед изменением проекта.");
    }
    if (body.baseRevision !== s.revision) throw new ApiError(409, "architect_stale", "Настройки компании изменились. Заново сформируйте проект по текущим данным.");
    const preview = buildArchitectPreview(s, body.answers);
    if (preview.previewHash !== body.previewHash) throw new ApiError(409, "architect_preview_changed", "Ответы изменились. Сначала просмотрите новый проект.");
    const data = { schemaVersion: 1, revision: body.revision + 1, savedByUserId: auth.user.id, requestId: body.requestId, requestHash,
      baseRevision: s.revision, answersJson: json(body.answers), previewJson: json(preview), applicationRunId: null,
      expiresAt: new Date(Date.now() + 7 * 86400000) };
    const row = await tx.architectDraft.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "architect.draft_saved", entityType: "architect_draft", entityId: row.id,
      changes: { revision: row.revision, questions: preview.questions.length, applied: false } });
    return saved(row, s);
  }, { timeout: 15000 });
}
