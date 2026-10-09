import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { aiManagerDraftSchema, compileAiManagerDraft, emptyAiManagerDraft, type AiManagerDraft, type AiSetupState, type AiSetupKnowledge } from "@creolab/contracts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { requireAiSettingsAccess, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeAudit } from "../lib/audit.ts";
import { requireFeature } from "./entitlementService.ts";
import { invalidateRuntimeConfig } from "./runtimeSettings.ts";
import { pushAiConfigToWhatsApp, readActivation } from "./tenantAiConfigService.ts";

type Snapshot = { id: string; createdAt: string; label: string; prompt: string; knowledge: AiSetupKnowledge[]; draft: AiManagerDraft | null };
type Store = { schema: 1; revision: number; draft: AiManagerDraft; savedAt: string | null; publishedAt: string | null; baseFingerprint: string; currentVersionId: string | null; versions: Snapshot[] };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const fingerprint = (prompt: string, docs: AiSetupKnowledge[]) => createHash("sha256").update(JSON.stringify([prompt, docs.map(d => `${d.title}\n${d.content}`).sort()])).digest("hex");
const revisionSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(422, "invalid_ai_setup", "Проверьте поля анкеты: текст слишком длинный или формат данных неверный.");
  return result.data;
}
function access(auth: AuthContext) { requireAiSettingsAccess(auth); return requireTenant(auth).tenantId; }
function checkRevision(store: Store, revision: number) {
  if (store.revision !== revision) throw new ApiError(409, "ai_setup_conflict", "Настройки изменились в другой вкладке. Обновите страницу перед сохранением.");
}
async function locked<T>(prisma: PrismaClient, tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    if (!rows.length) throw new ApiError(404, "not_found", "Компания не найдена");
    return fn(tx);
  }, { timeout: 15000 });
}
async function load(tx: Prisma.TransactionClient, tenantId: string) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  let config = await tx.aIConfiguration.findFirst({ where: { tenantId } });
  if (!config) config = await tx.aIConfiguration.create({ data: { tenantId, promptStatus: "draft", enabled: false } });
  const docs = await tx.knowledgeDocument.findMany({ where: { tenantId, status: "published" }, orderBy: { id: "asc" } });
  const prompt = config.promptStatus === "published" ? config.systemPrompt || "" : "";
  const liveFingerprint = fingerprint(prompt, docs);
  const limits = record(config.limitsJson);
  let store = limits.aiSetup as Store | undefined;
  if (!store || store.schema !== 1) {
    const draft = emptyAiManagerDraft(tenant.name);
    draft.additionalInstructions = prompt;
    draft.knowledge = docs.map(({ id, title, content }) => ({ id, title, content }));
    store = { schema: 1, revision: 0, draft, savedAt: null, publishedAt: null, baseFingerprint: liveFingerprint, currentVersionId: null, versions: [] };
    await tx.aIConfiguration.update({ where: { id: config.id }, data: { limitsJson: json({ ...limits, aiSetup: store }) } });
  }
  return { config, limits, store, prompt, docs, liveFingerprint, tenant };
}
type Loaded = Awaited<ReturnType<typeof load>>;
function state(data: Loaded): AiSetupState {
  const generated = compileAiManagerDraft(data.store.draft);
  return { revision: data.store.revision, draft: data.store.draft, savedAt: data.store.savedAt, publishedAt: data.store.publishedAt,
    hasPublished: Boolean(data.prompt), liveChanged: data.liveFingerprint !== data.store.baseFingerprint,
    hasDraftChanges: fingerprint(generated.prompt, generated.knowledge) !== data.liveFingerprint,
    generated, versions: data.store.versions.map(({ id, createdAt, label }) => ({ id, createdAt, label, current: id === data.store.currentVersionId && data.liveFingerprint === data.store.baseFingerprint })) };
}
async function persist(tx: Prisma.TransactionClient, data: Loaded, store: Store) {
  await tx.aIConfiguration.update({ where: { id: data.config.id }, data: { limitsJson: json({ ...data.limits, aiSetup: store }) } });
}
export async function getAiManagerSetup(prisma: PrismaClient, auth: AuthContext) {
  const tenantId = access(auth);
  const result = await locked(prisma, tenantId, async tx => state(await load(tx, tenantId)));
  return { ...result, activation: await readActivation(prisma, tenantId) };
}
export async function saveAiManagerSetupDraft(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  const tenantId = access(auth);
  const body = parse(z.object({ revision: z.number().int().nonnegative(), draft: aiManagerDraftSchema }).strict(), input);
  return locked(prisma, tenantId, async tx => {
    const data = await load(tx, tenantId);
    checkRevision(data.store, body.revision);
    data.store = { ...data.store, draft: body.draft, savedAt: new Date().toISOString(), revision: data.store.revision + 1 };
    await persist(tx, data, data.store);
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "AI_SETUP_DRAFT_SAVED", entityType: "ai_configuration", entityId: data.config.id, changes: { revision: data.store.revision } });
    return state(data);
  });
}
// Explicitly re-import a live version after an administrator edited it. Never rebase silently.
export async function reloadAiManagerSetupFromLive(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  const tenantId = access(auth); const { revision } = parse(revisionSchema, input);
  return locked(prisma, tenantId, async tx => {
    const data = await load(tx, tenantId); checkRevision(data.store, revision);
    const draft = emptyAiManagerDraft(data.tenant.name);
    draft.additionalInstructions = data.prompt;
    draft.knowledge = data.docs.map(({ id, title, content }) => ({ id, title, content }));
    data.store = { ...data.store, draft, revision: revision + 1, savedAt: new Date().toISOString(), baseFingerprint: data.liveFingerprint, currentVersionId: null };
    await persist(tx, data, data.store);
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "AI_SETUP_RELOADED", entityType: "ai_configuration", entityId: data.config.id });
    return state(data);
  });
}
async function publish(prisma: PrismaClient, auth: AuthContext, input: unknown, restore: boolean) {
  const tenantId = access(auth);
  await requireFeature(prisma, auth, "AI_MANAGER");
  const body = parse(z.object({ revision: z.number().int().nonnegative(), ...(restore ? { versionId: z.string().min(1).max(100) } : {}) }).strict(), input) as { revision: number; versionId?: string };
  await locked(prisma, tenantId, async tx => {
    const data = await load(tx, tenantId); const { store } = data;
    checkRevision(store, body.revision);
    if (data.liveFingerprint !== store.baseFingerprint) throw new ApiError(409, "ai_setup_live_changed", "Действующие инструкции изменены администратором. Загрузите действующую версию в мастер и проверьте её перед публикацией.");
    let prompt: string; let knowledge: AiSetupKnowledge[]; let draft = store.draft;
    if (restore) {
      const selected = store.versions.find(item => item.id === body.versionId);
      if (!selected) throw new ApiError(404, "not_found", "Версия не найдена");
      prompt = selected.prompt; knowledge = selected.knowledge;
      draft = selected.draft || { ...emptyAiManagerDraft(data.tenant.name), additionalInstructions: prompt, knowledge: knowledge.map(d => ({ ...d, id: randomUUID() })) };
    } else {
      const compiled = compileAiManagerDraft(parse(aiManagerDraftSchema, store.draft));
      if (compiled.issues.some(issue => issue.level === "error")) throw new ApiError(422, "ai_setup_incomplete", "Перед публикацией заполните обязательные сведения и исправьте замечания анкеты.");
      prompt = compiled.prompt; knowledge = compiled.knowledge;
    }
    const now = new Date();
    const versions = [...store.versions];
    if (!versions.length && (data.prompt || data.docs.length)) versions.push({ id: randomUUID(), createdAt: now.toISOString(), label: "До настройки в мастере", prompt: data.prompt, knowledge: data.docs.map(({ title, content }) => ({ title, content })), draft: null });
    const id = randomUUID();
    versions.unshift({ id, createdAt: now.toISOString(), label: restore ? "Восстановленная версия" : `Публикация ${now.toLocaleDateString("ru-RU", { timeZone: data.tenant.timezone || "Asia/Almaty" })}`, prompt, knowledge, draft });
    const next: Store = { ...store, revision: store.revision + 1, draft, savedAt: now.toISOString(), publishedAt: now.toISOString(), currentVersionId: id, baseFingerprint: fingerprint(prompt, knowledge), versions: versions.slice(0, 10) };
    // Leave unrelated unpublished admin materials untouched. Retire only the old active set.
    await tx.knowledgeDocument.updateMany({ where: { tenantId, status: "published" }, data: { status: "archived" } });
    for (const item of knowledge) await tx.knowledgeDocument.create({ data: { tenantId, ...item, sourceType: "ai_setup", status: "published", publishedAt: now, updatedById: auth.user.id } });
    await tx.aIConfiguration.update({ where: { id: data.config.id }, data: { systemPrompt: prompt, draftPrompt: prompt, promptStatus: "published", promptUpdatedAt: now, promptUpdatedById: auth.user.id, scenario: draft.primaryRole, limitsJson: json({ ...data.limits, aiSetup: next }) } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: restore ? "AI_SETUP_RESTORED" : "AI_SETUP_PUBLISHED", entityType: "ai_configuration", entityId: data.config.id, changes: { versionId: id, restoredVersionId: body.versionId, revision: next.revision, knowledgeCount: knowledge.length } });
  });
  invalidateRuntimeConfig(tenantId);
  await pushAiConfigToWhatsApp(prisma, tenantId);
  return getAiManagerSetup(prisma, auth);
}
export const publishAiManagerSetup = (prisma: PrismaClient, auth: AuthContext, input: unknown) => publish(prisma, auth, input, false);
export const restoreAiManagerSetup = (prisma: PrismaClient, auth: AuthContext, input: unknown) => publish(prisma, auth, input, true);
export async function previewAiManagerSetup(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  const tenantId = access(auth); await requireFeature(prisma, auth, "AI_MANAGER");
  const body = parse(z.object({ revision: z.number().int().nonnegative(), messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }).strict()).min(1).max(20) }).strict(), input);
  if (body.messages[0].role !== "user" || body.messages.at(-1)?.role !== "user" || body.messages.some((message, i) => i > 0 && message.role === body.messages[i - 1].role)) throw new ApiError(422, "invalid_ai_setup", "Тестовый диалог должен чередовать сообщения клиента и ИИ.");
  const context = await locked(prisma, tenantId, async tx => {
    const data = await load(tx, tenantId); checkRevision(data.store, body.revision);
    const compiled = compileAiManagerDraft(parse(aiManagerDraftSchema, data.store.draft));
    if (compiled.issues.some(issue => issue.level === "error")) throw new ApiError(422, "ai_setup_incomplete", "Перед тестом заполните обязательные сведения анкеты.");
    return { tenantPrompt: compiled.prompt, knowledge: compiled.knowledge, temperature: data.config.temperature, maxOutputTokens: data.config.maxOutputTokens };
  });
  const { answerWhatsAppWithLlm } = await import("./llmClient.ts");
  try {
    const result = await answerWhatsAppWithLlm({ prisma, tenantId, userId: auth.user.id, contextOverride: context, history: body.messages });
    if (!result) throw new Error("empty");
    return { sandbox: true as const, reply: result.reply, handoff: result.handoff };
  } catch (error) {
    if (error instanceof ApiError && [402, 403, 429].includes(error.status)) throw error;
    throw new ApiError(502, "ai_setup_preview_failed", "Не удалось получить тестовый ответ. Проверьте подключение модели ИИ и повторите попытку. Черновик сохранён.");
  }
}
