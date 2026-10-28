import { createPrismaClient } from "../packages/db/src/client.ts";
import { assertTestDatabase } from "../apps/api/src/testSupport/testDatabase.ts";
import { claimOutboxEvent } from "../apps/api/src/services/outboxLease.ts";

assertTestDatabase();
const [mode, id] = process.argv.slice(2);
if (!process.send || !["startup", "claim"].includes(mode)) throw new Error("Run through the PostgreSQL acceptance test");
const go = new Promise<void>(resolve => process.once("message", message => {
  if (message === "run") resolve();
}));
let db = mode === "claim" ? await createPrismaClient() : undefined;
process.send({ ready: true });
await go;
try {
  db ||= await createPrismaClient();
  if (mode === "claim") {
    const lease = await claimOutboxEvent(db, id);
    if (lease) {
      await db.$executeRaw`INSERT INTO "AcceptanceEffect" ("eventId") VALUES (${id})`;
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
