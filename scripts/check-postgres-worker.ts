import { createPrismaClient } from "../packages/db/src/client.ts";
import { assertTestDatabase } from "../apps/api/src/testSupport/testDatabase.ts";
import { claimOutboxEvent } from "../apps/api/src/services/outboxLease.ts";
import { processActionRun, processActionStep } from "../apps/api/src/services/aiActionService.ts";

assertTestDatabase();
const [mode, id] = process.argv.slice(2);
if (!process.send || !["startup", "claim", "action", "action-crash"].includes(mode)) throw new Error("Run through the PostgreSQL acceptance test");
const go = new Promise<void>(resolve => process.once("message", message => {
  if (message === "run") resolve();
}));
let db = mode !== "startup" ? await createPrismaClient() : undefined;
process.send({ ready: true });
await go;
try {
  db ||= await createPrismaClient();
  if (mode !== "startup") {
    const lease = await claimOutboxEvent(db, id);
    if (lease) {
      if (mode === "action-crash") {
        await processActionStep(db, lease.event.tenantId, lease.event.entityId);
        process.send({ claimed: true, firstStepCommitted: true });
        // The test kills this process after a committed step, before finishing
        // the outbox lease. IPC keeps it alive without any external side effect.
        await new Promise<void>(() => {});
      } else if (mode === "action") await processActionRun(db, lease.event.tenantId, lease.event.entityId);
      else await db.$executeRaw`INSERT INTO "AcceptanceEffect" ("eventId") VALUES (${id})`;
      await lease.finish({ processedAt: new Date(), attempts: { increment: 1 } });
    }
    process.send({ claimed: Boolean(lease) });
  } else {
    await db.tenant.count();
  }
} finally {
  await db?.$disconnect();
  process.disconnect();
}
