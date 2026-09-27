import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createPrismaClient, type PrismaClient } from "@creolab/db";
import { provisionOrganization } from "./services/organizationProvisioning.ts";
import { getEntitlements, getUsage } from "./services/entitlementService.ts";
import { consumeResource, initializeTenantUsage, resourcePeriod, reserveAiCall } from "./services/billingResourceService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";

let db: PrismaClient;
let sequence = 0;
async function freeTenant() {
  return db.$transaction(async tx => {
    const tenant = await provisionOrganization(tx, { name: `Free ${Date.now()} ${sequence++}`, source: "self_registration", subscriptionStatus: "none", aiEnabled: false });
    const user = await tx.user.create({ data: { name: "Owner", email: `${tenant.id}@test`, passwordHash: "test" } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
    return tenant;
  });
}

describe("BasQar resource accounting", () => {
  before(async () => { db = await createPrismaClient(); });
  it("activates Free with the shared CRM and exact resource limits", async () => {
    const tenant = await freeTenant();
    const access = await getEntitlements(db, tenant.id);
    assert.equal(access.snapshot.planCode, "BASQAR_FREE");
    assert.equal(access.limits.USERS, 1);
    assert.equal(access.limits.AI_CREDITS, 100);
    assert.equal(access.limits.AI_TRIAL, 100);
    assert.equal(access.limits.AUTOMATION_RUNS, 30);
    assert.equal(access.limits.DOCUMENTS_COUNT, 3);
    assert.equal(access.limits.CAMPAIGN_RECIPIENTS, 0);
    assert.equal(access.limits.STORAGE_GB, 1);
    assert.equal(access.entitlements.DOCUMENTS, true);
    assert.equal(access.entitlements.AI_CONTROL, true);
    assert.equal(access.entitlements.MASS_MESSAGING, false);
  });
  it("charges AI once and keeps the Free grant lifetime", async () => {
    const tenant = await freeTenant();
    await consumeResource(db, tenant.id, "AI_CREDITS", 1, "ai-once");
    await consumeResource(db, tenant.id, "AI_CREDITS", 1, "ai-once");
    assert.equal(await getUsage(db, tenant.id, "AI_CREDITS"), 1);
    const row = await db.tenantUsage.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    const period = await resourcePeriod(db, tenant.id, "AI_CREDITS", new Date("2030-01-01T00:00:00Z"));
    assert.equal(period, "lifetime");
    assert.ok(row.countersJson.resourceAnchor);
  });
  it("counts automation and campaign recipients independently", async () => {
    const tenant = await freeTenant();
    await assert.rejects(consumeResource(db, tenant.id, "CAMPAIGN_RECIPIENTS", 1, "campaign-1"), /Лимит ресурса/);
    await db.tenantPlan.updateMany({ where: { tenantId: tenant.id }, data: { status: "suspended" } });
    await assert.rejects(consumeResource(db, tenant.id, "AUTOMATION_RUNS", 1, "flow-1"), /Подписка не активна/);
    await activateSubscription(db, { tenantId: tenant.id, planCode: "CRM_START" });
    await consumeResource(db, tenant.id, "CAMPAIGN_RECIPIENTS", 3, "campaign-1");
    assert.equal(await getUsage(db, tenant.id, "CAMPAIGN_RECIPIENTS"), 3);
    await consumeResource(db, tenant.id, "AUTOMATION_RUNS", 1, "flow-1");
    assert.equal(await getUsage(db, tenant.id, "AUTOMATION_RUNS"), 1);
  });
  it("reserves concurrent AI calls without exceeding the cap", async () => {
    const tenant = await freeTenant();
    await initializeTenantUsage(db, tenant.id, { AI_CREDITS: 1, AI_TRIAL: 0 });
    const results = await Promise.allSettled([reserveAiCall(db, tenant.id), reserveAiCall(db, tenant.id)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    for (const result of results) if (result.status === "fulfilled") await result.value();
  });
  it("keeps manual task work independent from a depleted resource", async () => {
    const tenant = await freeTenant();
    await db.tenantBillingOverride.create({ data: { tenantId: tenant.id, limitsJson: { DOCUMENTS_COUNT: 0 }, featuresJson: {} } });
    await assert.rejects(consumeResource(db, tenant.id, "DOCUMENTS_COUNT", 1, "document-1"), /Лимит ресурса/);
    const task = await db.task.create({ data: { tenantId: tenant.id, title: "Manual", type: "manual", status: "open" } });
    assert.ok(await db.task.findUnique({ where: { id: task.id } }));
  });
});
