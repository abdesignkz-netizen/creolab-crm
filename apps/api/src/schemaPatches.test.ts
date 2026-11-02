import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { applyRequiredSchemaPatches } from "../../../packages/db/src/schemaPatches.ts";
import { applyLivePostgresPatches } from "../../../packages/db/src/client.ts";
import { applyBillingMigration } from "../../../packages/db/src/billingMigration.ts";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "@prisma/client";

describe("required startup schema patches", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  before(async () => { db = await createPrismaClient(); });
  after(async () => { await db.$disconnect(); });
  const create = 'CREATE TABLE IF NOT EXISTS "SchemaPatchTest" (id INTEGER PRIMARY KEY)';

  it("upgrades the shipped baseline without relying on PGlite-only initialization", async () => {
    const pg = new PGlite();
    const fresh = new PrismaClient({ adapter: new PrismaPGlite(pg) } as never);
    try {
      await pg.exec(await readFile(new URL("../../../packages/db/prisma/init.sql", import.meta.url), "utf8"));
      await applyLivePostgresPatches(fresh);
      await applyBillingMigration(fresh);
      await applyLivePostgresPatches(fresh);
      await applyBillingMigration(fresh);
      assert.equal(await fresh.company.count(), 0);
      assert.equal(await fresh.agreement.count(), 0);
      assert.equal(await fresh.situationEpisode.count(), 0);
      assert.equal(await fresh.actionRun.count(), 0);
      assert.equal(await fresh.actionStep.count(), 0);
      assert.equal(await fresh.architectDraft.count(), 0);
      assert.equal(await fresh.businessInsight.count(), 0);
      assert.equal(await fresh.businessInsightEvent.count(), 0);
      assert.equal(await fresh.businessInsightScan.count(), 0);
      assert.equal(await fresh.businessGoal.count(), 0);
      assert.equal(await fresh.goalMeasurement.count(), 0);
      assert.equal(await fresh.businessDecision.count(), 0);
      assert.equal(await fresh.businessDecisionEvent.count(), 0);
      assert.equal(await fresh.businessExperiment.count(), 0);
      assert.equal(await fresh.experimentMeasurement.count(), 0);
      assert.equal(await fresh.businessExperimentEvent.count(), 0);
      assert.equal(await fresh.autopilotPolicy.count(), 0);
      assert.equal(await fresh.autopilotCase.count(), 0);
      assert.equal(await fresh.autopilotEvent.count(), 0);
      assert.equal(await fresh.billingOrder.count(), 0);
      const tenant = await fresh.tenant.create({ data: { name: "Retained", slug: "retained" } });
      await fresh.company.create({ data: { tenantId: tenant.id, name: "Preserved company" } });
      const insight = await fresh.businessInsight.create({ data: { tenantId: tenant.id, rule: "task_overdue", entityKind: "task", entityId: "retained-task", formulaVersion: "attention_task_v1", fingerprint: "retained", contentJson: { subject: "Retained" }, generatedAt: new Date(), checkedAt: new Date(), validUntil: new Date() } });
      await fresh.businessInsightEvent.create({ data: { tenantId: tenant.id, insightId: insight.id, type: "detected", version: 1 } });
      await fresh.$executeRawUnsafe('ALTER TABLE "BusinessInsight" DROP COLUMN "actionRunId", DROP COLUMN "outcomeEventId"');
      const architect = await fresh.architectDraft.create({ data: { tenantId: tenant.id, savedByUserId: "retained-user", requestId: "retained-request", requestHash: "retained-hash", baseRevision: "revision", answersJson: { source: "retained" }, previewJson: { canApply: false }, expiresAt: new Date() } });
      // Reproduce the persisted A2 shape before applying the additive A3 patch.
      await fresh.$executeRawUnsafe('ALTER TABLE "ArchitectDraft" DROP COLUMN "applicationRunId", DROP COLUMN "appliedRevision", DROP COLUMN "appliedAt"');
      const plan = await fresh.actionRun.create({ data: { tenantId: tenant.id, userId: "historical-user", initiatorMembershipId: "historical-member",
        requestId: "historical-request", requestHash: "hash", title: "Retained plan", snapshotJson: { version: 1 }, expiresAt: new Date(),
        steps: { create: { position: 0, key: "retained", kind: "task.create", label: "Retained", detail: "Retained", inputJson: {}, snapshotJson: {} } } } });
      await applyLivePostgresPatches(fresh);
      assert.equal(await fresh.company.count(), 1);
      const goal = await fresh.businessGoal.create({ data: { tenantId: tenant.id, title: "Retained goal", metric: "overdue_tasks", ownerMembershipId: "historical-owner", periodStart: new Date(), periodEnd: new Date(), timezone: "Asia/Almaty", target: 0 } });
      const measurement = await fresh.goalMeasurement.create({ data: { tenantId: tenant.id, goalId: goal.id, version: 1, measuredAt: new Date(), asOf: new Date(), fingerprint: "unchanged", resultJson: { value: 2 } } });
      const decision = await fresh.businessDecision.create({ data: { tenantId: tenant.id, kind: "decision", topic: "SLA", topicKey: "sla", title: "Preserved decision", body: "Retained", rationale: "Retained reason", sourceKind: "manual", authorUserId: "historical-owner", validFrom: new Date(), validUntil: new Date(), retentionUntil: new Date() } });
      await fresh.businessDecisionEvent.create({ data: { tenantId: tenant.id, decisionId: decision.id, type: "created", version: 1, userId: "historical-owner", requestId: "same-request", requestHash: "same-content" } });
      await applyLivePostgresPatches(fresh);
      assert.equal((await fresh.businessDecision.findUniqueOrThrow({ where: { id: decision.id } })).body, "Retained");
      assert.equal(await fresh.businessDecisionEvent.count({ where: { decisionId: decision.id } }), 1);
      const rule = await fresh.routingRule.create({ data: { tenantId: tenant.id, kind: "autopilot_first_reply", cursor: 3 } });
      const policy = await fresh.autopilotPolicy.create({ data: { tenantId: tenant.id, routingRuleId: rule.id, configJson: { mode: "suggest" }, calendarHash: "retained" } });
      await applyLivePostgresPatches(fresh);
      assert.equal((await fresh.routingRule.findUniqueOrThrow({ where: { id: rule.id } })).cursor, 3);
      assert.equal((await fresh.autopilotPolicy.findUniqueOrThrow({ where: { id: policy.id } })).state, "paused");
      const foreign = await fresh.tenant.create({ data: { name: "Other", slug: "other-autopilot" } });
      const experiment = await fresh.businessExperiment.create({ data: { tenantId: tenant.id, title: "Retained experiment", hypothesis: "Hypothesis", change: "Initiative", methodVersion: "v1", methodJson: { members: ["retained"] }, timezone: "Asia/Almaty", periodStart: new Date(), periodEnd: new Date(), authorUserId: "historical-user" } });
      const sample = await fresh.experimentMeasurement.create({ data: { tenantId: tenant.id, experimentId: experiment.id, revision: 1, fingerprint: "retained", measuredAt: new Date(), resultJson: { status: "insufficient_data" } } });
      await fresh.businessExperimentEvent.create({ data: { tenantId: tenant.id, experimentId: experiment.id, type: "created", version: 1, userId: "historical-user", requestId: "same-request", requestHash: "same-content" } });
      await applyLivePostgresPatches(fresh);
      assert.equal((await fresh.businessExperiment.findUniqueOrThrow({ where: { id: experiment.id } })).hypothesis, "Hypothesis");
      assert.deepEqual((await fresh.experimentMeasurement.findUniqueOrThrow({ where: { id: sample.id } })).resultJson, { status: "insufficient_data" });
      assert.equal(await fresh.businessExperimentEvent.count({ where: { experimentId: experiment.id } }), 1);
      await assert.rejects(fresh.experimentMeasurement.create({ data: { tenantId: foreign.id, experimentId: experiment.id, revision: 2, fingerprint: "foreign", measuredAt: new Date(), resultJson: {} } }), "experiment measurement cannot cross tenant boundary");
      await assert.rejects(fresh.businessExperimentEvent.create({ data: { tenantId: foreign.id, experimentId: experiment.id, type: "stop", version: 2, userId: "historical-user", requestId: "foreign", requestHash: "same-content" } }), "experiment history cannot cross tenant boundary");
      await assert.rejects(fresh.businessExperimentEvent.create({ data: { tenantId: tenant.id, experimentId: experiment.id, type: "stop", version: 2, userId: "historical-user", requestId: "same-request", requestHash: "other-content" } }), "experiment requests remain unique");
      await assert.rejects(fresh.autopilotPolicy.create({ data: { tenantId: foreign.id, routingRuleId: rule.id, configJson: {}, calendarHash: "wrong" } }), "routing policy cannot cross tenant boundary");
      await assert.rejects(fresh.businessDecisionEvent.create({ data: { tenantId: "wrong-company", decisionId: decision.id, type: "approved", version: 2 } }), "decision history cannot cross company boundaries");
      await assert.rejects(fresh.businessDecisionEvent.create({ data: { tenantId: tenant.id, decisionId: decision.id, type: "approved", version: 2, userId: "historical-owner", requestId: "same-request", requestHash: "changed-content" } }), "decision request is unique per company and actor");
      assert.equal((await fresh.businessGoal.findUniqueOrThrow({ where: { id: goal.id } })).title, "Retained goal");
      assert.deepEqual((await fresh.goalMeasurement.findUniqueOrThrow({ where: { id: measurement.id } })).resultJson, { value: 2 });
      await assert.rejects(fresh.goalMeasurement.create({ data: { tenantId: "wrong-company", goalId: goal.id, version: 1, measuredAt: new Date(), asOf: new Date(), fingerprint: "wrong", resultJson: {} } }), "goal measurements cannot cross company boundaries");
      assert.deepEqual((await fresh.businessInsight.findUniqueOrThrow({ where: { id: insight.id } })).contentJson, { subject: "Retained" });
      assert.equal((await fresh.businessInsight.findUniqueOrThrow({ where: { id: insight.id } })).actionRunId, null);
      assert.equal((await fresh.businessInsight.findUniqueOrThrow({ where: { id: insight.id } })).outcomeEventId, null);
      assert.equal(await fresh.businessInsightEvent.count({ where: { insightId: insight.id } }), 1);
      await assert.rejects(fresh.businessInsight.create({ data: { tenantId: tenant.id, rule: "task_overdue", entityKind: "task", entityId: "retained-task", occurrence: 2, formulaVersion: "v1", fingerprint: "other", contentJson: {}, generatedAt: new Date(), checkedAt: new Date(), validUntil: new Date() } }), "only one current occurrence per company/rule/entity");
      await assert.rejects(fresh.businessInsightEvent.create({ data: { tenantId: "other-company", insightId: insight.id, type: "dismissed", version: 1 } }), "insight history cannot cross tenant boundaries");
      assert.equal((await fresh.architectDraft.findUniqueOrThrow({ where: { id: architect.id } })).revision, 1);
      assert.deepEqual((await fresh.architectDraft.findUniqueOrThrow({ where: { id: architect.id } })).answersJson, { source: "retained" });
      const migratedProject = await fresh.architectDraft.findUniqueOrThrow({ where: { id: architect.id } });
      assert.equal(migratedProject.applicationRunId, null); assert.equal(migratedProject.appliedRevision, null); assert.equal(migratedProject.appliedAt, null);
      assert.equal((await fresh.actionRun.findUniqueOrThrow({ where: { id: plan.id }, include: { steps: true } })).steps.length, 1);
      await assert.rejects(fresh.actionStep.create({ data: { tenantId: "other-company", runId: plan.id, position: 1, key: "wrong-tenant",
        kind: "task.create", label: "Invalid", detail: "Invalid", inputJson: {}, snapshotJson: {} } }), "steps cannot reference another tenant's run");
    } finally { await fresh.$disconnect(); await pg.close(); }
  });

  it("accepts the full live patch manifest on the existing isolated schema, including repeat startup", async () => {
    await applyLivePostgresPatches(db);
    await applyLivePostgresPatches(db);
    await db.tenant.count();
  });

  it("outbox upgrade retains old pending jobs and backfills retry budget only once", async () => {
    const pg = new PGlite();
    const fresh = new PrismaClient({ adapter: new PrismaPGlite(pg) } as never);
    try {
      await pg.exec(await readFile(new URL("../../../packages/db/prisma/init.sql", import.meta.url), "utf8"));
      await pg.exec(`INSERT INTO "Tenant" (id, name, slug, "updatedAt") VALUES ('a0-upgrade', 'Preserved', 'a0-upgrade', NOW());
        INSERT INTO "OutboxEvent" (id, "tenantId", type, "entityType", "entityId", "payloadJson", attempts) VALUES ('a0-pending', 'a0-upgrade', 'sales.reconcile', 'deal', 'retained', '{}', 12);`);
      await applyLivePostgresPatches(fresh);
      const retained = await fresh.outboxEvent.findUniqueOrThrow({ where: { id: "a0-pending" } });
      assert.equal(retained.processedAt, null); assert.equal(retained.failedAt, null);
      assert.equal(retained.attempts, 12); assert.equal(retained.retryAttempts, 12);
      await fresh.outboxEvent.update({ where: { id: retained.id }, data: { retryAttempts: 0 } });
      await applyLivePostgresPatches(fresh);
      assert.equal((await fresh.outboxEvent.findUniqueOrThrow({ where: { id: retained.id } })).retryAttempts, 0);
    } finally { await fresh.$disconnect(); await pg.close(); }
  });

  it("rolls back prior DDL and data and rejects readiness if a later patch fails", async () => {
    await assert.rejects(applyRequiredSchemaPatches(db, [
      { name: "fixture", statements: [create, 'INSERT INTO "SchemaPatchTest" (id) VALUES (1)'] },
      { name: "failure", statements: ['SELECT missing_secret_record_value FROM "SchemaPatchTest"'] },
    ]), error => {
      assert.match(String(error), /Required schema patch failed: failure\[1\].*initialization aborted/);
      assert.doesNotMatch(String(error), /missing_secret_record_value|SELECT|INSERT/);
      return true;
    });
    const rows = await db.$queryRaw<Array<{ table_name: string | null }>>`SELECT to_regclass('public."SchemaPatchTest"')::text AS table_name`;
    assert.equal(rows[0].table_name, null);
  });

  it("can retry successfully after failure and reapply additive patches safely", async () => {
    const groups = [{ name: "fixture", statements: [create, 'ALTER TABLE "SchemaPatchTest" ADD COLUMN IF NOT EXISTS label TEXT'] }];
    await applyRequiredSchemaPatches(db, groups);
    await applyRequiredSchemaPatches(db, groups);
    await db.$executeRaw`INSERT INTO "SchemaPatchTest" (id, label) VALUES (1, 'kept')`;
    await assert.rejects(applyRequiredSchemaPatches(db, [
      { name: "mutate", statements: ['UPDATE "SchemaPatchTest" SET label = \'overwritten\'', 'SELECT invalid_column FROM "SchemaPatchTest"'] },
    ]));
    const rows = await db.$queryRaw<Array<{ label: string }>>`SELECT label FROM "SchemaPatchTest" WHERE id = 1`;
    assert.equal(rows[0].label, "kept");
  });
});
