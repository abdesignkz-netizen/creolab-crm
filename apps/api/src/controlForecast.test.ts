import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { createPrismaClient, syncPricingCatalog } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant } from "./services/authService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { getTenantOps, updateTenantOps } from "./services/dealService.ts";
import { updateControlCompany, upsertControlAccess, executeWebControl, executeNativeControl } from "./services/aiControlService.ts";
import { sendControlWebMessage, controlWebHistory } from "./services/controlWebService.ts";
import { runControlChatRequest } from "./services/controlChatService.ts";
import { quickControlCommand, chatCommandSchema, controlChatMenu } from "./services/controlChatLanguage.ts";
import { presentControlForecast } from "./services/controlForecastPresentation.ts";
import { calculateSalesForecast, forecastContext, forecastMonth } from "./services/salesForecastPolicy.ts";
import { moneyValue } from "./services/financialMetrics.ts";
import { zonedYmd } from "./services/periodRange.ts";

describe("Control forecast language and evidence", () => {
  it("recognizes full RU/KK requests without the model or a preceding menu", () => {
    for (const text of ["Прогноз", "Прогноз продаж на месяц", "Какой прогноз продаж на этот месяц?", "Покажи мне прогноз продаж на текущий месяц, пожалуйста",
      "Выполним ли мы план продаж в этом месяце?", "Риск невыполнения плана", "Подскажи прогноз выполнения плана продаж",
      "Осы айдың сату болжамы", "Осы айдағы сатылым болжамын көрсет", "Айлық сату болжамы", "Осы айдың жоспары орындала ма?"]) {
      const command = quickControlCommand(text);
      assert.deepEqual(command, { action: "GET_SALES_FORECAST", period: "this_month" }, text);
      assert.equal(chatCommandSchema.safeParse(command).success, true);
    }
    assert.equal(quickControlCommand("7")?.action, "GET_SALES_FORECAST");
    assert.match(controlChatMenu("ru", ["GET_SALES_FORECAST"]), /7\. Прогноз/);
    assert.doesNotMatch(controlChatMenu("ru", ["GET_TASKS"]), /7\. Прогноз/);
  });
  it("preserves an explicit historical period and never discards a filter or a second action", () => {
    assert.deepEqual(quickControlCommand("Прогноз продаж за прошлый месяц"), { action: "GET_SALES_FORECAST", period: "last_month" });
    for (const text of ["Прогноз продаж на следующий месяц", "Прогноз продаж менеджера Айбек", "Прогноз продаж и удали клиента", "Удали прогноз продаж", "Прогноз оплат", "Осы айдың сату болжамы және клиентті жой"]) assert.equal(quickControlCommand(text), null, text);
    for (const extra of [{ scope: "mine" }, { assignee: "Owner" }, { client: "Client" }, { query: "A" }, { title: "Write" }]) {
      assert.equal(chatCommandSchema.safeParse({ action: "GET_SALES_FORECAST", ...extra }).success, false);
    }
  });
  it("states method, limits and data issues instead of inventing financial values", () => {
    const base = forecastContext(new Date("2029-10-16T07:00:00Z"), "Asia/Almaty", "KZT");
    const month = (key: string, days: number) => ({ month: key, days, sales: 5, missingAmounts: 0, total: moneyValue(days * 100, "KZT") });
    const f = calculateSalesForecast(base, { history: [month("2029-06", 30), month("2029-07", 31), month("2029-08", 31), month("2029-09", 30)],
      current: { ...month("2029-10", 31), total: moneyValue(700, "KZT") }, monthlyPlan: 5000, evidence: { otherCurrencySales: 2 } });
    for (const lang of ["ru", "kk"] as const) {
      const reply = presentControlForecast(f, lang, "https://example.test/stats");
      assert.ok(reply.includes(f.estimate.label!)); assert.ok(reply.includes(f.target.amount.label!));
      assert.ok(reply.includes("Asia/Almaty")); assert.ok(reply.endsWith("https://example.test/stats"));
      assert.ok(reply.length < 3500, `${lang}: ${reply.length}`);
      assert.match(reply, lang === "ru" ? /медианный дневной темп/ : /медианалық күндік қарқыны/);
      assert.match(reply, lang === "ru" ? /не гарантируют/ : /кепілдік бермейді/);
      assert.match(reply, lang === "ru" ? /Средняя абсолютная ошибка/ : /Орташа абсолюттік қате/);
    }
    const missing = { ...f, status: "incomplete_data" as const, evidence: { ...f.evidence, missingAmounts: 2 } };
    assert.match(presentControlForecast(missing, "ru", "link"), /Без суммы: 2/);
    assert.doesNotMatch(presentControlForecast(missing, "ru", "link"), /Оценка к концу месяца/);
    assert.match(presentControlForecast({ ...f, status: "insufficient_history" }, "kk", "link"), /Тарих жеткіліксіз/);
    assert.match(presentControlForecast(undefined, "ru", "link"), /временно недоступен/);
  });
});

describe("Control forecast access, history and both transports", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, manager: AuthContext, foreign: AuthContext;
  let tenantId: string, identityId: string, nativeId: string, integrationId: string;
  const timeZone = "Asia/Almaty", originalFetch = globalThis.fetch;
  const now = new Date(), today = zonedYmd(now, timeZone), current = forecastMonth(timeZone, today.year, today.month);
  const start = forecastMonth(timeZone, today.year, today.month - 7).from;
  async function company() {
    const tenant = await db.tenant.create({ data: { name: "Forecast Control", slug: randomUUID(), timezone: timeZone } });
    await activateSubscription(db, { tenantId: tenant.id, planCode: "CRM_START" });
    const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
    return authForUserInTenant(db, user.id, tenant.id, "control-forecast-test");
  }
  const send = async (text: string) => (await sendControlWebMessage(db, auth, { text, requestId: randomUUID() })).items.at(-1)!;
  const execute = (params: Record<string, unknown> = {}) => executeWebControl(db, auth, identityId, "GET_SALES_FORECAST", params, randomUUID()) as Promise<any>;
  before(async () => {
    db = await createPrismaClient(); await syncPricingCatalog(db);
    globalThis.fetch = async () => { throw new Error("No external network in forecast tests"); };
    auth = await company(); foreign = await company(); tenantId = auth.activeMembership!.tenantId;
    const user = await db.user.create({ data: { name: "Manager", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    await db.membership.create({ data: { tenantId, userId: user.id, role: "manager" } });
    manager = await authForUserInTenant(db, user.id, tenantId, "control-forecast-manager");
    identityId = (await db.controlIdentity.create({ data: { tenantId, userId: auth.user.id, provider: "CRM_CHAT", externalUserId: auth.user.id, verifiedAt: now } })).id;
    integrationId = (await db.integration.create({ data: { tenantId, name: "Local WhatsApp fixture", type: "whatsapp_qr", status: "active", connectionStatus: "CONNECTED", testMode: true } })).id;
    nativeId = (await db.controlIdentity.create({ data: { tenantId, userId: auth.user.id, provider: "WHATSAPP", externalUserId: randomUUID(), verifiedAt: now,
      metadata: { chat: { enabled: true, integrationId, language: "kk" } } } })).id;
    const ops = await getTenantOps(db, auth), stageId = ops.stages[0].id;
    await updateTenantOps(db, auth, { revision: ops.revision, salesPlans: [{ month: current.month, amount: 5000, currency: "KZT" }] });
    const contact = await db.contact.create({ data: { tenantId, name: "Forecast client", firstSeenAt: start } });
    for (let i = 0; i < 6; i++) {
      const month = forecastMonth(timeZone, today.year, today.month - 6 + i);
      for (let k = 0; k < 5; k++) await db.deal.create({ data: { tenantId, stageId, contactId: contact.id, title: "History", outcome: "won", currency: "KZT",
        createdAt: start, closedAt: month.from, wonAmountMinor: month.days * 20 } });
    }
    await db.deal.create({ data: { tenantId, stageId, contactId: contact.id, title: "Actual", outcome: "won", currency: "KZT", createdAt: start, closedAt: current.from, wonAmountMinor: 700 } });
    const fops = await getTenantOps(db, foreign), ftid = foreign.activeMembership!.tenantId;
    const fc = await db.contact.create({ data: { tenantId: ftid, name: "Other company" } });
    await db.deal.create({ data: { tenantId: ftid, stageId: fops.stages[0].id, contactId: fc.id, title: "Not ours", outcome: "won", currency: "KZT", createdAt: start, closedAt: current.from, wonAmountMinor: 99999999 } });
  });
  beforeEach(async () => {
    await updateControlCompany(db, auth, { enabled: true });
    await upsertControlAccess(db, auth, auth.user.id, { enabled: true, allowedSources: ["CRM_CHAT", "WHATSAPP"], allowedActions: [], canReadFinancialData: true });
  });
  after(async () => { globalThis.fetch = originalFetch; await db?.$disconnect(); });
  it("returns the company forecast without a financial mutation and preserves its dated evidence in history", async () => {
    const before = await db.deal.findMany({ where: { tenantId }, orderBy: { id: "asc" } });
    const result = await execute();
    assert.equal(result.status, "OK"); assert.equal(result.meta.period, "this_month");
    assert.equal(result.data.forecast.status, "ready"); assert.equal(result.data.forecast.actual.exact, "700");
    assert.equal(result.data.forecast.evidence.sales, 30); assert.equal(result.data.forecast.target.amount.exact, "5000");
    const reply = await send("Какой прогноз продаж на этот месяц?");
    assert.deepEqual(reply.actions, ["GET_SALES_FORECAST"]); assert.match(reply.reply, /Рассчитано: .*Asia\/Almaty/);
    assert.match(reply.reply, /Продажи на сейчас: 700/); assert.match(reply.reply, /Оценка к концу месяца/);
    assert.match(reply.reply, /риск невыполнения плана/); assert.match(reply.reply, /\/stats\?tab=sales/);
    assert.equal((await controlWebHistory(db, auth)).forecastAvailable, true);
    assert.deepEqual(await db.deal.findMany({ where: { tenantId }, orderBy: { id: "asc" } }), before);
    assert.equal(await db.task.count({ where: { tenantId } }), 0);
    assert.equal(await db.controlConfirmation.count({ where: { tenantId } }), 0);
    assert.equal(await db.message.count({ where: { tenantId } }), 0);
  });
  it("rejects unsupported filters and periods, including a contextual follow-up", async () => {
    for (const params of [{ period: "last_month" }, { scope: "mine" }, { assignee: manager.activeMembership!.id }, { tenantId: foreign.activeMembership!.tenantId }]) await assert.rejects(execute(params), /текущий месяц по компании/);
    await send("Прогноз продаж");
    const historical = await send("А за прошлый месяц?");
    assert.match(historical.reply, /текущий месяц по компании/); assert.doesNotMatch(historical.reply, /Оценка к концу месяца/);
    const restored = await send("Прогноз продаж на месяц");
    assert.match(restored.reply, /Оценка к концу месяца/);
  });
  it("rechecks financial and action access and hides historical forecasts after revocation", async () => {
    const entry = await send("Прогноз продаж");
    await upsertControlAccess(db, auth, auth.user.id, { canReadFinancialData: false });
    await assert.rejects(execute(), /Нет права на финансовые данные/);
    const hidden = await controlWebHistory(db, auth);
    assert.equal(hidden.forecastAvailable, false); assert.ok(!hidden.items.some(item => item.id === entry.id));
    await upsertControlAccess(db, auth, auth.user.id, { canReadFinancialData: true, allowedActions: ["GET_TASKS"] });
    assert.equal((await controlWebHistory(db, auth)).forecastAvailable, false);
    await assert.rejects(execute(), /Действие не разрешено/);
  });
  it("does not give a manager company analytics even when a financial flag is enabled", async () => {
    await upsertControlAccess(db, auth, manager.user.id, { enabled: true, allowedSources: ["CRM_CHAT"], canReadFinancialData: true });
    const identity = await db.controlIdentity.create({ data: { tenantId, userId: manager.user.id, provider: "CRM_CHAT", externalUserId: manager.user.id, verifiedAt: now } });
    assert.equal((await controlWebHistory(db, manager)).forecastAvailable, false);
    await assert.rejects(executeWebControl(db, manager, identity.id, "GET_SALES_FORECAST", {}, randomUUID()), /Статистика доступна/);
    await assert.rejects(executeWebControl(db, foreign, identityId, "GET_SALES_FORECAST", {}, randomUUID()));
  });
  it("uses the same verified calculation for WhatsApp and formats Kazakh without sending to customers", async () => {
    const result = await executeNativeControl(db, integrationId, nativeId, "GET_SALES_FORECAST", {}, randomUUID()) as any;
    assert.equal(result.data.forecast.status, "ready"); assert.equal(result.data.forecast.actual.exact, "700");
    const reply = await runControlChatRequest(db, { id: randomUUID(), tenantId, identityId: nativeId, integrationId, kind: "request", text: "Осы айдың сату болжамы" }, {}, "kk");
    assert.deepEqual(reply.actions, ["GET_SALES_FORECAST"]); assert.match(reply.text, /Айлық сату болжамы/);
    assert.match(reply.text, /Қазіргі сатылым: 700/); assert.match(reply.text, /кепілдік бермейді/);
    assert.equal(await db.message.count({ where: { tenantId } }), 0);
  });
});
