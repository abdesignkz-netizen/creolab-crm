import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it, type TestContext } from "node:test";
import { createPrismaClient, syncPricingCatalog } from "@creolab/db";
import { DEFAULT_PROCESS_CALENDAR, updateTenantOpsSchema } from "@creolab/contracts";
import { authForUserInTenant } from "./services/authService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { getDealBoard, getDeal, getTenantOps, updateTenantOps, ensureDealPipelineStages, changeDealStage } from "./services/dealService.ts";
import { getAnalyticsDashboard } from "./services/analyticsService.ts";
import { getSituationOverview } from "./services/situationOverviewService.ts";
import { updateControlCompany, upsertControlAccess, executeWebControl } from "./services/aiControlService.ts";

const at = (local: string) => new Date(`${local}:00+05:00`);
const monday = at("2026-10-26T10:00");
const business = { ...DEFAULT_PROCESS_CALENDAR, mode: "business" as const, end: "17:00" };

describe("shared process policy across the workspace", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const originalFetch = globalThis.fetch;
  before(async () => {
    db = await createPrismaClient(); await syncPricingCatalog(db);
    globalThis.fetch = async () => { throw new Error("External calls are forbidden in process tests"); };
  });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });

  async function fixture(t: TestContext, now = monday) {
    t.mock.timers.enable({ apis: ["Date"], now });
    const tenant = await db.tenant.create({ data: { slug: randomUUID(), name: "Process rules", timezone: "Asia/Almaty", settingsJson: { untouched: { keep: true } } } });
    await activateSubscription(db, { tenantId: tenant.id, planCode: "CRM_START" });
    const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
    const auth = await authForUserInTenant(db, user.id, tenant.id, "process-policy-test");
    const stages = await ensureDealPipelineStages(db, tenant.id);
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Process client" } });
    await updateTenantOps(db, auth, { processCalendar: business, stalledDealDays: 2, silenceReturnDays: 7 });
    const deal = (title: string, extra: Record<string, unknown> = {}) => db.deal.create({ data: {
      tenantId: tenant.id, contactId: contact.id, title, stageId: stages.find(s => s.systemKey === "new")!.id,
      assigneeMembershipId: auth.activeMembership!.id, stageEnteredAt: at("2026-10-23T16:00"), ...extra,
    } });
    return { tenant, auth, stages, contact, deal };
  }

  it("agrees on deadlines and missing steps in deals, dashboard, analytics and Control", async t => {
    const f = await fixture(t), tid = f.tenant.id;
    const undated = await f.deal("Needs a deadline", { nextAction: "Позвонить" });
    const planned = await f.deal("Planned work");
    const overdue = await f.deal("Waiting with missed deadline", { nextAction: "Ждём клиента", nextActionAt: at("2026-10-25T12:00") });
    // A useful task must not disappear behind a five-row display limit.
    await db.task.createMany({ data: Array.from({ length: 7 }, (_, i) => ({ tenantId: tid, dealId: planned.id, type: "general", title: `No deadline ${i}` })) });
    const task = await db.task.create({ data: { tenantId: tid, dealId: planned.id, type: "general", title: "Call", status: "in_progress", dueAt: at("2026-10-27T12:00") } });
    await updateControlCompany(db, f.auth, { enabled: true });
    await upsertControlAccess(db, f.auth, f.auth.user.id, { enabled: true, allowedSources: ["CRM_CHAT"], canReadFinancialData: true, canReadTeamData: true });
    const identity = await db.controlIdentity.create({ data: { tenantId: tid, userId: f.auth.user.id, provider: "CRM_CHAT", externalUserId: f.auth.user.id, verifiedAt: monday } });
    for (const [mode, expected] of [["business", [overdue.id]], ["calendar", [undated.id, overdue.id]]] as const) {
      await updateTenantOps(db, f.auth, { processCalendar: { ...business, mode } });
      const board = await getDealBoard(db, f.auth);
      const situation = await getSituationOverview(db, f.auth, { period: "all" });
      const analytics = await getAnalyticsDashboard(db, f.auth, { period: "all", compare: "none" });
      const control = await executeWebControl(db, f.auth, identity.id, "GET_STUCK_DEALS", {}, randomUUID()) as any;
      assert.deepEqual(board.items.filter(d => d.flags.stalled).map(d => d.id).sort(), [...expected].sort());
      assert.equal(situation.current.stalledDeals, expected.length);
      assert.equal(analytics.stageDurations.reduce((sum, stage) => sum + stage.stalled, 0), expected.length);
      assert.deepEqual(control.data.items.map((d: any) => d.id).sort(), [...expected].sort());
      assert.equal(control.data.total, expected.length);
      assert.equal(board.items.find(d => d.id === planned.id)!.flags.noNextAction, false);
      assert.equal(board.items.find(d => d.id === undated.id)!.flags.nextActionIssue, "missing_deadline");
      assert.equal(analytics.dataQuality.openNoNextAction, 1);
      const reminder = situation.attention.items.find(d => d.id === `deal-next:${undated.id}`);
      assert.match(reminder!.reason, /Не указан срок/);
      for (const item of board.items) assert.deepEqual((await getDeal(db, f.auth, item.id)).deal.flags, item.flags);
      assert.equal(analytics.coverage.partial, false);
    }
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).dueAt!.getTime(), task.dueAt!.getTime());
    assert.equal((await db.deal.findUniqueOrThrow({ where: { id: overdue.id } })).nextActionAt!.getTime(), overdue.nextActionAt!.getTime());
    assert.equal(await db.message.count({ where: { tenantId: tid } }), 0);
  });

  it("preserves edited and legacy stages, history, probability and active deals in terminal columns", async t => {
    const f = await fixture(t);
    const changed = await db.dealStage.update({ where: { id: f.stages.find(s => s.systemKey === "new")!.id }, data: { name: "Новая заявка клиента", sortOrder: 91, defaultProbability: 27 } });
    const legacy = await db.dealStage.create({ data: { tenantId: f.tenant.id, name: "Legacy qualification", systemKey: "qualification", sortOrder: 92, defaultProbability: 33 } });
    const terminal = await db.dealStage.create({ data: { tenantId: f.tenant.id, name: "Legacy terminal", systemKey: "old_terminal", isTerminal: true, sortOrder: 99 } });
    const old = await f.deal("Legacy", { stageId: legacy.id, stageEnteredAt: at("2026-10-01T10:00"), probability: 41 });
    const unusual = await f.deal("Open in terminal", { stageId: terminal.id, stageEnteredAt: at("2026-10-01T10:00") });
    await updateTenantOps(db, f.auth, { stageSlaDays: { qualification: 1 } });
    assert.equal((await getDeal(db, f.auth, old.id)).deal.flags.overSla, true);
    for (let i = 0; i < 2; i++) {
      await getTenantOps(db, f.auth); const board = await getDealBoard(db, f.auth);
      assert.ok(board.columns.find(s => s.stageId === legacy.id)!.deals.some(d => d.id === old.id));
      assert.ok(board.columns.find(s => s.stageId === terminal.id)!.deals.some(d => d.id === unusual.id));
    }
    assert.deepEqual(await db.dealStage.findUniqueOrThrow({ where: { id: changed.id } }), changed);
    await changeDealStage(db, f.auth, old.id, { stageId: legacy.id });
    const retained = await db.deal.findUniqueOrThrow({ where: { id: old.id } });
    assert.equal(retained.stageId, legacy.id); assert.equal(retained.probability, 41);
    assert.equal(retained.stageEnteredAt.getTime(), old.stageEnteredAt.getTime());
    assert.equal(await db.dealStageHistory.count({ where: { dealId: old.id } }), 0);
    await updateTenantOps(db, f.auth, { stageSlaDays: { qualification: null } });
    assert.equal((await getDeal(db, f.auth, old.id)).deal.flags.overSla, false);
    assert.equal((await getTenantOps(db, f.auth)).stages.find(s => s.systemKey === "qualification")!.slaDays, null);
    assert.ok((await getSituationOverview(db, f.auth)).pipeline.stages.some(s => s.systemKey === "old_terminal"));
    assert.equal((await getAnalyticsDashboard(db, f.auth, { period: "all", compare: "none" })).stageDurations.find(s => s.systemKey === "old_terminal")!.stalled, 1);
  });

  it("uses the working calendar for a new follow-up without moving a manually assigned deadline", async t => {
    const f = await fixture(t, at("2026-10-23T16:00"));
    await updateTenantOps(db, f.auth, { processCalendar: { ...business, excludedDates: ["2026-10-26"] } });
    const automatic = await f.deal("Proposal"), manual = await f.deal("Existing plan", { nextAction: "Уточнить решение", nextActionAt: at("2026-10-25T12:00") });
    const dateOnly = await f.deal("Date without action", { nextAction: "  ", nextActionAt: at("2026-10-25T12:00") });
    await changeDealStage(db, f.auth, automatic.id, { systemKey: "proposal_sent" });
    await changeDealStage(db, f.auth, manual.id, { systemKey: "proposal_sent" });
    await changeDealStage(db, f.auth, dateOnly.id, { systemKey: "proposal_sent" });
    assert.equal((await db.deal.findUniqueOrThrow({ where: { id: automatic.id } })).nextActionAt!.getTime(), at("2026-10-27T16:00").getTime());
    assert.equal((await db.deal.findUniqueOrThrow({ where: { id: manual.id } })).nextActionAt!.getTime(), manual.nextActionAt!.getTime());
    const kept = await db.deal.findUniqueOrThrow({ where: { id: dateOnly.id } });
    assert.equal(kept.nextActionAt!.getTime(), dateOnly.nextActionAt!.getTime()); assert.equal(kept.nextAction, "Связаться после предложения");
  });

  it("validates settings, isolates companies, persists disabled SLA and writes the actual author to audit", async t => {
    const f = await fixture(t);
    const other = await db.tenant.create({ data: { slug: randomUUID(), name: "Other company", settingsJson: { marker: "unchanged" } } });
    const before = (await db.tenant.findUniqueOrThrow({ where: { id: f.tenant.id } })).settingsJson;
    const auditBefore = await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "settings.ops_updated" } });
    const manager = { ...f.auth, activeMembership: { ...f.auth.activeMembership!, role: "manager" } };
    await assert.rejects(updateTenantOps(db, manager, { stalledDealDays: 1 }), /доступ|прав|руководител/i);
    for (const patch of [{ processCalendar: { ...business, days: [] } }, { stalledDealDays: 0 }, { stageSlaDays: { alien: 3 } }]) {
      await assert.rejects(updateTenantOps(db, f.auth, patch), /Проверьте|Неизвестный/);
    }
    assert.equal(updateTenantOpsSchema.safeParse({ processCalendar: { ...business, excludedDates: ["2026-02-30"] } }).success, false);
    assert.deepEqual((await db.tenant.findUniqueOrThrow({ where: { id: f.tenant.id } })).settingsJson, before);
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "settings.ops_updated" } }), auditBefore);
    await updateTenantOps(db, f.auth, { stageSlaDays: { proposal_sent: null }, processCalendar: { ...business, excludedDates: ["2026-12-16"] } });
    const saved = await getTenantOps(db, f.auth);
    assert.equal(saved.stages.find(s => s.systemKey === "proposal_sent")!.slaDays, null);
    assert.deepEqual(saved.processCalendar.excludedDates, ["2026-12-16"]);
    assert.deepEqual(((await db.tenant.findUniqueOrThrow({ where: { id: f.tenant.id } })).settingsJson as any).untouched, { keep: true });
    assert.deepEqual((await db.tenant.findUniqueOrThrow({ where: { id: other.id } })).settingsJson, { marker: "unchanged" });
    const audit = await db.auditEvent.findMany({ where: { tenantId: f.tenant.id, action: "settings.ops_updated" } });
    assert.equal(audit.length, auditBefore + 1); assert.ok(audit.every(row => row.actorUserId === f.auth.user.id));
  });
});
