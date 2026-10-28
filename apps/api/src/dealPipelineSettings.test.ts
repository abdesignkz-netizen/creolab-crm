import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient, syncPricingCatalog } from "@creolab/db";
import { updateTenantOpsSchema } from "@creolab/contracts";
import { authForUserInTenant } from "./services/authService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { getDeal, getDealBoard, changeDealStage, getTenantOps, updateTenantOps, createDeal } from "./services/dealService.ts";
import type { PipelineInput } from "./services/dealPipelineSettings.ts";

describe("company pipeline editor", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  before(async () => { db = await createPrismaClient(); await syncPricingCatalog(db); });
  after(async () => { await db.$disconnect(); });
  async function fixture() {
    const tenant = await db.tenant.create({ data: { slug: randomUUID(), name: "Pipeline editor", settingsJson: { unrelated: "preserved" } } });
    await activateSubscription(db, { tenantId: tenant.id, planCode: "CRM_START" });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", name: "Owner" } });
    await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
    const auth = await authForUserInTenant(db, user.id, tenant.id, "pipeline-test");
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Pipeline client" } });
    const read = () => getTenantOps(db, auth);
    const save = async (transform: (stages: PipelineInput) => PipelineInput, snapshot?: Awaited<ReturnType<typeof getTenantOps>>) => {
      const ops = snapshot || await read();
      const pipeline = ops.stages.map(({ id, systemKey, name, defaultProbability, isArchived, slaDays }) => ({ id, systemKey, name, defaultProbability, isArchived, slaDays }));
      return updateTenantOps(db, auth, { revision: ops.revision, pipeline: transform(pipeline) });
    };
    const newStage = () => ({ systemKey: `custom_${randomUUID()}`, name: "Проверка макета", defaultProbability: 65, isArchived: false, slaDays: 2 });
    const create = () => createDeal(db, auth, { contactId: contact.id, title: "Design review" });
    await read(); return { tenant, auth, contact, read, save, newStage, create };
  }
  it("creates, renames and reorders a stage without changing deals or their history", async () => {
    const f = await fixture(), custom = f.newStage(), created = await f.create();
    const before = await db.deal.findUniqueOrThrow({ where: { id: created.deal.id } });
    const history = await db.dealStageHistory.findMany({ where: { dealId: before.id } });
    const result = await f.save(stages => [...stages.slice(0, 4), custom, ...stages.slice(4)].map(stage => stage.systemKey === "new" ? { ...stage, name: "Новый заказ", defaultProbability: 25 } : stage));
    assert.equal(result.stages[4].systemKey, custom.systemKey);
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.read()).stages[0].name, "Новый заказ");
      assert.equal((await getDealBoard(db, f.auth)).columns[4].systemKey, custom.systemKey);
    }
    assert.deepEqual(await db.deal.findUniqueOrThrow({ where: { id: before.id } }), before);
    assert.deepEqual(await db.dealStageHistory.findMany({ where: { dealId: before.id } }), history);
    const next = await f.create(); assert.equal(next.deal.probability, 25);
    await changeDealStage(db, f.auth, before.id, { systemKey: custom.systemKey });
    const moved = await db.deal.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(moved.probability, 65);
    assert.equal((await f.read()).stages.find(stage => stage.systemKey === custom.systemKey)!.openDealCount, 1);
    assert.equal(await db.dealStageHistory.count({ where: { dealId: before.id } }), history.length + 1);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("archives and restores without deleting closed deals or transition history", async () => {
    const f = await fixture(), custom = f.newStage();
    await f.save(stages => [...stages, custom]);
    const created = await f.create(), stage = (await f.read()).stages.find(stage => stage.systemKey === custom.systemKey)!;
    await changeDealStage(db, f.auth, created.deal.id, { stageId: stage.id });
    for (const outcome of ["open", "on_hold"]) {
      await db.deal.update({ where: { id: created.deal.id }, data: { outcome } });
      await assert.rejects(f.save(stages => stages.map(row => row.id === stage.id ? { ...row, isArchived: true } : row)), /открытые или отложенные/);
    }
    await db.deal.update({ where: { id: created.deal.id }, data: { outcome: "won", wonAt: new Date() } });
    const history = await db.dealStageHistory.findMany({ where: { dealId: created.deal.id } });
    await f.save(stages => stages.map(row => row.id === stage.id ? { ...row, isArchived: true } : row));
    assert.equal((await f.read()).stages.find(row => row.id === stage.id)!.isArchived, true);
    assert.ok(!(await getDealBoard(db, f.auth)).columns.some(row => row.stageId === stage.id));
    assert.equal((await getDeal(db, f.auth, created.deal.id)).deal.stage!.id, stage.id);
    const historical = await getDealBoard(db, f.auth, { timeMode: "period", basis: "closed", period: "all" });
    const column = historical.columns.find(row => row.stageId === stage.id)!;
    assert.equal(column.canReceiveDeals, false); assert.equal(column.deals[0].id, created.deal.id);
    const other = await f.create();
    await assert.rejects(changeDealStage(db, f.auth, other.deal.id, { stageId: stage.id }), /недоступен/);
    assert.deepEqual(await db.dealStageHistory.findMany({ where: { dealId: created.deal.id } }), history);
    await f.save(stages => stages.map(row => row.id === stage.id ? { ...row, isArchived: false } : row));
    await changeDealStage(db, f.auth, other.deal.id, { stageId: stage.id });
    assert.equal((await getDeal(db, f.auth, other.deal.id)).deal.stage!.id, stage.id);
  });
  it("rejects a stale editor after another save, without overwriting the calendar", async () => {
    const f = await fixture(), stale = await f.read();
    await updateTenantOps(db, f.auth, { stalledDealDays: 8 });
    await assert.rejects(f.save(stages => [...stages, f.newStage()], stale), /другой вкладке/);
    assert.equal((await f.read()).stalledDealDays, 8); assert.equal((await f.read()).stages.length, stale.stages.length);
  });
  it("allows only one simultaneous save and preserves the accepted version", async () => {
    const f = await fixture(), before = await f.read();
    const results = await Promise.allSettled([f.save(rows => [...rows, { ...f.newStage(), name: "Approval A" }], before), f.save(rows => [...rows, { ...f.newStage(), name: "Approval B" }], before)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal((await f.read()).stages.length, before.stages.length + 1);
  });
  it("never lets a simultaneous move leave an active deal on an archived stage", async () => {
    const f = await fixture(), custom = f.newStage(); await f.save(rows => [...rows, custom]);
    const current = await f.read(), target = current.stages.find(stage => stage.systemKey === custom.systemKey)!;
    const deal = await f.create();
    const results = await Promise.allSettled([
      f.save(rows => rows.map(row => row.id === target.id ? { ...row, isArchived: true } : row), current),
      changeDealStage(db, f.auth, deal.deal.id, { stageId: target.id }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const savedStage = await db.dealStage.findUniqueOrThrow({ where: { id: target.id } });
    const savedDeal = await db.deal.findUniqueOrThrow({ where: { id: deal.deal.id } });
    assert.ok(!savedStage.isArchived || savedDeal.stageId !== savedStage.id);
  });
  it("validates the full edit atomically and protects automation stage meanings", async () => {
    const f = await fixture(), before = await f.read();
    const transforms: Array<(rows: PipelineInput) => PipelineInput> = [
      rows => rows.slice(1),
      rows => [rows[1], rows[0], ...rows.slice(2)],
      rows => rows.map(row => row.systemKey === "contract" ? { ...row, isArchived: true } : row),
      rows => [...rows, { ...f.newStage(), name: rows[0].name.toUpperCase() }],
      rows => [...rows, rows[0]],
      rows => [...rows, { ...f.newStage(), systemKey: "unknown-key" }],
      rows => rows.map((row, index) => index === 0 ? { ...row, defaultProbability: 101 } : row),
      rows => rows.map((row, index) => index === 0 ? { ...row, name: "  " } : row),
    ];
    const audits = await db.auditEvent.count({ where: { tenantId: f.tenant.id } });
    for (const transform of transforms) await assert.rejects(f.save(transform));
    assert.deepEqual(await f.read(), before);
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id } }), audits);
    assert.equal(updateTenantOpsSchema.safeParse({ pipeline: [] }).success, false);
    const pipeline = before.stages.map(({ id, systemKey, name, defaultProbability, isArchived, slaDays }) => ({ id, systemKey, name, defaultProbability, isArchived, slaDays }));
    await assert.rejects(updateTenantOps(db, f.auth, { revision: before.revision, pipeline: [...pipeline, f.newStage()], stageSlaDays: { unknown: 2 } }), /Неизвестный/);
    assert.deepEqual(await f.read(), before);
  });
  it("isolates companies, rejects staff writes and audits the actual author", async () => {
    const f = await fixture(), other = await fixture(), otherBefore = await other.read();
    const own = await f.read(), pipeline = own.stages.map(({ id, systemKey, name, defaultProbability, isArchived, slaDays }) => ({ id, systemKey, name, defaultProbability, isArchived, slaDays }));
    const staff = { ...f.auth, activeMembership: { ...f.auth.activeMembership!, role: "manager" } };
    await assert.rejects(updateTenantOps(db, staff, { revision: own.revision, pipeline }), /доступ|прав|руководител/i);
    await assert.rejects(f.save(rows => rows.map((row, i) => i === 0 ? { ...row, id: otherBefore.stages[0].id } : row)), /Неизвестный/);
    const result = await f.save(rows => [...rows, f.newStage()]);
    assert.equal(result.stages.length, own.stages.length + 1);
    assert.deepEqual(await other.read(), otherBefore);
    assert.equal(((await db.tenant.findUniqueOrThrow({ where: { id: f.tenant.id } })).settingsJson as any).unrelated, "preserved");
    const event = await db.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenant.id, action: "settings.ops_updated" }, orderBy: { createdAt: "desc" } });
    assert.equal(event.actorUserId, f.auth.user.id); assert.equal((event.changesJson as any).pipeline.length, result.stages.length);
    assert.equal((event.changesJson as any).previousPipeline.length, own.stages.length);
  });
});
