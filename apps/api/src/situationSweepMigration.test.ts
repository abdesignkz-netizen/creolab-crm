import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { SITUATION_SWEEP_SQL } from "../../../packages/db/src/situationSweepSchema.ts";

describe("Situation notification migration", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, ruleId: string;
  before(async () => {
    db = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    const member = await db.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } });
    const integration = await db.integration.create({ data: { tenantId: member.tenantId, type: "whatsapp_qr", name: "Migration fixture" } });
    ruleId = (await db.controlNotificationRule.create({ data: { tenantId: member.tenantId, membershipId: member.id, integrationId: integration.id, phone: "+77020000002" } })).id;
  });
  after(async () => { await db.$disconnect(); });
  it("retires only the old unsent attention queue once and preserves delivery history", async () => {
    const rows = [];
    for (const state of [null, "queued", "accepted", "uncertain", "sending"]) {
      const batch = state ? await db.controlNotificationBatch.create({ data: { ruleId, version: 1, key: randomUUID(), kind: "instant", state } }) : null;
      rows.push(await db.controlNotificationItem.create({ data: { ruleId, version: 1, eventKey: randomUUID(), category: "dialogs", mode: "instant", batchId: batch?.id } }));
    }
    // Recreate the pre-upgrade shape in this isolated test database.
    await db.$executeRawUnsafe('ALTER TABLE "ControlNotificationItem" DROP COLUMN "episodeId"');
    for (const sql of SITUATION_SWEEP_SQL) await db.$executeRawUnsafe(sql);
    for (let i = 0; i < rows.length; i++) {
      const current = await db.controlNotificationItem.findUniqueOrThrow({ where: { id: rows[i].id } });
      assert.equal(current.suppressionReason, i < 2 ? "legacy_unverified" : null);
    }
    const fresh = await db.controlNotificationItem.create({ data: { ruleId, version: 1, eventKey: randomUUID(), category: "tasks", mode: "instant" } });
    for (const sql of SITUATION_SWEEP_SQL) await db.$executeRawUnsafe(sql);
    assert.equal((await db.controlNotificationItem.findUniqueOrThrow({ where: { id: fresh.id } })).suppressionReason, null);
    assert.equal(await db.controlNotificationBatch.count({ where: { ruleId, state: { in: ["accepted", "uncertain", "sending"] } } }), 3);
  });
});
