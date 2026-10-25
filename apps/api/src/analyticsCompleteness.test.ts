import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { getAnalyticsDashboard, getAnalyticsDrilldown } from "./services/analyticsService.ts";
import { AnalyticsCoverage } from "./services/analyticsCoverage.ts";

describe("complete analytics totals with bounded details", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  let auth: AuthContext;
  let tid: string;
  const query = { period: "custom", dateFrom: "2026-10-24", dateTo: "2026-10-24", compare: "none" };
  const date = new Date("2026-10-24T10:00:00Z");
  const inquiryIds = Array.from({ length: 5001 }, () => randomUUID());
  before(async () => {
    db = await createPrismaClient();
    const tenant = await db.tenant.create({ data: { slug: randomUUID(), name: "Analytics completeness", timezone: "Asia/Almaty" } });
    tid = tenant.id;
    const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    const membership = await db.membership.create({ data: { tenantId: tid, userId: user.id, role: "owner" }, include: { tenant: true } });
    auth = { user, activeMembership: membership, memberships: [membership] } as unknown as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tid, name: "Test", firstSeenAt: date } });
    const stage = await db.dealStage.create({ data: { tenantId: tid, name: "Новая", systemKey: "new", sortOrder: 1 } });
    for (let start = 0; start < inquiryIds.length; start += 500) {
      await db.inquiry.createMany({ data: inquiryIds.slice(start, start + 500).map((id, offset) => ({
        id, tenantId: tid, contactId: contact.id, source: "manual", sourceType: start + offset < 2 ? "selected-source" : "bulk",
        serviceCategory: "design", sourceChannel: null, utmCampaign: "campaign", city: "Алматы", assigneeMembershipId: membership.id, receivedAt: date,
      })) });
    }
    for (const [outcome, count] of [["open", 3001], ["won", 5001], ["lost", 2]] as const) {
      for (let start = 0; start < count; start += 500) {
        await db.deal.createMany({ data: Array.from({ length: Math.min(500, count - start) }, (_, offset) => {
          const i = start + offset;
          return { tenantId: tid, contactId: contact.id, stageId: stage.id, title: `${outcome}-${i}`, outcome,
            inquiryId: i === 0 && outcome !== "lost" ? inquiryIds[outcome === "open" ? 0 : 1] : null,
            assigneeMembershipId: membership.id, probability: 50, offerAmountMinor: outcome === "won" && i === 5000 ? 9999 : 100,
            wonAmountMinor: outcome === "won" && i < 5000 ? 10 : null, createdAt: date, updatedAt: date,
            stageEnteredAt: date, closedAt: outcome === "open" ? null : date };
        }) });
      }
    }
    // Exclusion rules must apply to aggregates too, not only the detailed rows.
    for (const excluded of [{ test: true }, { archived: true }]) {
      const inquiry = await db.inquiry.create({ data: { tenantId: tid, contactId: contact.id, source: "manual", receivedAt: date, ...excluded } });
      await db.deal.create({ data: { tenantId: tid, contactId: contact.id, stageId: stage.id, inquiryId: inquiry.id,
        title: "Excluded", outcome: "won", offerAmountMinor: 999999999, createdAt: date, closedAt: date } });
    }
    const older = await db.deal.create({ data: { tenantId: tid, contactId: contact.id, stageId: stage.id, title: "Other period",
      outcome: "won", offerAmountMinor: 999999999, createdAt: new Date("2025-01-01"), closedAt: new Date("2025-01-01") } });
    assert.ok(older.id);
    const other = await db.tenant.create({ data: { slug: randomUUID(), name: "Another company" } });
    const otherContact = await db.contact.create({ data: { tenantId: other.id, name: "Other company contact" } });
    await db.inquiry.create({ data: { tenantId: other.id, contactId: otherContact.id, source: "manual", receivedAt: date } });
  });
  after(async () => { await db.$disconnect(); });

  it("counts more than 5000 inquiries/sales and all 3001 open deals without clipping totals", async () => {
    const data = await getAnalyticsDashboard(db, auth, query);
    assert.equal(data.overview.inquiries, 5001);
    assert.equal(data.overview.dealsCreated, 8004);
    assert.equal(data.overview.won, 5001);
    assert.equal(data.overview.lost, 2);
    assert.equal(data.overview.revenue, 59999);
    assert.equal(data.overview.avgCheck, 12);
    assert.equal(data.sales.maxCheck, 9999);
    assert.equal(data.sales.pipeline, 300100);
    assert.equal(data.sales.weightedPipeline, 150050);
    assert.equal(data.losses.lostAmount, 200);
    assert.equal(data.coverage.totalsComplete, true);
    assert.equal(data.coverage.partial, true);
    assert.ok(data.coverage.sections.some(s => s.key === "current:inquiries" && s.loaded === 5000 && s.atLeast === 5001));
    assert.ok(data.coverage.sections.some(s => s.key.endsWith(":open") && s.loaded === 3000 && s.atLeast === 3001));
    assert.ok(!data.coverage.sections.some(s => s.status === "unavailable"));
  });

  it("keeps counts and amounts consistent with source, service, city, campaign and owner filters", async () => {
    const data = await getAnalyticsDashboard(db, auth, { ...query, source: "selected-source", serviceCategory: "design",
      city: "Алматы", campaign: "campaign", assignee: auth.activeMembership!.id });
    assert.equal(data.overview.inquiries, 2);
    assert.equal(data.overview.dealsCreated, 2);
    assert.equal(data.overview.won, 1);
    assert.equal(data.overview.revenue, 10);
    assert.equal(data.sales.pipeline, 100);
    assert.equal(data.sales.weightedPipeline, 50);
    assert.equal(data.coverage.partial, false);
    const empty = await getAnalyticsDashboard(db, auth, { ...query, source: "not-present" });
    assert.equal(empty.overview.inquiries, 0);
    assert.equal(empty.overview.won, 0);
    assert.equal(empty.overview.revenue, null);
    assert.equal(empty.sales.pipeline, null);
  });

  it("exposes the full drilldown count and applies source filtering before the 500-row limit", async () => {
    const all = await getAnalyticsDrilldown(db, auth, { ...query, entity: "won" });
    assert.equal(all.total, 5001); assert.equal(all.items.length, 500); assert.equal(all.hasMore, true);
    const inquiries = await getAnalyticsDrilldown(db, auth, { ...query, entity: "source_inquiries", key: "selected-source" });
    assert.equal(inquiries.total, 2); assert.equal(inquiries.items.length, 2); assert.equal(inquiries.hasMore, false);
    const sales = await getAnalyticsDrilldown(db, auth, { ...query, entity: "source_won", key: "selected-source" });
    assert.equal(sales.total, 1); assert.equal(sales.items[0].amount, 10);
  });

  it("does not grant company analytics to an ordinary manager", async () => {
    const manager = { ...auth, activeMembership: { ...auth.activeMembership!, role: "manager" } } as AuthContext;
    await assert.rejects(getAnalyticsDashboard(db, manager, query), /доступ|прав|руководител/i);
  });
});

it("marks incomplete and unavailable details without claiming an exact total", async () => {
  const coverage = new AnalyticsCoverage();
  assert.deepEqual(await coverage.read("complete", "Complete", 2, async () => [1, 2]), [1, 2]);
  assert.equal(coverage.result().partial, false);
  assert.deepEqual(await coverage.read("partial", "Partial", 2, async take => Array.from({ length: take }, (_, i) => i)), [0, 1]);
  coverage.unavailable("failed", "Failed");
  assert.deepEqual(coverage.result().sections, [
    { key: "failed", label: "Failed", loaded: 0, atLeast: null, status: "unavailable" },
    { key: "partial", label: "Partial", loaded: 2, atLeast: 3, status: "partial" },
  ]);
});
