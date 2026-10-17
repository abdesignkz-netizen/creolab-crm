import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@creolab/db";
import { CONTROL_ACTION_META, validateClientPhone, type ControlAction } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { safeEqual, sha256 } from "../lib/hash.ts";
import { writeAudit } from "../lib/audit.ts";
import { authorizeNativeControl, executeNativeControl, confirmNativeControl, controlAuthorizationVersion } from "./aiControlService.ts";
import { CHAT_ACTIONS, chatCommandSchema, cleanText, controlChatMenu, quickControlCommand, words, type ChatCommand, type ChatLanguage } from "./controlChatLanguage.ts";
import { chatSettings, record } from "./controlChatSettings.ts";
import { presentControlReply } from "./controlChatPresentation.ts";
import { parseControlChatWithLlm } from "./llmClient.ts";

const SESSION_MS = 30 * 60000;
const REQUEST_MS = 15 * 60000;
type Job = Awaited<ReturnType<PrismaClient["controlChatMessage"]["findUniqueOrThrow"]>>;
type Choice = { id: string; label: string };
type Draft = { command: ChatCommand; params: Record<string, unknown>; labels: Record<string, string> };
type Context = {
  selectedClient?: Choice;
  pendingId?: string;
  choices?: { field: string; items: Choice[]; draft: Draft };
  awaiting?: "client_query" | "task_text";
};
const asJson = (v: unknown) => v as Prisma.InputJsonValue;

/** Only call after provider authentication. Phone must be the provider's PN, never LID digits or message text. */
export async function routeControlWhatsApp(prisma: PrismaClient, integrationId: string, input: { eventId: string; phone?: string; text: string; at: Date }) {
  if (!input.phone || !/^\+?\d{7,15}$/.test(input.phone)) return false;
  const integration = await prisma.integration.findUnique({ where: { id: integrationId }, include: { tenant: true } });
  if (!integration || !["whatsapp_qr", "whatsapp_cloud"].includes(integration.type)) return false;
  const phone = validateClientPhone(`+${input.phone.replace(/\D/g, "")}`, integration.tenant.defaultRegion || "KZ");
  if (!phone.ok) return false;
  const identity = await prisma.controlIdentity.findFirst({ where: { tenantId: integration.tenantId, provider: "WHATSAPP", phoneNormalized: phone.normalized } });
  const prefs = chatSettings(identity?.metadata);
  if (!identity || !prefs || prefs.integrationId !== integrationId) return false;
  // Once configured as staff, a disabled channel must not become a customer conversation.
  if (!identity.enabled || !prefs.enabled || integration.status !== "active" || integration.tenant.status !== "active") return true;
  if (!Number.isFinite(input.at.getTime()) || input.at.getTime() > Date.now() + 60000 || input.at.getTime() < Date.now() - REQUEST_MS) return true;
  if (await prisma.controlChatMessage.findUnique({ where: { integrationId_eventKey: { integrationId, eventKey: input.eventId } } })) return true;
  const count = await prisma.controlChatMessage.count({ where: { identityId: identity.id, createdAt: { gt: new Date(Date.now() - 60000) } } });
  if (count >= 20) return true;
  await prisma.controlChatMessage.upsert({ where: { integrationId_eventKey: { integrationId, eventKey: input.eventId } }, update: {}, create: {
    tenantId: identity.tenantId, identityId: identity.id, integrationId, eventKey: input.eventId,
    text: input.text.length > 2000 ? "[control:too_long]" : /^control\s+/i.test(input.text.trim())
      ? (/^control\s+(\d{6})$/i.test(input.text.trim()) ? `Control #${sha256(input.text.trim().split(/\s+/)[1])}` : "Control [invalid]")
      : input.text, createdAt: input.at,
    identityVersion: identity.updatedAt.toISOString(),
  } });
  return true;
}

async function allowedActions(prisma: PrismaClient, job: Job) {
  // Read checks only; action execution always checks again.
  const ctx = await authorizeNativeControl(prisma, job.integrationId, job.identityId);
  return CHAT_ACTIONS.filter(action => {
    const access = ctx.access, meta = CONTROL_ACTION_META[action];
    if (Array.isArray(access.allowedActions) && access.allowedActions.length && !access.allowedActions.includes(action)) return false;
    if (meta.financial && !access.canReadFinancialData || meta.team && !access.canReadTeamData) return false;
    if (meta.riskLevel !== "READ" && (action.includes("TASK") || action === "CREATE_FOLLOW_UP") && !access.canCreateTasks) return false;
    if (meta.riskLevel !== "READ" && action.includes("DEAL") && !access.canModifyDeals) return false;
    return true;
  });
}

async function verifyPhone(prisma: PrismaClient, job: Job, codeHash: string) {
  const row = await prisma.controlIdentity.findUniqueOrThrow({ where: { id: job.identityId } });
  if (!row.enabled || !row.verificationCodeHash || !row.verificationExpiresAt || row.verificationExpiresAt.getTime() < Date.now()) throw new ApiError(410, "code_expired", "Код истёк. Создайте новый код в настройках Control.");
  // Persist failed attempts under a row lock; casing, retries and process restarts cannot reset the limit.
  const valid = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ControlIdentity" WHERE id = ${row.id} FOR UPDATE`;
    const current = await tx.controlIdentity.findUniqueOrThrow({ where: { id: row.id } });
    const attempts = Number(record(current.metadata).verificationAttempts || 0);
    const prefs = chatSettings(current.metadata);
    if (!current.enabled || !prefs?.enabled || prefs.integrationId !== job.integrationId || !current.verificationCodeHash || !current.verificationExpiresAt || current.verificationExpiresAt.getTime() < Date.now() || attempts >= 5) return false;
    const ok = safeEqual(codeHash, current.verificationCodeHash);
    await tx.controlIdentity.update({ where: { id: row.id }, data: {
      metadata: asJson({ ...record(current.metadata), verificationAttempts: ok ? 0 : attempts + 1 }),
      ...(ok ? { verifiedAt: new Date(), verificationCodeHash: null, verificationExpiresAt: null } : attempts >= 4 ? { verificationCodeHash: null } : {}),
    } });
    return ok;
  });
  if (!valid) throw new ApiError(403, "invalid_code", "Неверный код. После пяти попыток получите новый код в настройках Control.");
  await writeAudit(prisma, { tenantId: row.tenantId, actorUserId: row.userId, action: "control.identity_verified", entityType: "control_identity", entityId: row.id, changes: { provider: "WHATSAPP", transport: "direct" } });
}

async function runRequest(prisma: PrismaClient, job: Job, context: Context, lang: ChatLanguage) {
  const w = (ru: string, kk: string) => words(lang, ru, kk);
  const text = job.text.trim(), lower = text.toLowerCase();
  const actions: ControlAction[] = [];
  const execute = async (action: ControlAction, params: Record<string, unknown> = {}) => {
    actions.push(action);
    return executeNativeControl(prisma, job.integrationId, job.identityId, action, params, `chat:${job.id}:${action}`);
  };
  const reply = (text: string, next: Context = context) => ({ text, context: next, actions });
  const identity = await prisma.controlIdentity.findUniqueOrThrow({ where: { id: job.identityId } });
  if (!identity.verifiedAt) {
    const code = text.match(/^Control #([a-f0-9]{64})$/)?.[1];
    if (!code) return reply(w("Для подтверждения номера отправьте Control и код из настроек BasQar. Код действует 30 минут.", "Нөмірді растау үшін Control және BasQar баптауларындағы кодты жіберіңіз. Код 30 минут жарамды."), {});
    await verifyPhone(prisma, job, code);
  }
  const ctx = await authorizeNativeControl(prisma, job.integrationId, job.identityId);
  const timeZone = ctx.integration.tenant.timezone || "Asia/Almaty";
  const allowed = await allowedActions(prisma, job);
  if (!identity.verifiedAt || /^(?:меню|мәзір|menu|старт|start|помощь|көмек|0)$/i.test(text)) {
    if (context.pendingId) await prisma.controlConfirmation.updateMany({ where: { id: context.pendingId, identityId: job.identityId, tenantId: job.tenantId, status: "pending" }, data: { status: "canceled" } });
    return reply(controlChatMenu(lang, allowed), { selectedClient: context.selectedClient });
  }
  if (job.kind === "briefing") {
    const kinds = text.split(","); const blocks: string[] = [];
    // One message, including when morning and evening schedules coincide.
    for (const action of [...new Set<ControlAction>(kinds.flatMap(kind => kind === "morning" ? ["GET_TODAY_TASKS", "GET_SITUATION"] : ["GET_BUSINESS_SUMMARY", "GET_SITUATION"]))]) {
      if (!allowed.includes(action as typeof CHAT_ACTIONS[number])) continue;
      blocks.push(presentControlReply(action, await execute(action), lang, timeZone));
    }
    return reply(blocks.length ? blocks.join("\n\n") : w("Нет разрешённых данных для сводки. Проверьте доступ Control.", "Қорытынды үшін рұқсат етілген деректер жоқ. Control рұқсатын тексеріңіз."));
  }
  if (/^(?:отмена|отменить|cancel|болдырмау)$/i.test(text)) {
    if (context.pendingId) await prisma.controlConfirmation.updateMany({ where: { id: context.pendingId, tenantId: job.tenantId, identityId: job.identityId, status: "pending" }, data: { status: "canceled" } });
    return reply(w("Команда отменена. Напишите «Меню» или новый запрос.", "Команда тоқтатылды. «Мәзір» немесе жаңа сұрау жазыңыз."), { selectedClient: context.selectedClient });
  }
  if (context.pendingId) {
    const pending = await prisma.controlConfirmation.findFirst({ where: { id: context.pendingId, tenantId: job.tenantId, identityId: job.identityId, status: "pending", expiresAt: { gt: new Date() } } });
    if (!pending) return reply(w("Подтверждение истекло или уже использовано. Напишите команду заново.", "Растаудың мерзімі өткен немесе қолданылған. Команданы қайта жазыңыз."), { selectedClient: context.selectedClient });
    const token = pending.id.slice(-6).toUpperCase();
    if (!new RegExp(`^(?:подтвердить|растау|confirm)\\s+${token}$`, "i").test(text)) return reply(`${pending.summary}\n\n${w(`Для выполнения: Подтвердить ${token}. Для отмены: Отмена.`, `Орындау үшін: Растау ${token}. Тоқтату үшін: Болдырмау.`)}`);
    actions.push(pending.action as ControlAction);
    const result = await confirmNativeControl(prisma, job.integrationId, job.identityId, pending.id);
    return reply(presentControlReply(pending.action as ControlAction, result, lang, timeZone), { selectedClient: context.selectedClient });
  }
  if (/^(?:подтвердить|растау|confirm)(?:\s|$)/i.test(text)) return reply(w("Нет команды для подтверждения. Напишите запрос заново.", "Растайтын команда жоқ. Сұрауды қайта жазыңыз."));
  if (text === "[control:too_long]" || !text || text.startsWith("[WhatsApp:")) return reply(w("Отправьте команду текстом, до 2000 символов.", "Команданы мәтінмен жіберіңіз, 2000 таңбаға дейін."));
  let draft: Draft;
  if (context.choices) {
    const index = /^\d{1,2}$/.test(text) ? Number(text) - 1 : -1;
    const choice = context.choices.items[index];
    if (!choice) return reply(w("Выберите номер из последнего списка или напишите «Отмена».", "Соңғы тізімнен нөмірді таңдаңыз немесе «Болдырмау» жазыңыз."));
    draft = context.choices.draft;
    draft.params[context.choices.field] = choice.id; draft.labels[context.choices.field] = choice.label;
    if (context.choices.field === "clientId") context.selectedClient = choice;
    delete context.choices;
  } else {
    if (text === "5" || text === "6") await authorizeNativeControl(prisma, job.integrationId, job.identityId, text === "5" ? "FIND_CLIENT" : "CREATE_TASK");
    if (text === "5") return reply(w("Напишите имя или телефон клиента.", "Клиенттің атын немесе телефонын жазыңыз."), { ...context, awaiting: "client_query" });
    if (text === "6") return reply(w("Напишите название задачи. Чтобы указать срок или ответственного, отправьте полную команду, например: «Создай задачу подготовить КП завтра к 15:00». Ничего не сохранится до подтверждения.", "Тапсырма атауын жазыңыз. Мерзім немесе жауапты адам үшін толық команда жіберіңіз, мысалы: «Ертең 15:00-ге ұсыныс дайындау тапсырмасын құр». Растағанға дейін ештеңе сақталмайды."), { ...context, awaiting: "task_text" });
    let command: ChatCommand | null = context.awaiting === "client_query" ? { action: "FIND_CLIENT", query: text } : quickControlCommand(text);
    if (!command) command = await parseControlChatWithLlm(context.awaiting === "task_text" ? `Создай задачу: ${text}` : text, timeZone, new Date(), { prisma, tenantId: job.tenantId, integrationId: job.integrationId, userId: identity.userId });
    if (!command) return reply(w("Не удалось однозначно определить команду. Напишите «Меню» или уточните один запрос: что показать или какую задачу создать. Данные не изменены.", "Команданы нақты анықтау мүмкін болмады. «Мәзір» жазыңыз немесе бір сұрауды нақтылаңыз: нені көрсету немесе қандай тапсырма құру керек. Деректер өзгерген жоқ."));
    const checked = chatCommandSchema.safeParse(command);
    if (!checked.success) return reply(w("Уточните запрос. Данные не изменены.", "Сұрауды нақтылаңыз. Деректер өзгерген жоқ."));
    delete context.awaiting;
    draft = { command: checked.data, params: { period: command.period || "today" }, labels: {} };
  }
  const c = draft.command, p = draft.params;
  if (c.action === "GET_CLIENT_DETAILS" && c.query && !c.client) c.client = c.query;
  await authorizeNativeControl(prisma, job.integrationId, job.identityId, c.action);
  const choose = (field: string, candidates: Choice[]) => {
    const choices = candidates.slice(0, 8);
    context.choices = { field, items: choices, draft };
    return reply([w("Уточните выбор — напишите номер:", "Таңдауды нақтылаңыз — нөмірін жазыңыз:"), ...choices.map((r, i) => `${i + 1}. ${cleanText(r.label, 220)}`), w("Отмена — остановить команду.", "Болдырмау — команданы тоқтату.")].join("\n"));
  };
  if (c.action === "FIND_CLIENT" && !p.clientId) {
    if (!c.query) return reply(w("Напишите имя или телефон клиента.", "Клиенттің атын немесе телефонын жазыңыз."), { ...context, awaiting: "client_query" });
    const found = record(record(await execute("FIND_CLIENT", { query: c.query })).data).items || [];
    if (!found.length) return reply(w("Клиент не найден. Уточните имя или телефон.", "Клиент табылмады. Атын немесе телефонын нақтылаңыз."));
    return choose("clientId", found.map((r: any) => ({ id: r.id, label: `${r.name || r.label || "Клиент"}${r.phone ? ` · ${r.phone}` : ""}` })));
  }
  if (c.client && !p.clientId) {
    const found = record(record(await execute("FIND_CLIENT", { query: c.client })).data).items || [];
    if (!found.length) return reply(w("Клиент не найден. Уточните команду с именем или телефоном.", "Клиент табылмады. Командада атын немесе телефонын нақтылаңыз."));
    // Always ask, even for one match: a fuzzy match must not silently choose a customer.
    return choose("clientId", found.map((r: any) => ({ id: r.id, label: `${r.name || r.label}${r.phone ? ` · ${r.phone}` : ""}` })));
  }
  if (c.useSelectedClient && !p.clientId) {
    if (!context.selectedClient) return reply(w("Сначала найдите клиента через пункт 5, затем повторите команду.", "Алдымен 5-тармақ арқылы клиентті табыңыз, содан кейін команданы қайталаңыз."));
    p.clientId = context.selectedClient.id; draft.labels.clientId = context.selectedClient.label;
  }
  if (c.action === "GET_CLIENT_DETAILS" && !p.clientId) return reply(w("Напишите имя или телефон клиента.", "Клиенттің атын немесе телефонын жазыңыз."), { ...context, awaiting: "client_query" });
  if (p.clientId) await execute("GET_CLIENT_DETAILS", { clientId: p.clientId }); // current tenant/access, not stale context
  if ((c.deal || ["GET_DEAL", "MOVE_DEAL_STAGE", "ADD_DEAL_NOTE", "ASSIGN_DEAL"].includes(c.action)) && !p.dealId) {
    if (!c.deal && !c.query) return reply(w("Укажите название сделки в команде.", "Командада мәміленің атауын көрсетіңіз."));
    const found = record(record(await execute("FIND_DEAL", { query: c.deal || c.query })).data).items || [];
    if (!found.length) return reply(w("Сделка не найдена. Уточните название.", "Мәміле табылмады. Атауын нақтылаңыз."));
    return choose("dealId", found.map((r: any) => ({ id: r.id, label: r.title })));
  }
  if (["COMPLETE_TASK", "UPDATE_TASK", "ASSIGN_TASK"].includes(c.action) && !p.taskId) {
    if (!c.task) return reply(w("Укажите название существующей задачи.", "Бар тапсырманың атауын көрсетіңіз."));
    const rows = record(record(await execute("GET_TASKS", { query: c.task })).data).items || [];
    const found = rows.filter((r: any) => String(r.title || "").toLowerCase().includes(c.task!.toLowerCase()));
    if (!found.length) return reply(w("Задача не найдена среди доступных. Уточните название или откройте задачи в кабинете.", "Қолжетімді тапсырмалардан табылмады. Атауын нақтылаңыз немесе кабинеттегі тапсырмаларды ашыңыз."));
    return choose("taskId", found.map((r: any) => ({ id: r.id, label: `${r.title}${r.ownerName ? ` · ${r.ownerName}` : ""}` })));
  }
  if (p.dealId) await execute("GET_DEAL", { dealId: p.dealId });
  if (c.assignee && !p.ownerMembershipId) {
    if (!ctx.access.canReadTeamData) throw new ApiError(403, "forbidden", "Нет доступа к команде");
    const members = await prisma.membership.findMany({ where: { tenantId: job.tenantId, active: true, user: { name: { contains: c.assignee, mode: "insensitive" } } }, include: { user: true }, take: 8 });
    if (!members.length) return reply(w("Сотрудник не найден. Уточните имя.", "Қызметкер табылмады. Атын нақтылаңыз."));
    return choose("ownerMembershipId", members.map(r => ({ id: r.id, label: r.user.name })));
  }
  if (["ASSIGN_TASK", "ASSIGN_DEAL"].includes(c.action) && !p.ownerMembershipId) return reply(w("Укажите имя сотрудника, которому назначить работу.", "Жұмысты тағайындайтын қызметкердің атын көрсетіңіз."));
  if (c.action === "MOVE_DEAL_STAGE" && !p.stageId) {
    if (!c.stage) return reply(w("Укажите новый этап сделки.", "Мәміленің жаңа кезеңін көрсетіңіз."));
    await execute("GET_DEAL", { dealId: p.dealId });
    const stages = await prisma.dealStage.findMany({ where: { tenantId: job.tenantId, name: { contains: c.stage, mode: "insensitive" } }, take: 8 });
    if (!stages.length) return reply(w("Этап не найден в воронке сделки. Уточните название.", "Мәміле воронкасында кезең табылмады. Атауын нақтылаңыз."));
    return choose("stageId", stages.map(r => ({ id: r.id, label: r.name })));
  }
  if (["CREATE_TASK", "CREATE_FOLLOW_UP"].includes(c.action) && !c.title) return reply(w("Укажите название задачи.", "Тапсырманың атауын көрсетіңіз."));
  if (c.action === "UPDATE_TASK" && !c.title && !c.dueAt) return reply(w("Укажите новое название или срок задачи.", "Тапсырманың жаңа атауын немесе мерзімін көрсетіңіз."));
  if (c.action === "ADD_DEAL_NOTE" && !c.note) return reply(w("Укажите текст заметки.", "Ескертпе мәтінін көрсетіңіз."));
  Object.assign(p, { ...(c.title ? { title: c.title } : {}), ...(c.note ? { note: c.note } : {}), ...(c.query ? { query: c.query } : {}), ...(c.dueAt ? { dueAt: c.dueAt } : {}) });
  const writing = CONTROL_ACTION_META[c.action].riskLevel !== "READ";
  if (writing) {
    const preview = [c.title, c.note, ...Object.values(draft.labels), c.dueAt ? `${w("Срок", "Мерзімі")}: ${new Date(c.dueAt).toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU", { timeZone })}` : w("Срок не указан", "Мерзімі көрсетілмеген")];
    if (["CREATE_TASK", "CREATE_FOLLOW_UP"].includes(c.action) && !p.ownerMembershipId) {
      p.ownerMembershipId = ctx.auth.activeMembership!.id;
      preview.push(`${w("Ответственный", "Жауапты")}: ${cleanText(ctx.auth.user.name)}`);
    }
    p._controlPreview = preview.filter(Boolean).map(v => cleanText(v, 500)).join("\n");
  }
  const action = c.action === "FIND_CLIENT" && p.clientId ? "GET_CLIENT_DETAILS" : c.action;
  const result = await execute(action, p), r = record(result);
  if (r.status === "CONFIRMATION_REQUIRED") {
    context.pendingId = r.confirmationId;
    const token = String(r.confirmationId).slice(-6).toUpperCase();
    return reply(`${w("Проверьте изменение:", "Өзгерісті тексеріңіз:")}\n${r.summary}\n\n${w(`Для выполнения: Подтвердить ${token}\nДля отмены: Отмена\nПодтверждение действует 10 минут.`, `Орындау үшін: Растау ${token}\nТоқтату үшін: Болдырмау\nРастау 10 минут жарамды.`)}`);
  }
  return reply(presentControlReply(action, result, lang, timeZone));
}

/** Persistent per-person lease keeps replies, selections and confirmations in message order. */
export async function processControlChatRequests(prisma: PrismaClient, integrationId?: string) {
  const now = new Date();
  await prisma.controlChatMessage.updateMany({ where: { state: "processing", claimedAt: { lt: new Date(now.getTime() - 180000) } }, data: { state: "failed", error: "interrupted_check_history", finishedAt: now } });
  const pending = await prisma.controlChatMessage.findMany({ where: { state: "queued", ...(integrationId ? { integrationId } : {}) }, orderBy: [{ createdAt: "asc" }, { queueOrder: "asc" }], take: 10 });
  for (const job of pending) {
    const now = new Date();
    const identity = await prisma.controlIdentity.findUnique({ where: { id: job.identityId } });
    const prefs = chatSettings(identity?.metadata), lang = prefs?.language || "ru";
    if (!identity?.enabled || !prefs?.enabled || prefs.integrationId !== job.integrationId || job.identityVersion && identity.updatedAt.toISOString() !== job.identityVersion || now.getTime() - job.createdAt.getTime() > (job.kind === "briefing" ? 30 * 60000 : REQUEST_MS)) {
      await prisma.controlChatMessage.updateMany({ where: { id: job.id, state: "queued" }, data: { state: "skipped", error: "expired_or_disabled", finishedAt: now } }); continue;
    }
    const session = await prisma.controlChatSession.upsert({ where: { identityId_integrationId: { identityId: job.identityId, integrationId: job.integrationId } }, update: {}, create: { tenantId: job.tenantId, identityId: job.identityId, integrationId: job.integrationId, expiresAt: new Date(0) } });
    const owner = randomUUID();
    const claimed = await prisma.controlChatSession.updateMany({ where: { id: session.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseOwner: owner, leaseUntil: new Date(now.getTime() + 180000) } });
    if (!claimed.count) continue;
    try {
      const first = await prisma.controlChatMessage.findFirst({ where: { identityId: job.identityId, integrationId: job.integrationId, state: "queued" }, orderBy: [{ createdAt: "asc" }, { queueOrder: "asc" }], select: { id: true } });
      if (first?.id !== job.id) continue;
      const locked = await prisma.controlChatMessage.updateMany({ where: { id: job.id, state: "queued" }, data: { state: "processing", claimedAt: now } });
      if (!locked.count) continue;
      const current = await prisma.controlChatSession.findUniqueOrThrow({ where: { id: session.id } });
      const context = current.expiresAt > now ? record(current.contextJson) as Context : {};
      let accessVersion: string | null = null;
      if (identity.verifiedAt) {
        try { accessVersion = controlAuthorizationVersion(await authorizeNativeControl(prisma, job.integrationId, job.identityId)); } catch { /* reply contains only an access error */ }
      }
      let response: Awaited<ReturnType<typeof runRequest>>;
      try { response = await runRequest(prisma, job, context, lang); }
      catch (error) {
        const known = error instanceof ApiError;
        const text = words(lang, known ? error.message : "Не удалось обработать запрос. Проверьте историю Control перед повтором изменений. Для справки напишите «Меню».", "Сұрауды өңдеу мүмкін болмады. Өзгерістерді қайталамас бұрын Control тарихын тексеріңіз. Көмек үшін «Мәзір» жазыңыз.");
        response = { text, context: {}, actions: [] };
      }
      const fresh = await prisma.controlIdentity.findUniqueOrThrow({ where: { id: job.identityId } });
      if (!fresh.enabled || record(fresh.metadata).chatRevision !== record(identity.metadata).chatRevision || !chatSettings(fresh.metadata)?.enabled) {
        await prisma.controlChatMessage.update({ where: { id: job.id }, data: { state: "skipped", error: "settings_changed", finishedAt: new Date() } });
        continue;
      }
      if (!identity.verifiedAt && fresh.verifiedAt) {
        try { accessVersion = controlAuthorizationVersion(await authorizeNativeControl(prisma, job.integrationId, job.identityId)); } catch { /* revoked during verification */ }
      }
      await prisma.$transaction(async tx => {
        const held = await tx.controlChatSession.updateMany({ where: { id: session.id, leaseOwner: owner }, data: { contextJson: asJson(response.context), expiresAt: new Date(Date.now() + SESSION_MS) } });
        if (!held.count) throw new Error("Control lease lost");
        await tx.controlChatMessage.update({ where: { id: job.id }, data: { state: "ready", text: /^Control #[a-f0-9]{64}$/.test(job.text.trim()) ? "Control [code]" : job.text, replyText: response.text.slice(0, 7000), actionsJson: response.actions, identityVersion: fresh.updatedAt.toISOString(), accessVersion } });
      });
    } finally {
      await prisma.controlChatSession.updateMany({ where: { id: session.id, leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: null } });
    }
  }
}
