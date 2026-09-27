import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createPrismaClient, syncPricingCatalog } from "@creolab/db";
import { quoteSubscription, loadPublicCatalog } from "./services/pricingEngine.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { getEntitlements, matchPaidFeatures } from "./services/entitlementService.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>;
let sequence = 0;
async function tenant() { return db.tenant.create({ data: { name: "Lineup", slug: `lineup-${Date.now()}-${sequence++}` } }); }

describe("BasQar unified pricing", () => {
  before(async () => { db = await createPrismaClient(); await syncPricingCatalog(db); });

  it("publishes exactly Free, Start, Business and Pro with the agreed prices and quotas", async () => {
    const catalog = await loadPublicCatalog(db);
    assert.deepEqual(catalog.filter(item => item.kind === "plan").map(item => item.code), ["BASQAR_FREE", "CRM_START", "CONTROL", "SALES"]);
    const expected = [["BASQAR_FREE", 0, 0, 1, 100, 30, 3, 0, 1], ["CRM_START", 14990, 149900, 3, 1000, 300, 30, 300, 5], ["CONTROL", 34990, 349900, 10, 3000, 1500, 150, 1500, 20], ["SALES", 69990, 699900, 25, 8000, 5000, 500, 5000, 50]] as const;
    for (const [code, monthly, yearly, users, ai, automation, docs, campaigns, storage] of expected) {
      const monthlyQuote = await quoteSubscription(db, { planCode: code, at: new Date("2026-09-27T00:00:00Z") });
      const yearlyQuote = await quoteSubscription(db, { planCode: code, billingPeriod: "YEARLY" });
      assert.equal(monthlyQuote.finalAmountMinor, code === "CRM_START" ? 9990 : monthly);
      assert.equal(yearlyQuote.finalAmountMinor, yearly);
      assert.equal(monthlyQuote.limits.USERS, users);
      assert.equal(monthlyQuote.limits.AI_CREDITS, ai);
      assert.equal(monthlyQuote.limits.AUTOMATION_RUNS, automation);
      assert.equal(monthlyQuote.limits.DOCUMENTS_COUNT, docs);
      assert.equal(monthlyQuote.limits.CAMPAIGN_RECIPIENTS, campaigns);
      assert.equal(monthlyQuote.limits.STORAGE_GB, storage);
      assert.equal(monthlyQuote.features.DOCUMENTS, true);
      assert.equal(monthlyQuote.features.AI_CONTROL, true);
      assert.equal(monthlyQuote.features.MASS_MESSAGING, code !== "BASQAR_FREE");
    }
  });

  it("ends Start launch pricing for new connections and preserves a paid period on renewal", async () => {
    const before = await quoteSubscription(db, { planCode: "CRM_START", at: new Date("2026-12-31T23:59:59.999+05:00") });
    const after = await quoteSubscription(db, { planCode: "CRM_START", at: new Date("2027-01-01T00:00:00+05:00") });
    assert.equal(before.finalAmountMinor, 9990);
    assert.equal(after.finalAmountMinor, 14990);
    const company = await tenant();
    await activateSubscription(db, { tenantId: company.id, planCode: "CRM_START", approvedSnapshot: before.snapshot, startDate: new Date("2026-09-01T00:00:00+05:00"), endDate: new Date("2026-10-01T00:00:00+05:00"), amountMinor: before.finalAmountMinor });
    const renewal = await (await import("./services/pricingEngine.ts")).quoteRenewal(db, company.id, "CRM_START", "MONTHLY", new Date("2027-01-01T00:00:00+05:00"));
    assert.equal(renewal.finalAmountMinor, 14990);
  });

  it("keeps all CRM and documents available while Free blocks only campaigns", async () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      assert.deepEqual(matchPaidFeatures(method, "/api/v1/campaigns"), []);
    }
    const company = await tenant();
    await activateSubscription(db, { tenantId: company.id, planCode: "BASQAR_FREE" });
    const access = await getEntitlements(db, company.id);
    assert.equal(access.entitlements.DOCUMENTS, true);
    assert.equal(access.entitlements.AI_CONTROL, true);
    assert.equal(access.entitlements.MASS_MESSAGING, false);
  });

  it("retains an individual override without unlocking another product", async () => {
    const company = await tenant();
    await activateSubscription(db, { tenantId: company.id, planCode: "CRM_START" });
    await db.tenantBillingOverride.create({ data: { tenantId: company.id, limitsJson: { AI_CREDITS: 2000 }, featuresJson: {} } });
    const access = await getEntitlements(db, company.id);
    assert.equal(access.limits.AI_CREDITS, 2000);
    assert.equal(access.entitlements.MASS_MESSAGING, true);
  });
});
